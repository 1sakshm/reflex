/**
 * Offline learning: rebuild a policy from traces, fit calibration and
 * risk thresholds on held-out data, and evaluate before promotion.
 */
import type { Candidate } from "./actions.ts";
import { DEFAULT_FLOORS, DEFAULT_THRESHOLDS } from "./config.ts";
import { featurize, type Features } from "./encoder.ts";
import {
  applyTemperature,
  DecisionCache,
  expectedCalibrationError,
  fitTemperature,
  topOf,
  type CalibrationSample,
  type Dist,
} from "./learners.ts";
import { PolicyRuntime, type PolicyMetrics } from "./policy.ts";
import type { DecisionEvent, TraceEvent } from "./trace.ts";
import type { ActionKind, Risk } from "./types.ts";

export interface Example {
  id: string;
  ts: string;
  point: string;
  features: Features;
  candidates: Candidate[];
  cacheKey: string;
  kind: "label" | "reinforce" | "negative";
  /** Label or chosen key. Undefined label = the reference chose something outside the action space. */
  key: string | undefined;
  reasoning: boolean;
}

export interface LearnOptions {
  /** Fraction of the newest examples held out for calibration/thresholds/evaluation. */
  validationFraction?: number;
  /** Required precision of auto decisions per risk class when picking thresholds. */
  targetPrecision?: number;
  minMargin?: number;
  minExamples?: number;
  minPatternSupport?: number;
  minCacheSupport?: number;
  minFamiliarity?: number;
  floors?: Partial<Record<Risk, number>>;
  allowStateful?: boolean;
}

interface Settings {
  minMargin: number;
  minExamples: number;
  minPatternSupport: number;
  minCacheSupport: number;
  minFamiliarity: number;
  allowStateful: boolean;
  floors: Record<Risk, number>;
  targetPrecision: number;
  validationFraction: number;
}

function settings(options: LearnOptions): Settings {
  return {
    minMargin: options.minMargin ?? 0.1,
    minExamples: options.minExamples ?? 20,
    minPatternSupport: options.minPatternSupport ?? 3,
    minCacheSupport: options.minCacheSupport ?? 3,
    minFamiliarity: options.minFamiliarity ?? 0.5,
    allowStateful: options.allowStateful ?? false,
    floors: { ...DEFAULT_FLOORS, ...options.floors },
    targetPrecision: options.targetPrecision ?? 0.95,
    validationFraction: options.validationFraction ?? 0.2,
  };
}

function candidatesFrom(event: DecisionEvent): Candidate[] {
  return event.candidates.map((candidate) => {
    const spec: Candidate["spec"] = { id: candidate.id, kind: candidate.kind as ActionKind, risk: candidate.risk };
    if (candidate.reasoning) spec.reasoning = true;
    if (candidate.params !== undefined) spec.params = candidate.params;
    return { key: candidate.key, spec };
  });
}

/** Join decisions with choices, step outcomes and task outcomes into training examples. */
export function buildExamples(events: readonly TraceEvent[]): Example[] {
  const choices = new Map<string, { action: string; takenBy: string }>();
  const failedSteps = new Set<string>();
  const tasks = new Map<string, boolean>();
  for (const event of events) {
    if (event.ev === "choice") choices.set(event.decisionId, { action: event.action, takenBy: event.takenBy });
    else if (event.ev === "outcome" && event.status !== "ok") failedSteps.add(event.decisionId);
    else if (event.ev === "task") tasks.set(event.taskId, event.success);
  }
  const examples: Example[] = [];
  for (const event of events) {
    if (event.ev !== "decision" || !event.state) continue;
    const candidates = candidatesFrom(event);
    if (candidates.length === 0) continue;
    const features = featurize(event.state);
    if (event.stateDigest) features.stateDigest = event.stateDigest;
    const base = {
      id: event.id,
      ts: event.ts,
      point: event.point,
      features,
      candidates,
      cacheKey: DecisionCache.keyFor(event.point, features, candidates),
    };
    const choice = choices.get(event.id);
    if (choice && choice.takenBy !== "reflex") {
      const key = choice.action.startsWith("other:") ? undefined : choice.action;
      const label = candidates.find((candidate) => candidate.key === key);
      examples.push({ ...base, kind: "label", key: label ? key : undefined, reasoning: label ? label.spec.reasoning === true : true });
      continue;
    }
    if (event.outcome === "auto" && event.chosen) {
      const taskSuccess = event.taskId ? tasks.get(event.taskId) : undefined;
      const chosen = candidates.find((candidate) => candidate.key === event.chosen);
      const reasoning = chosen?.spec.reasoning === true;
      if (failedSteps.has(event.id) || taskSuccess === false) {
        examples.push({ ...base, kind: "negative", key: event.chosen, reasoning });
      } else if (taskSuccess === true) {
        examples.push({ ...base, kind: "reinforce", key: event.chosen, reasoning });
      }
    }
  }
  return examples.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function replay(policy: PolicyRuntime, examples: readonly Example[]): void {
  for (const example of examples) {
    if (example.kind === "label") {
      policy.learnLabel(example.point, example.features, example.candidates, example.key, example.reasoning, example.cacheKey);
    } else if (example.key) {
      policy.learnOutcome(example.point, example.features, example.candidates, example.key, example.kind === "reinforce", example.cacheKey);
    }
  }
}

type Tier = "cache" | "pattern" | "head";

function tierDists(policy: PolicyRuntime, example: Example, s: Settings): { tier: Tier; dist: Dist }[] {
  const out: { tier: Tier; dist: Dist }[] = [];
  const cache = policy.cache.lookup(example.cacheKey, example.candidates);
  if (cache && cache.support >= s.minCacheSupport) out.push({ tier: "cache", dist: cache.dist });
  const pattern = policy.patterns.lookup(example.point, example.features.signature, example.candidates);
  if (pattern && pattern.support >= s.minPatternSupport) out.push({ tier: "pattern", dist: pattern.dist });
  if (
    policy.labeledCount(example.point) >= s.minExamples &&
    policy.familiarity.score(example.point, example.features) >= s.minFamiliarity
  ) {
    out.push({ tier: "head", dist: policy.head.predict(example.point, example.features, example.candidates) });
  }
  return out;
}

interface Simulated {
  /** "auto": Reflex would execute; "reasoning": Reflex would confidently escalate; "none": escalate as unsure. */
  outcome: "auto" | "reasoning" | "none";
  key?: string;
  tier?: Tier;
  confidence: number;
}

function thresholdFor(risk: Risk, thresholds: Partial<Record<Risk, number>>, s: Settings): number | "never" {
  if (risk === "destructive") return "never";
  if (risk === "stateful" && !s.allowStateful) return "never";
  const learned = thresholds[risk];
  if (learned !== undefined) return Math.max(learned, s.floors[risk]);
  return DEFAULT_THRESHOLDS[risk];
}

function simulate(policy: PolicyRuntime, example: Example, thresholds: Partial<Record<Risk, number>>, s: Settings): Simulated {
  let best: Simulated = { outcome: "none", confidence: 0 };
  for (const { tier, dist } of tierDists(policy, example, s)) {
    if (tier === "head" && example.candidates.length < 2) continue;
    const top = topOf(tier === "cache" ? dist : applyTemperature(dist, policy.temperature(tier, example.point)));
    if (!top) continue;
    if (top.p > best.confidence) best = { outcome: "none", key: top.key, tier, confidence: top.p };
    const candidate = example.candidates.find((item) => item.key === top.key);
    if (!candidate) continue;
    const threshold = thresholdFor(candidate.spec.risk, thresholds, s);
    const bar = threshold === "never" ? thresholdFor("safe", thresholds, s) : threshold;
    if (typeof bar !== "number" || top.p < bar || top.margin < s.minMargin) continue;
    if (candidate.spec.reasoning) return { outcome: "reasoning", key: top.key, tier, confidence: top.p };
    if (threshold === "never") return { outcome: "none", key: top.key, tier, confidence: top.p };
    return { outcome: "auto", key: top.key, tier, confidence: top.p };
  }
  return best;
}

export interface EvalReport extends PolicyMetrics {
  labeled: number;
  /** Number of auto decisions the policy would make on this data. */
  autos: number;
  /** 95% Wilson lower bound on auto precision. */
  precisionLower: number;
  earlyEscalations: number;
  byRisk: Record<string, { auto: number; correct: number }>;
  estimatedSavingsUsd: number;
}

/** Evaluate a policy on labeled examples (uses each example's reference label as ground truth). */
export function evaluatePolicy(
  policy: PolicyRuntime,
  examples: readonly Example[],
  options: LearnOptions & { frontierCostUsd?: number } = {},
): EvalReport {
  const s = settings(options);
  const labeled = examples.filter((example) => example.kind === "label");
  const byTier: Record<string, { auto: number; correct: number }> = {};
  const byRisk: Record<string, { auto: number; correct: number }> = {};
  const pairs: { confidence: number; correct: boolean }[] = [];
  let auto = 0;
  let correct = 0;
  let early = 0;
  for (const example of labeled) {
    const result = simulate(policy, example, policy.thresholds, s);
    if (result.key !== undefined) pairs.push({ confidence: result.confidence, correct: result.key === example.key });
    if (result.outcome === "reasoning") early++;
    if (result.outcome !== "auto" || !result.tier) continue;
    auto++;
    const ok = result.key === example.key;
    if (ok) correct++;
    const tier = (byTier[result.tier] ??= { auto: 0, correct: 0 });
    tier.auto++;
    if (ok) tier.correct++;
    const risk = example.candidates.find((candidate) => candidate.key === result.key)?.spec.risk ?? "safe";
    const bucket = (byRisk[risk] ??= { auto: 0, correct: 0 });
    bucket.auto++;
    if (ok) bucket.correct++;
  }
  return {
    examples: examples.length,
    labeled: labeled.length,
    autos: auto,
    precisionLower: wilsonLower(correct, auto),
    validation: labeled.length,
    coverage: labeled.length ? auto / labeled.length : 0,
    precision: auto ? correct / auto : 0,
    ece: expectedCalibrationError(pairs),
    byTier,
    byRisk,
    earlyEscalations: early,
    estimatedSavingsUsd: correct * (options.frontierCostUsd ?? 0.03),
  };
}

/** 95% Wilson score lower bound for a binomial proportion. */
export function wilsonLower(successes: number, trials: number, z = 1.96): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return Math.max(0, (centre - margin) / denom);
}

export interface TrainResult {
  policy: PolicyRuntime;
  /** Metrics on the held-out validation slice, measured before the final refit on all data. */
  report: EvalReport;
  validation: Example[];
}

/** Build a new candidate policy from traces. */
export function trainPolicy(workload: string, examples: readonly Example[], options: LearnOptions = {}): TrainResult {
  const s = settings(options);
  const labeledIdx = examples.map((example, i) => (example.kind === "label" ? i : -1)).filter((i) => i >= 0);
  const holdout = Math.floor(labeledIdx.length * s.validationFraction);
  const splitAt = holdout > 0 ? (labeledIdx[labeledIdx.length - holdout] as number) : examples.length;
  const train = examples.slice(0, splitAt);
  const validation = examples.slice(splitAt).filter((example) => example.kind === "label");
  // Calibration and thresholds are fitted on the older half of the held-out data and the
  // reported metrics come from the newer half, so the report is not tuned on itself.
  const half = validation.length >= 20 ? Math.floor(validation.length / 2) : 0;
  const fitSet = half ? validation.slice(0, half) : validation;
  const reportSet = half ? validation.slice(half) : validation;

  // 1) Fit on the older data.
  const draft = PolicyRuntime.empty(workload, "draft");
  replay(draft, train);

  // 2) Calibrate each tier on the held-out data.
  const samples = new Map<string, CalibrationSample[]>();
  for (const example of fitSet) {
    if (example.key === undefined) continue;
    for (const { tier, dist } of tierDists(draft, example, s)) {
      if (tier === "cache") continue; // cache scores are evidence counts, not calibrated logits
      for (const scope of [`${tier}:${example.point}`, `${tier}:*`]) {
        const list = samples.get(scope) ?? [];
        list.push({ dist, label: example.key });
        samples.set(scope, list);
      }
    }
  }
  const calibration: Record<string, number> = {};
  for (const [scope, list] of samples) {
    // Stored even when 1: its presence marks the tier as calibrated on held-out data.
    if (list.length >= 10) calibration[scope] = fitTemperature(list);
  }
  draft.calibration = calibration;

  // 3) Pick the lowest threshold per risk class that meets the precision target.
  const thresholds: Partial<Record<Risk, number>> = {};
  for (const risk of ["safe", "cheap", "costly", "stateful"] as const) {
    const floor = s.floors[risk];
    let chosen: number | undefined;
    let measured = false;
    for (let t = Math.ceil(floor * 100) / 100; t <= 0.995; t += 0.01) {
      let auto = 0;
      let ok = 0;
      for (const example of fitSet) {
        const result = simulate(draft, example, { ...thresholds, [risk]: t }, s);
        if (result.outcome !== "auto") continue;
        const resultRisk = example.candidates.find((candidate) => candidate.key === result.key)?.spec.risk;
        if (resultRisk !== risk) continue;
        auto++;
        if (result.key === example.key) ok++;
      }
      if (auto >= 5) measured = true;
      if (auto >= 5 && ok / auto >= s.targetPrecision) {
        chosen = Math.round(t * 100) / 100;
        break;
      }
    }
    // Measured but no threshold met the target: stay at the strictest value rather than
    // falling back to the (more permissive) default.
    if (chosen !== undefined) thresholds[risk] = chosen;
    else if (measured) thresholds[risk] = 0.999;
  }
  draft.thresholds = thresholds;
  const report = evaluatePolicy(draft, reportSet, options);

  // 4) Refit on everything, keeping calibration and thresholds from the held-out fit.
  const policy = PolicyRuntime.empty(workload, "candidate");
  replay(policy, examples);
  policy.calibration = calibration;
  policy.thresholds = thresholds;
  policy.metrics = {
    examples: examples.length,
    validation: validation.length,
    coverage: report.coverage,
    precision: report.precision,
    ece: report.ece,
    byTier: report.byTier,
  };
  return { policy, report, validation: reportSet };
}

export interface PromotionCheck {
  ok: boolean;
  reason: string;
}

/** Gate: a candidate may not lose more than `tolerance` precision vs the current policy on the same data. */
export function checkPromotion(
  candidate: EvalReport,
  current: EvalReport | undefined,
  options: { tolerance?: number; minPrecision?: number; minPrecisionLower?: number } = {},
): PromotionCheck {
  const tolerance = options.tolerance ?? 0.015;
  const minPrecision = options.minPrecision ?? 0.9;
  const minLower = options.minPrecisionLower ?? 0.8;
  if (candidate.labeled === 0) return { ok: false, reason: "no labeled validation data" };
  if (candidate.autos > 0 && candidate.precision < minPrecision) {
    return { ok: false, reason: `precision ${(candidate.precision * 100).toFixed(1)}% below minimum ${(minPrecision * 100).toFixed(0)}%` };
  }
  if (candidate.autos >= 20 && candidate.precisionLower < minLower) {
    return {
      ok: false,
      reason: `precision lower bound ${(candidate.precisionLower * 100).toFixed(1)}% (n=${candidate.autos}) below ${(minLower * 100).toFixed(0)}%`,
    };
  }
  if (current && current.coverage > 0 && candidate.precision < current.precision - tolerance) {
    return {
      ok: false,
      reason: `precision regressed ${(current.precision * 100).toFixed(1)}% → ${(candidate.precision * 100).toFixed(1)}%`,
    };
  }
  if (candidate.autos > 0 && candidate.autos < 20) {
    return { ok: true, reason: `passed (only ${candidate.autos} auto decisions in validation; precision is a rough estimate)` };
  }
  return { ok: true, reason: "passed promotion gate" };
}
