import { normalizeCandidates, refKey, resolveRef, type Candidate } from "./actions.ts";
import { resolveBackend, type BackendRequest, type DecisionBackend } from "./backend.ts";
import { DEFAULT_THRESHOLDS, resolveConfig, type PointConfig, type ReflexConfig, type ResolvedConfig } from "./config.ts";
import { encodeState, featurize, renderState, type Features } from "./encoder.ts";
import { applyTemperature, DecisionCache, topOf, type Dist } from "./learners.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { PolicyRuntime } from "./policy.ts";
import { Redactor } from "./redact.ts";
import { PolicyRegistry } from "./registry.ts";
import { applyRules } from "./rules.ts";
import { checkBudget, isLoop, TaskTracker, type TaskSnapshot } from "./tasks.ts";
import { JsonlSink, NullSink, type DecisionEvent, type TraceSink } from "./trace.ts";
import type {
  ActionRef,
  ActionSpec,
  AutoDecision,
  Decision,
  DecideRequest,
  DecisionState,
  EscalateDecision,
  EscalationReason,
  Hint,
  Mode,
  Risk,
  Source,
  StepOutcome,
  TakenBy,
  TaskOutcome,
} from "./types.ts";
import { digest, LRU, newId, now, stableStringify } from "./util.ts";

/** What Reflex remembers about a decision so labels and outcomes can be learned from later. */
interface Pending {
  point: string;
  features: Features;
  candidates: Candidate[];
  cacheKey: string;
  taskId?: string;
  /** Key Reflex actually auto-executed (auto mode only). */
  autoKey?: string;
  /** Key Reflex would choose (top candidate), in any mode. */
  wouldKey?: string;
  wouldAuto: boolean;
  stepFailed?: boolean;
  outcomeSeen?: boolean;
}

type GateResult =
  | { kind: "auto"; candidate: Candidate; p: number; margin: number }
  | { kind: "reasoning"; candidate: Candidate; p: number }
  | { kind: "risk"; candidate: Candidate; p: number }
  | { kind: "none" };

const DEFAULT_QUESTION = "Which action should the agent take next?";

/**
 * The Reflex runtime. One instance per workload.
 *
 *   const reflex = createReflex({ workload: "coding-agent", mode: "shadow" });
 *   const d = await reflex.decide({ point: "next_action", state, actions });
 *   if (d.type === "auto") execute(d.action) else callFrontier(d.hints);
 */
export class Reflex {
  readonly workload: string;
  readonly config: ResolvedConfig;
  readonly metrics: Metrics;
  readonly registry: PolicyRegistry;
  private policy: PolicyRuntime;
  private readonly backend: DecisionBackend | undefined;
  private readonly sink: TraceSink;
  private readonly redactor: Redactor;
  private readonly tasks = new TaskTracker();
  private readonly pending = new LRU<string, Pending>(20_000);
  private readonly auditCounters = new LRU<string, number>(10_000);

  constructor(config: ReflexConfig) {
    this.config = resolveConfig(config);
    this.workload = this.config.workload;
    this.redactor = new Redactor(this.config.privacy);
    this.metrics = new Metrics(this.workload, this.config.frontier);
    this.registry = new PolicyRegistry(this.config.dataDir, this.workload);
    this.policy = this.loadPolicy();
    this.backend = this.config.tiers.backend ? resolveBackend(this.config.backend) : undefined;
    this.sink =
      this.config.sink ??
      (this.config.storage.traces
        ? new JsonlSink(this.config.dataDir, this.workload, { retentionDays: this.config.storage.retentionDays })
        : new NullSink());
  }

  private loadPolicy(): PolicyRuntime {
    if (this.config.learning.loadPolicy) {
      try {
        const loaded = this.registry.loadCurrent();
        if (loaded) return loaded;
      } catch {
        // A broken policy file must never take the agent down: start from the base policy.
      }
    }
    return PolicyRuntime.empty(this.workload);
  }

  get policyVersion(): string {
    return this.policy.version;
  }

  /** Swap in the currently promoted policy (e.g. after `reflex promote`). */
  reloadPolicy(): string {
    this.policy = this.loadPolicy();
    return this.policy.version;
  }

  /** Save the live (online-updated) policy as a new candidate version. Does not promote it. */
  savePolicy(note?: string): string {
    // registry.save stamps version/parent on the object; keep the live policy's identity intact.
    const { version, parent } = this.policy;
    try {
      return this.registry.save(this.policy, note);
    } finally {
      this.policy.version = version;
      this.policy.parent = parent;
    }
  }

  getPolicy(): PolicyRuntime {
    return this.policy;
  }

  // ------------------------------------------------------------------ decide

  async decide(request: DecideRequest): Promise<Decision> {
    const start = now();
    const id = newId();
    try {
      return await this.decideInner(request, id, start);
    } catch (error) {
      if (this.config.strict) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const decision = this.escalation(id, request?.point ?? "unknown", start, "internal_error", message, []);
      this.metrics.recordDecision(decision);
      return decision;
    }
  }

  /** Several decisions at once; full-model calls are micro-batched into one backend pass. */
  decideMany(requests: DecideRequest[]): Promise<Decision[]> {
    return Promise.all(requests.map((request) => this.decide(request)));
  }

  /**
   * Warm per-state work (redaction, tokenization) while a tool is still running,
   * so the next `decide()` only pays for the new observation.
   */
  prepare(state: DecisionState): void {
    try {
      featurize(encodeState(state, this.redactor));
    } catch {
      // best effort
    }
  }

  private effectiveMode(request: DecideRequest, pointConfig: PointConfig): Mode {
    if (this.config.disabled) return "off";
    if (this.config.envMode) return this.config.envMode;
    return request.mode ?? pointConfig.mode ?? this.config.mode;
  }

  private threshold(risk: Risk, pointConfig: PointConfig): number | "never" {
    if (risk === "destructive") return "never";
    if (risk === "stateful" && !this.config.allowStateful) return "never";
    const explicit = pointConfig.thresholds?.[risk] ?? this.config.thresholds[risk];
    if (explicit !== undefined) return explicit;
    const learned = this.policy.thresholds[risk];
    if (learned !== undefined) return Math.max(learned, this.config.floors[risk]);
    return DEFAULT_THRESHOLDS[risk];
  }

  private gate(dist: Dist, source: Source, point: string, candidates: Candidate[], pointConfig: PointConfig): {
    result: GateResult;
    hints: Hint[];
  } {
    // Cache scores are evidence ratios, not a normalized distribution: never temperature-scale them.
    const calibrated = source === "cache" ? dist : applyTemperature(dist, this.policy.temperature(source, point));
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const hints = [...calibrated.entries()]
      .filter(([key]) => byKey.has(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, confidence]) => ({ key, action: (byKey.get(key) as Candidate).spec, confidence }));
    const top = topOf(new Map([...calibrated].filter(([key]) => byKey.has(key))));
    const candidate = top ? byKey.get(top.key) : undefined;
    if (!top || !candidate) return { result: { kind: "none" }, hints };
    // With a single candidate a softmax is trivially 1.0: that is not evidence. Only evidence-counting
    // tiers (cache, patterns) may decide a lone candidate.
    if (byKey.size < 2 && (source === "head" || source === "model")) return { result: { kind: "none" }, hints };
    const threshold = this.threshold(candidate.spec.risk, pointConfig);
    let bar = threshold === "never" ? this.threshold("safe", pointConfig) : threshold;
    if (typeof bar === "number" && source === "head" && !this.policy.isCalibrated("head", point)) {
      // Small-sample shrinkage: an uncalibrated online head must clear a higher bar
      // until it has seen many examples (bar → 1 as k/(k+n) → 1).
      const k = this.config.learning.minExamples;
      const n = this.policy.labeledCount(point);
      bar = bar + (1 - bar) * (k / (k + n));
    }
    const confident = typeof bar === "number" && top.p >= bar && top.margin >= this.config.minMargin;
    if (candidate.spec.reasoning) {
      return { result: confident ? { kind: "reasoning", candidate, p: top.p } : { kind: "none" }, hints };
    }
    if (threshold === "never") {
      return { result: confident ? { kind: "risk", candidate, p: top.p } : { kind: "none" }, hints };
    }
    return {
      result: confident ? { kind: "auto", candidate, p: top.p, margin: top.margin } : { kind: "none" },
      hints,
    };
  }

  private async decideInner(request: DecideRequest, id: string, start: number): Promise<Decision> {
    const point = request.point;
    const pointConfig = this.config.points[point] ?? {};
    const mode = this.effectiveMode(request, pointConfig);
    if (mode === "off") {
      const decision = this.escalation(id, point, start, "mode", "Reflex is off", []);
      this.metrics.recordDecision(decision);
      return decision;
    }

    if (request.signal?.aborted) {
      const decision = this.escalation(id, point, start, "timeout", "request was already aborted", []);
      this.metrics.recordDecision(decision);
      return decision;
    }
    const { candidates: all, invalid } = normalizeCandidates(request.actions ?? []);
    const encoded = encodeState(request.state ?? {}, this.redactor);
    const features = featurize(encoded);
    // The cache must be exact: key it on the full (redacted) state, not the truncated encoding.
    features.stateDigest = digest(stableStringify(this.redactor.value(request.state ?? {})));
    const cacheKey = DecisionCache.keyFor(point, features, all);
    let task: TaskSnapshot | undefined;
    if (request.taskId) {
      this.tasks.onDecide(request.taskId);
      task = this.tasks.snapshot(request.taskId);
    }
    const pending: Pending = { point, features, candidates: all, cacheKey, wouldAuto: false };
    if (request.taskId) pending.taskId = request.taskId;
    const trace = { applied: [] as string[], difficulty: undefined as number | undefined, hedged: false };
    const finish = (decision: Decision, source: Source) =>
      this.finish(decision, pending, request, mode, source, trace.applied);
    const escalate = (reason: EscalationReason, detail: string, hints: Hint[], source: Source = "fallback") =>
      finish(this.escalation(id, point, start, reason, detail, hints, trace.hedged, trace.difficulty), source);

    if (all.length === 0) {
      return escalate("no_candidates", invalid.length ? `invalid params: ${invalid.join(", ")}` : "no actions supplied", []);
    }

    // Tier 1: deterministic rules.
    const ruleContext = task
      ? { point, workload: this.workload, state: request.state, task }
      : { point, workload: this.workload, state: request.state };
    const rules = applyRules(this.config.rules, ruleContext, all);
    trace.applied = rules.applied;
    const candidates = rules.candidates;
    if (rules.escalate) return escalate("rule", rules.escalate.reason, [], "rule");
    if (candidates.length === 0) return escalate("rule", "every candidate was denied by rules", [], "rule");
    // Budgets apply to everything, including rule-forced actions.
    if (task) {
      const exhausted = checkBudget(task, this.config.budgets);
      if (exhausted) return escalate("budget", exhausted, []);
    }

    if (rules.forced) {
      const forced = rules.forced.candidate;
      const ruleHint = [{ key: forced.key, action: forced.spec, confidence: 1 }];
      const ruleId = rules.forced.ruleId;
      if (forced.spec.risk === "destructive" && !this.config.allowDestructive) {
        return escalate("risk", `rule ${ruleId} forced a destructive action; allowDestructive is off`, ruleHint, "rule");
      }
      if (forced.spec.risk === "stateful" && !this.config.allowStateful) {
        return escalate("risk", `rule ${ruleId} forced a stateful action; allowStateful is off`, ruleHint, "rule");
      }
      if (forced.spec.reasoning) {
        return escalate("difficulty", `rule ${ruleId} routes this step to System 2`, ruleHint, "rule");
      }
      if (task && isLoop(task, forced.key, this.config.budgets.loopWindow ?? 3)) {
        return escalate("loop", `rule ${ruleId} forced ${forced.spec.id} repeatedly`, ruleHint, "rule");
      }
      const maxRetries = this.config.budgets.maxRetriesPerAction;
      if (task && forced.spec.kind === "retry" && maxRetries !== undefined && (task.retries[forced.key] ?? 0) >= maxRetries) {
        return escalate("budget", `retry budget exhausted for ${forced.spec.id}`, ruleHint, "rule");
      }
      return finish(this.auto(id, point, start, forced, 1, 1, "rule", `forced by rule ${ruleId}`), "rule");
    }

    let hints: Hint[] = [];
    let ood = false;
    const settle = (gated: { result: GateResult; hints: Hint[] }, source: Source): Decision | undefined => {
      if (gated.hints.length) hints = gated.hints;
      const result = gated.result;
      if (result.kind === "none") return undefined;
      if (result.kind === "reasoning") {
        return escalate("difficulty", `${source} tier: ${result.candidate.spec.id} needs reasoning (p=${result.p.toFixed(2)})`, hints, source);
      }
      if (result.kind === "risk") {
        return escalate("risk", `${source} tier prefers ${result.candidate.spec.id} (${result.candidate.spec.risk}); never auto-executed`, hints, source);
      }
      const { candidate } = result;
      if (task && isLoop(task, candidate.key, this.config.budgets.loopWindow ?? 3)) {
        return escalate("loop", `${candidate.spec.id} chosen ${this.config.budgets.loopWindow ?? 3}× in a row`, hints, source);
      }
      const maxRetries = this.config.budgets.maxRetriesPerAction;
      if (task && candidate.spec.kind === "retry" && maxRetries !== undefined && (task.retries[candidate.key] ?? 0) >= maxRetries) {
        return escalate("budget", `retry budget exhausted for ${candidate.spec.id}`, hints, source);
      }
      if (mode === "auto" && this.shouldAudit(point)) {
        return escalate("audit", `audit sample: would auto-execute ${candidate.spec.id} (${source}, p=${result.p.toFixed(2)}); label it to measure live precision`, hints, source);
      }
      const decision = this.auto(id, point, start, candidate, result.p, result.margin, source, `${source} tier, p=${result.p.toFixed(2)}`, hints);
      decision.hedged = trace.hedged;
      if (trace.difficulty !== undefined) decision.difficulty = trace.difficulty;
      return finish(decision, source);
    };

    // Tier 2: exact decision cache.
    if (this.config.tiers.cache) {
      const hit = this.policy.cache.lookup(cacheKey, candidates);
      if (hit && hit.support >= this.config.learning.minCacheSupport) {
        const decided = settle(this.gate(hit.dist, "cache", point, candidates, pointConfig), "cache");
        if (decided) return decided;
      }
    }

    // Tier 3: trajectory pattern table.
    if (this.config.tiers.patterns) {
      const hit = this.policy.patterns.lookup(point, features.signature, candidates);
      if (hit && hit.support >= this.config.learning.minPatternSupport) {
        const decided = settle(this.gate(hit.dist, "pattern", point, candidates, pointConfig), "pattern");
        if (decided) return decided;
      }
    }

    // Tier 4: hashed head + difficulty head, guarded by familiarity (OOD).
    const trained = this.policy.labeledCount(point) >= this.config.learning.minExamples;
    if (trained) {
      ood = this.policy.familiarity.score(point, features) < this.config.learning.minFamiliarity;
      if (this.policy.difficulty.examples >= this.config.learning.minExamples) {
        trace.difficulty = this.policy.difficulty.predict(point, features);
      }
      if (this.config.tiers.head && !ood) {
        const decided = settle(
          this.gate(this.policy.head.predict(point, features, candidates), "head", point, candidates, pointConfig),
          "head",
        );
        if (decided) return decided;
      }
      if (!ood && trace.difficulty !== undefined && trace.difficulty >= this.config.speed.earlyEscalate) {
        return escalate("difficulty", `difficulty ${trace.difficulty.toFixed(2)} ≥ ${this.config.speed.earlyEscalate}; skipped full model`, hints, "head");
      }
    }

    // Tier 6: full decision model (Laya or another backend), with hedging and a hard deadline.
    if (this.backend) {
      if (request.onHedge && (trace.difficulty ?? 0) >= this.config.speed.hedgeEscalation) {
        trace.hedged = true;
        try {
          request.onHedge({ decisionId: id, point, difficulty: trace.difficulty ?? 0 });
        } catch {
          // caller bug; ignore
        }
      }
      const remaining = (request.timeoutMs ?? this.config.timeoutMs) - (now() - start);
      if (remaining <= 0) return escalate("timeout", "no time left for the full model", hints);
      const backendRequest: BackendRequest = {
        point,
        question: pointConfig.question ?? DEFAULT_QUESTION,
        state: renderState(encoded),
        candidates: candidates.map((candidate) => {
          const out: BackendRequest["candidates"][number] = { key: candidate.key, id: candidate.spec.id, kind: candidate.spec.kind };
          const description = candidate.spec.description ?? (candidate.spec.params !== undefined ? JSON.stringify(candidate.spec.params) : undefined);
          if (description) out.description = description;
          return out;
        }),
      };
      const scored = await this.scoreWithDeadline(backendRequest, remaining, request.signal);
      if (scored === "timeout") return escalate("timeout", `full model exceeded ${Math.round(remaining)} ms`, hints);
      if (scored instanceof Error) {
        return escalate("low_confidence", `full model unavailable (${scored.message}); local tiers not confident`, hints);
      }
      const dist: Dist = new Map();
      let sum = 0;
      for (const candidate of candidates) sum += Math.max(0, scored.probs[candidate.key] ?? 0);
      for (const candidate of candidates) dist.set(candidate.key, sum > 0 ? Math.max(0, scored.probs[candidate.key] ?? 0) / sum : 1 / candidates.length);
      const decided = settle(this.gate(dist, "model", point, candidates, pointConfig), "model");
      if (decided) return decided;
      return escalate("low_confidence", "no tier was confident enough", hints, "model");
    }

    if (ood) return escalate("ood", "state is unfamiliar to the learned tiers", hints);
    return escalate("low_confidence", trained ? "no tier was confident enough" : `still learning (${this.policy.labeledCount(point)}/${this.config.learning.minExamples} labeled examples)`, hints);
  }

  /** Deterministic audit sampling: every Nth confident decision per point goes to System 2. */
  private shouldAudit(point: string): boolean {
    const rate = this.config.learning.auditRate;
    if (!(rate > 0)) return false;
    const every = Math.max(2, Math.round(1 / rate));
    const count = (this.auditCounters.get(point) ?? 0) + 1;
    this.auditCounters.set(point, count);
    return count % every === 0;
  }

  private async scoreWithDeadline(
    request: BackendRequest,
    ms: number,
    outer?: AbortSignal,
  ): Promise<{ probs: Record<string, number> } | "timeout" | Error> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, ms);
    });
    try {
      return await Promise.race([
        (this.backend as DecisionBackend).score(request, controller.signal).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        ),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  private auto(
    id: string,
    point: string,
    start: number,
    candidate: Candidate,
    confidence: number,
    margin: number,
    source: Source,
    reason: string,
    hints: Hint[] = [{ key: candidate.key, action: candidate.spec, confidence }],
  ): AutoDecision {
    const decision: AutoDecision = {
      type: "auto",
      id,
      point,
      action: candidate.spec,
      key: candidate.key,
      confidence,
      margin,
      source,
      reason,
      hints,
      latencyMs: now() - start,
      policyVersion: this.policy.version,
      hedged: false,
    };
    if (candidate.spec.params !== undefined) decision.params = candidate.spec.params;
    return decision;
  }

  private escalation(
    id: string,
    point: string,
    start: number,
    reason: EscalationReason,
    detail: string,
    hints: Hint[],
    hedged = false,
    difficulty?: number,
  ): EscalateDecision {
    const decision: EscalateDecision = {
      type: "escalate",
      id,
      point,
      reason,
      detail,
      hints,
      latencyMs: now() - start,
      policyVersion: this.policy.version,
      hedged,
    };
    if (difficulty !== undefined) decision.difficulty = difficulty;
    return decision;
  }

  /** Apply the mode, remember the decision for learning, record metrics and the trace. */
  private finish(
    decision: Decision,
    pending: Pending,
    request: DecideRequest,
    mode: Mode,
    source: Source,
    rulesApplied: string[],
  ): Decision {
    let final: Decision = decision;
    const top = decision.type === "auto" ? { key: decision.key, confidence: decision.confidence } : decision.hints[0];
    if (top) pending.wouldKey = top.key;
    pending.wouldAuto = decision.type === "auto" || (decision.type === "escalate" && decision.reason === "audit");
    if (mode === "shadow" || mode === "assist") {
      const shadowed: EscalateDecision = {
        type: "escalate",
        id: decision.id,
        point: decision.point,
        reason: "mode",
        detail:
          decision.type === "auto"
            ? `${mode}: would auto-execute ${decision.action.id} (${decision.reason})`
            : `${mode}: would escalate (${decision.reason}: ${decision.detail})`,
        hints: decision.hints,
        latencyMs: decision.latencyMs,
        policyVersion: decision.policyVersion,
        hedged: decision.hedged,
      };
      if (decision.difficulty !== undefined) shadowed.difficulty = decision.difficulty;
      if (top) {
        const candidate = pending.candidates.find((item) => item.key === top.key);
        shadowed.shadow = {
          key: top.key,
          action: candidate?.spec.id ?? top.key,
          confidence: top.confidence,
          source,
          wouldAuto: decision.type === "auto",
        };
      }
      final = shadowed;
    }
    if (final.type === "auto") {
      pending.autoKey = final.key;
      if (pending.taskId) this.tasks.onChosen(pending.taskId, final.key, final.action.kind, final.id);
    }
    this.pending.set(final.id, pending);
    this.metrics.recordDecision(final);

    const event: DecisionEvent = {
      ev: "decision",
      id: final.id,
      ts: new Date().toISOString(),
      workload: this.workload,
      point: final.point,
      policyVersion: final.policyVersion,
      mode,
      stateDigest: pending.features.stateDigest,
      candidates: pending.candidates.map((candidate) => {
        const out: DecisionEvent["candidates"][number] = {
          key: candidate.key,
          id: candidate.spec.id,
          kind: candidate.spec.kind,
          risk: candidate.spec.risk,
        };
        if (candidate.spec.reasoning) out.reasoning = true;
        if (candidate.spec.params !== undefined) out.params = this.redactor.value(candidate.spec.params);
        const hint = decision.hints.find((item) => item.key === candidate.key);
        if (hint) out.prob = Math.round(hint.confidence * 1e4) / 1e4;
        return out;
      }),
      rulesApplied,
      source,
      outcome: final.type,
      latencyMs: Math.round(final.latencyMs * 1000) / 1000,
    };
    if (this.config.storage.stateEncoding === "redacted") event.state = pending.features.encoded;
    if (request.taskId) event.taskId = request.taskId;
    if (request.stepId) event.stepId = request.stepId;
    if (final.type === "auto") {
      event.chosen = final.key;
      event.confidence = final.confidence;
      event.margin = final.margin;
    } else {
      event.reason = final.reason;
      event.detail = final.detail;
    }
    if (top) {
      event.wouldChoose = top.key;
      event.wouldAuto = decision.type === "auto";
    }
    if (decision.difficulty !== undefined) event.difficulty = decision.difficulty;
    if (decision.hedged) event.hedged = true;
    if (this.backend) event.backend = this.backend.name;
    this.sink.write(event);
    return final;
  }

  // ------------------------------------------------------------------ feedback

  /**
   * Report which action was actually taken after an escalation (or in shadow mode).
   * This is Reflex's main learning signal: the frontier model's choices become labels.
   */
  observeChoice(decisionId: string, action: ActionRef, takenBy: TakenBy = "frontier"): boolean {
    const pending = this.pending.get(decisionId);
    const ts = new Date().toISOString();
    if (!pending) {
      this.sink.write({ ev: "choice", ts, workload: this.workload, decisionId, action: refKey(action), takenBy });
      return false;
    }
    const keys = pending.candidates.map((candidate) => ({ key: candidate.key, id: candidate.spec.id, alias: candidate.alias }));
    const labelKey = resolveRef(action, keys);
    const label = labelKey ? pending.candidates.find((candidate) => candidate.key === labelKey) : undefined;
    this.sink.write({
      ev: "choice",
      ts,
      workload: this.workload,
      decisionId,
      action: labelKey ?? "other:" + refKey(action),
      takenBy,
    });
    if (pending.wouldKey !== undefined && !pending.autoKey) {
      this.metrics.recordShadowLabel(pending.wouldKey === labelKey, pending.wouldAuto);
    }
    if (this.config.learning.online && takenBy !== "reflex") {
      this.policy.learnLabel(pending.point, pending.features, pending.candidates, labelKey, label?.spec.reasoning === true, pending.cacheKey);
    }
    if (pending.taskId && label && !pending.autoKey) {
      this.tasks.onChosen(pending.taskId, label.key, label.spec.kind);
    }
    return true;
  }

  /** Report the result of executing a decided action. */
  outcome(outcome: StepOutcome): void {
    const pending = this.pending.get(outcome.decisionId);
    const event: Parameters<TraceSink["write"]>[0] = {
      ev: "outcome",
      ts: new Date().toISOString(),
      workload: this.workload,
      ...outcome,
    };
    this.sink.write(event);
    if (!pending) return;
    if (pending.taskId && outcome.costUsd) {
      this.tasks.onCost(pending.taskId, outcome.costUsd, outcome.takenBy === "frontier");
    } else if (pending.taskId && outcome.takenBy === "frontier") {
      this.tasks.onCost(pending.taskId, 0, true);
    }
    if (pending.outcomeSeen) return; // repeated reports must not penalize twice
    pending.outcomeSeen = true;
    if (outcome.status !== "ok" && pending.autoKey) {
      pending.stepFailed = true;
      if (this.config.learning.online) {
        this.policy.learnOutcome(pending.point, pending.features, pending.candidates, pending.autoKey, false, pending.cacheKey);
      }
    }
  }

  /** Report whether the whole task succeeded. Reinforces or penalizes Reflex's own choices in it. */
  taskOutcome(outcome: TaskOutcome): void {
    this.sink.write({ ev: "task", ts: new Date().toISOString(), workload: this.workload, ...outcome });
    this.metrics.recordTask(outcome.success);
    const ids = this.tasks.autoDecisions(outcome.taskId);
    if (this.config.learning.online) {
      // Credit assignment: on success reinforce every auto decision; on failure blame the
      // ones whose step failed plus the last two (most likely to have caused the failure).
      const blamed = new Set(ids.slice(-2));
      for (const decisionId of ids) {
        const pending = this.pending.peek(decisionId);
        if (!pending?.autoKey || pending.stepFailed) continue;
        if (outcome.success) {
          this.policy.learnOutcome(pending.point, pending.features, pending.candidates, pending.autoKey, true, pending.cacheKey);
        } else if (blamed.has(decisionId)) {
          this.policy.learnOutcome(pending.point, pending.features, pending.candidates, pending.autoKey, false, pending.cacheKey);
        }
      }
    }
    this.tasks.end(outcome.taskId);
  }

  // ------------------------------------------------------------------ speed helpers

  /**
   * Speculatively start the most likely action if (and only if) it is `safe` and read-only.
   * Use the returned promise if the final choice matches `key`; otherwise ignore it.
   */
  speculate<T>(decision: Decision, execute: (action: ActionSpec) => Promise<T>): { key: string; result: Promise<T> } | undefined {
    if (!this.config.speed.speculativeSafeActions) return undefined;
    const target = decision.type === "auto" ? { key: decision.key, action: decision.action } : decision.hints[0];
    if (!target || target.action.risk !== "safe" || !target.action.readOnly) return undefined;
    const result = execute(target.action);
    result.catch(() => {});
    return { key: target.key, result };
  }

  /** Short hint text for the frontier prompt. Append it after the stable prompt prefix. */
  formatHints(decision: Decision): string {
    if (decision.hints.length === 0) return "";
    const options = decision.hints.map((hint) => `${hint.action.id} (${Math.round(hint.confidence * 100)}%)`).join(", ");
    return `[reflex] likely next actions: ${options}.`;
  }

  stats(): MetricsSnapshot {
    return this.metrics.snapshot(this.sink.dropped);
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }

  async close(): Promise<void> {
    await this.sink.close();
    await this.backend?.close?.();
  }
}

export function createReflex(config: ReflexConfig): Reflex {
  return new Reflex(config);
}
