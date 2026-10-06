import { createReflex, NullSink, type ReflexConfig } from "@reflex-ai/core";
import { rng, SUITES, type Suite } from "./suites.ts";

export interface FrontierModel {
  /** $ per frontier call at step 0. */
  baseUsd: number;
  /** Extra $ per call for each step already in the transcript (context growth). */
  perStepUsd: number;
  latencyMs: number;
}

export const DEFAULT_FRONTIER: FrontierModel = { baseUsd: 0.02, perStepUsd: 0.0015, latencyMs: 2500 };

export interface BenchOptions {
  suite: string | Suite;
  tasks: number;
  seed?: number;
  policy: "frontier" | "reflex";
  reflex?: Partial<ReflexConfig>;
  frontier?: FrontierModel;
  /** Number of buckets in the learning curve. */
  buckets?: number;
}

export interface CurvePoint {
  fromTask: number;
  toTask: number;
  successRate: number;
  usdPerSuccess: number;
  frontierCallsPerTask: number;
  autoRate: number;
}

export interface BenchResult {
  suite: string;
  policy: "frontier" | "reflex";
  tasks: number;
  seed: number;
  successes: number;
  successRate: number;
  totalUsd: number;
  usdPerSuccess: number;
  frontierCalls: number;
  frontierCallsPerTask: number;
  steps: number;
  wallClockMsPerTask: number;
  decisions: number;
  autoDecisions: number;
  autoRate: number;
  autoPrecision: number;
  reflexLatencyMs: { p50: number; p95: number; total: number };
  curve: CurvePoint[];
}

interface TaskStats {
  success: boolean;
  usd: number;
  frontierCalls: number;
  decisions: number;
  autos: number;
  wallMs: number;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
}

/** Run one policy over `tasks` seeded tasks of a suite. */
export async function runBench(options: BenchOptions): Promise<BenchResult> {
  const suite = typeof options.suite === "string" ? SUITES[options.suite] : options.suite;
  if (!suite) throw new Error(`Unknown suite ${String(options.suite)}. Available: ${Object.keys(SUITES).join(", ")}`);
  const seed = options.seed ?? 42;
  const frontier = options.frontier ?? DEFAULT_FRONTIER;
  const reflex =
    options.policy === "reflex"
      ? createReflex({
          workload: `bench/${suite.name}`,
          mode: "auto",
          sink: new NullSink(),
          ...options.reflex,
          learning: { loadPolicy: false, ...options.reflex?.learning },
        })
      : undefined;

  const perTask: TaskStats[] = [];
  const reflexLatencies: number[] = [];
  let autoCorrect = 0;
  let steps = 0;

  for (let t = 0; t < options.tasks; t++) {
    const random = rng(seed * 100_003 + t);
    const env = suite.create(random, t);
    const stats: TaskStats = { success: false, usd: 0, frontierCalls: 0, decisions: 0, autos: 0, wallMs: 0 };
    const taskId = `task-${t}`;
    let step = 0;
    while (!env.done && step < suite.maxSteps) {
      const current = env.current();
      let key: string;
      let decisionId: string | undefined;
      let auto = false;
      if (reflex) {
        const decision = await reflex.decide({ point: current.point, state: current.state, actions: current.actions, taskId });
        reflexLatencies.push(decision.latencyMs);
        stats.wallMs += decision.latencyMs;
        stats.decisions++;
        decisionId = decision.id;
        if (decision.type === "auto") {
          auto = true;
          stats.autos++;
          key = decision.key;
          if (key === current.oracle) autoCorrect++;
        } else {
          key = current.oracle;
          reflex.observeChoice(decision.id, key, "frontier");
        }
      } else {
        key = current.oracle;
      }
      if (!auto) {
        stats.frontierCalls++;
        stats.usd += frontier.baseUsd + frontier.perStepUsd * step;
        stats.wallMs += frontier.latencyMs;
      }
      const result = env.step(key);
      stats.usd += result.costUsd;
      stats.wallMs += result.latencyMs;
      if (reflex && decisionId) {
        reflex.outcome({ decisionId, status: result.status, costUsd: result.costUsd, takenBy: auto ? "reflex" : "frontier" });
      }
      step++;
      steps++;
    }
    stats.success = env.success;
    reflex?.taskOutcome({ taskId, success: env.success, costUsd: stats.usd, frontierCalls: stats.frontierCalls });
    perTask.push(stats);
  }
  await reflex?.close();

  const summarize = (slice: TaskStats[]) => {
    const successes = slice.filter((task) => task.success).length;
    const usd = slice.reduce((sum, task) => sum + task.usd, 0);
    const decisions = slice.reduce((sum, task) => sum + task.decisions, 0);
    const autos = slice.reduce((sum, task) => sum + task.autos, 0);
    return {
      successes,
      usd,
      successRate: slice.length ? successes / slice.length : 0,
      usdPerSuccess: successes ? usd / successes : Infinity,
      frontierCallsPerTask: slice.length ? slice.reduce((sum, task) => sum + task.frontierCalls, 0) / slice.length : 0,
      autoRate: decisions ? autos / decisions : 0,
    };
  };

  const bucketCount = Math.max(1, Math.min(options.buckets ?? 8, options.tasks));
  const size = Math.ceil(options.tasks / bucketCount);
  const curve: CurvePoint[] = [];
  for (let from = 0; from < options.tasks; from += size) {
    const slice = perTask.slice(from, from + size);
    const s = summarize(slice);
    curve.push({
      fromTask: from,
      toTask: from + slice.length - 1,
      successRate: s.successRate,
      usdPerSuccess: s.usdPerSuccess,
      frontierCallsPerTask: s.frontierCallsPerTask,
      autoRate: s.autoRate,
    });
  }

  const all = summarize(perTask);
  const decisions = perTask.reduce((sum, task) => sum + task.decisions, 0);
  const autos = perTask.reduce((sum, task) => sum + task.autos, 0);
  const frontierCalls = perTask.reduce((sum, task) => sum + task.frontierCalls, 0);
  return {
    suite: suite.name,
    policy: options.policy,
    tasks: options.tasks,
    seed,
    successes: all.successes,
    successRate: all.successRate,
    totalUsd: all.usd,
    usdPerSuccess: all.usdPerSuccess,
    frontierCalls,
    frontierCallsPerTask: all.frontierCallsPerTask,
    steps,
    wallClockMsPerTask: perTask.reduce((sum, task) => sum + task.wallMs, 0) / Math.max(1, perTask.length),
    decisions,
    autoDecisions: autos,
    autoRate: decisions ? autos / decisions : 0,
    autoPrecision: autos ? autoCorrect / autos : 0,
    reflexLatencyMs: {
      p50: percentile(reflexLatencies, 50),
      p95: percentile(reflexLatencies, 95),
      total: reflexLatencies.reduce((sum, value) => sum + value, 0),
    },
    curve,
  };
}

export interface Comparison {
  suite: string;
  baseline: BenchResult;
  reflex: BenchResult;
  delta: {
    successPp: number;
    usdPerSuccessPct: number;
    frontierCallsPct: number;
    wallClockPct: number;
  };
}

/** Run the always-frontier baseline and Reflex on the same seeded tasks. */
export async function compare(
  suite: string,
  tasks: number,
  seed = 42,
  reflex: Partial<ReflexConfig> = {},
  frontier: FrontierModel = DEFAULT_FRONTIER,
): Promise<Comparison> {
  const baseline = await runBench({ suite, tasks, seed, policy: "frontier", frontier });
  const withReflex = await runBench({ suite, tasks, seed, policy: "reflex", reflex, frontier });
  const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
  return {
    suite,
    baseline,
    reflex: withReflex,
    delta: {
      successPp: (withReflex.successRate - baseline.successRate) * 100,
      usdPerSuccessPct: pct(withReflex.usdPerSuccess, baseline.usdPerSuccess),
      frontierCallsPct: pct(withReflex.frontierCallsPerTask, baseline.frontierCallsPerTask),
      wallClockPct: pct(withReflex.wallClockMsPerTask, baseline.wallClockMsPerTask),
    },
  };
}

function fmtPct(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(1) + "%";
}

/** Human-readable report for the CLI. */
export function formatComparison(result: Comparison): string {
  const { baseline: b, reflex: r, delta: d } = result;
  const row = (label: string, base: string, refl: string, change: string) =>
    `  ${label.padEnd(26)}${base.padStart(14)}${refl.padStart(14)}${change.padStart(12)}`;
  const lines = [
    `ReflexBench · ${result.suite} · ${b.tasks} tasks · seed ${b.seed}`,
    "",
    row("", "always-frontier", "reflex", "change"),
    row("Task success", (b.successRate * 100).toFixed(1) + "%", (r.successRate * 100).toFixed(1) + "%", (d.successPp >= 0 ? "+" : "") + d.successPp.toFixed(1) + " pp"),
    row("$ / successful task", "$" + b.usdPerSuccess.toFixed(4), "$" + r.usdPerSuccess.toFixed(4), fmtPct(d.usdPerSuccessPct)),
    row("Frontier calls / task", b.frontierCallsPerTask.toFixed(2), r.frontierCallsPerTask.toFixed(2), fmtPct(d.frontierCallsPct)),
    row("Wall-clock / task", (b.wallClockMsPerTask / 1000).toFixed(1) + " s", (r.wallClockMsPerTask / 1000).toFixed(1) + " s", fmtPct(d.wallClockPct)),
    "",
    `  Reflex: ${(r.autoRate * 100).toFixed(1)}% of decisions handled locally, ${(r.autoPrecision * 100).toFixed(1)}% of those correct;`,
    `          decision latency p50 ${r.reflexLatencyMs.p50.toFixed(2)} ms, p95 ${r.reflexLatencyMs.p95.toFixed(2)} ms (measured, this machine)`,
    "",
    "  Learning curve (reflex):",
    "    tasks          success    $/success   frontier/task   auto rate",
    ...r.curve.map(
      (point) =>
        `    ${(point.fromTask + "–" + point.toTask).padEnd(14)}${((point.successRate * 100).toFixed(1) + "%").padStart(8)}` +
        `${("$" + point.usdPerSuccess.toFixed(4)).padStart(12)}${point.frontierCallsPerTask.toFixed(2).padStart(16)}${((point.autoRate * 100).toFixed(1) + "%").padStart(12)}`,
    ),
    "",
    "  Note: simulated environment with an always-correct simulated frontier model and modeled costs/latencies.",
    "  It validates Reflex's mechanics at the agent level; it is not evidence of real-world savings.",
  ];
  return lines.join("\n");
}
