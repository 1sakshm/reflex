import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  action,
  buildExamples,
  checkPromotion,
  createReflex,
  evaluatePolicy,
  NullSink,
  PolicyRegistry,
  readTraceEvents,
  resolveBackend,
  trainPolicy,
  workloadConfig,
  type DecisionEvent,
  type EvalReport,
  type Mode,
  type TraceEvent,
  VERSION,
} from "@reflex-ai/core";
import { createSidecar, listen, ReflexService, serveMcp } from "@reflex-ai/server";
import { compare, formatComparison, SUITES } from "@reflex-ai/bench";
import { resolveContext } from "./context.ts";

export type Flags = Record<string, string | boolean | undefined>;

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const num = (flags: Flags, key: string, fallback: number): number => {
  const value = str(flags, key);
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const pct = (value: number) => (value * 100).toFixed(1) + "%";

function contextFlags(flags: Flags): { workload?: string; "data-dir"?: string; config?: string } {
  const out: { workload?: string; "data-dir"?: string; config?: string } = {};
  const workload = str(flags, "workload");
  const dataDir = str(flags, "data-dir");
  const config = str(flags, "config");
  if (workload) out.workload = workload;
  if (dataDir) out["data-dir"] = dataDir;
  if (config) out.config = config;
  return out;
}

// ------------------------------------------------------------------ init

/** Node can load a .ts config only with built-in type stripping (22.18+, 23.6+). */
function supportsTsConfig(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

const CONFIG_TEMPLATE = (workload: string, ts: boolean) => `${
  ts ? 'import type { ReflexFileConfig } from "@reflex-ai/core";\n' : '/** @type {import("@reflex-ai/core").ReflexFileConfig} */\n'
}
/**
 * Reflex configuration. Start in "shadow" mode: Reflex predicts and logs but never acts.
 * Run \`npx reflex stats\` to see what it would have done, then switch to "auto".
 * (Type-only import: this file has no runtime dependencies.)
 */
export default {
  dataDir: ".reflex",
  workloads: {
    "${workload}": {
      mode: "shadow",
      // Full decision model (optional). Start the Laya sidecar with \`npx reflex laya\`.
      // backend: { type: "laya", checkpoint: "english" },
      timeoutMs: 75,
      budgets: { maxStepsPerTask: 80, maxUsdPerTask: 2, maxRetriesPerAction: 3, loopWindow: 3 },
      rules: [
        // Never let the agent run obviously destructive shell commands without a human.
        { id: "no-rm-rf", type: "deny", actions: ["bash", "shell"], when: { path: "params.command", matches: "rm\\\\s+-rf|git\\\\s+push\\\\s+--force|drop\\\\s+table", flags: "i" } },
        // Rate limited? Back off without asking the frontier model.
        { id: "rate-limit", type: "force", action: "retry_backoff", when: { path: "state.lastObservation.errorClass", in: ["RateLimit", "429"] } },
        // No progress for a while: let the frontier model think.
        { id: "stuck", type: "requireEscalation", when: { path: "state.stepsSinceProgress", gte: 5 } },
      ],
      speed: { mode: "balanced" },
      learning: { online: true, minExamples: 20 },
      storage: { traces: true, stateEncoding: "redacted", retentionDays: 30 },
      frontier: { costUsd: 0.03, latencyMs: 3000 },
    },
  },
}${ts ? " satisfies ReflexFileConfig" : ""};
`;

export async function init(flags: Flags): Promise<void> {
  const workload = str(flags, "workload") ?? "my-agent";
  const ts = supportsTsConfig() && !flags.js;
  const path = ts ? "reflex.config.ts" : "reflex.config.mjs";
  if (existsSync(path) && !flags.force) {
    console.log(`${path} already exists (use --force to overwrite).`);
  } else {
    writeFileSync(path, CONFIG_TEMPLATE(workload, ts));
    console.log(`✔ wrote ${path} (workload "${workload}", shadow mode)`);
  }
  mkdirSync(".reflex", { recursive: true });
  if (existsSync(".gitignore")) {
    const ignore = readFileSync(".gitignore", "utf8");
    if (!/^\.reflex\/?$/m.test(ignore)) {
      appendFileSync(".gitignore", (ignore.endsWith("\n") ? "" : "\n") + ".reflex/\n");
      console.log("✔ added .reflex/ to .gitignore");
    }
  }
  console.log(`
Next steps:
  1. Wrap a decision in your agent loop:
       const d = await reflex.decide({ point: "next_action", state, actions, taskId });
       if (d.type === "auto") run(d.action) else { const a = await frontier(d); reflex.observeChoice(d.id, a); }
  2. Report task results:   reflex.taskOutcome({ taskId, success })
  3. Check what it learned: npx reflex stats   ·   npx reflex train --promote
  4. Health and speed:      npx reflex doctor --tune`);
}

// ------------------------------------------------------------------ doctor

export async function doctor(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const ok = (message: string) => console.log("  ✔ " + message);
  const warn = (message: string) => console.log("  ! " + message);
  console.log("Reflex doctor\n");
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${process.versions.node}`);
  else warn(`Node ${process.versions.node}: ≥ 22.18 recommended (TypeScript configs need built-in type stripping)`);
  ctx.configPath ? ok(`config ${ctx.configPath}`) : warn("no reflex.config.* found (run `npx reflex init`)");
  try {
    mkdirSync(ctx.dataDir, { recursive: true });
    writeFileSync(join(ctx.dataDir, ".write-test"), "ok");
    ok(`data dir ${ctx.dataDir} is writable`);
  } catch (error) {
    warn(`data dir ${ctx.dataDir} not writable: ${String(error)}`);
  }
  const registry = new PolicyRegistry(ctx.dataDir, ctx.workload);
  const current = registry.current();
  current ? ok(`workload "${ctx.workload}" uses policy ${current}`) : warn(`workload "${ctx.workload}" has no promoted policy yet (base policy)`);

  // Backend health and latency.
  const config = ctx.file ? workloadConfig(ctx.file, ctx.workload) : { workload: ctx.workload };
  const backend = resolveBackend(config.backend);
  let backendP50: number | undefined;
  if (!backend) {
    ok("no full-model backend configured (local tiers only; fastest and zero-dependency)");
  } else {
    const health = backend.health ? await backend.health() : { ok: true };
    if (!health.ok) warn(`backend ${backend.name} unreachable: ${health.detail ?? ""} (Reflex will fail open)`);
    else {
      const timings: number[] = [];
      for (let i = 0; i < 12; i++) {
        const started = performance.now();
        try {
          await backend.score({
            point: "doctor",
            question: "Which action should the agent take next?",
            state: { goal: "fix the failing test", last_observation: { status: "error", text: "ImportError in src/date.ts" } },
            candidates: [
              { key: "read_file", id: "read_file", kind: "tool" },
              { key: "web_search", id: "web_search", kind: "search" },
              { key: "frontier", id: "frontier", kind: "model" },
            ],
          });
          if (i >= 2) timings.push(performance.now() - started);
        } catch (error) {
          warn(`backend call failed: ${String(error)}`);
          break;
        }
      }
      if (timings.length) {
        timings.sort((a, b) => a - b);
        backendP50 = timings[Math.floor(timings.length / 2)] as number;
        ok(`backend ${backend.name}: p50 ${backendP50.toFixed(1)} ms over ${timings.length} warm calls`);
      }
    }
  }

  // Local tier microbenchmark.
  const reflex = createReflex({ workload: "doctor", mode: "auto", sink: new NullSink(), learning: { loadPolicy: false, minExamples: 20 } });
  const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const actions = [...files.map((path) => action.with(action.tool("read_file", { risk: "safe", readOnly: true }), { path })), action.tool("run_tests", { risk: "costly" }), action.frontier()];
  for (let i = 0; i < 200; i++) {
    const file = files[i % 4] as string;
    const d = await reflex.decide({ point: "next", state: { lastAction: "run_tests", lastObservation: { status: "error", text: `TypeError in ${file}` } }, actions });
    if (d.type === "escalate") reflex.observeChoice(d.id, { id: "read_file", params: { path: file } });
  }
  const latencies: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const file = files[i % 4] as string;
    const d = await reflex.decide({ point: "next", state: { lastAction: "run_tests", lastObservation: { status: "error", text: `TypeError in ${file} line ${i}` } }, actions });
    latencies.push(d.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[1000] as number;
  const p95 = latencies[1900] as number;
  ok(`local tiers (rules → cache → patterns → head): p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);

  // A full-model tier slower than this costs more wall-clock than it can save on the decision path.
  const MAX_USEFUL_BACKEND_MS = 150;
  if (backendP50 !== undefined && backendP50 > MAX_USEFUL_BACKEND_MS) {
    warn(
      `backend p50 ${backendP50.toFixed(0)} ms is too slow for the live decision path on this machine ` +
        `(Reflex will time out and escalate). Use a GPU, or set tiers: { backend: false } and rely on the local tiers.`,
    );
  }
  if (flags.tune) {
    const slowBackend = backendP50 !== undefined && backendP50 > MAX_USEFUL_BACKEND_MS;
    const speedMode = backendP50 === undefined || slowBackend ? "balanced" : backendP50 > 40 ? "latency-first" : "balanced";
    // Leave headroom over the measured backend latency, but never recommend a multi-second deadline.
    const timeoutMs = backendP50 === undefined || slowBackend ? 75 : Math.min(150, Math.max(50, Math.ceil(backendP50 * 2)));
    const recommendation: Record<string, unknown> = { speed: { mode: speedMode }, timeoutMs };
    if (slowBackend) recommendation.tiers = { backend: false };
    const tune = {
      measuredAt: new Date().toISOString(),
      machine: { platform: process.platform, arch: process.arch, node: process.versions.node },
      localTiers: { p50, p95 },
      backend: backend ? { name: backend.name, p50: backendP50 } : null,
      recommendation,
    };
    writeFileSync(join(ctx.dataDir, "tune.json"), JSON.stringify(tune, null, 2));
    ok(`wrote ${join(ctx.dataDir, "tune.json")}: recommend ${JSON.stringify(recommendation)}`);
  }
}

// ------------------------------------------------------------------ trace / stats

function describe(event: DecisionEvent): string {
  const time = event.ts.slice(11, 19);
  const head = `${time} ${event.point.padEnd(14)} `;
  const outcome =
    event.outcome === "auto"
      ? `AUTO ${event.chosen} (${event.source}, p=${(event.confidence ?? 0).toFixed(2)})`
      : `ESC  ${event.reason}${event.wouldChoose ? ` → hint ${event.wouldChoose}` : ""}`;
  return head + outcome + `  ${event.latencyMs.toFixed(2)}ms`;
}

export async function trace(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const point = str(flags, "point");
  const tail = num(flags, "tail", 25);
  const show = (events: TraceEvent[]) => {
    for (const event of events) {
      if (flags.json) console.log(JSON.stringify(event));
      else if (event.ev === "decision" && (!point || event.point === point)) console.log(describe(event));
      else if (event.ev === "choice" && !point) console.log(`         ↳ ${event.takenBy} chose ${event.action}`);
      else if (event.ev === "task" && !point) console.log(`         ■ task ${event.taskId} ${event.success ? "succeeded" : "FAILED"}`);
    }
  };
  const events = await readTraceEvents(ctx.dataDir, ctx.workload);
  if (!events.length) console.log(`No traces for workload "${ctx.workload}" in ${ctx.dataDir}.`);
  show(events.slice(-tail));
  if (flags.follow) {
    let seen = events.length;
    setInterval(async () => {
      // Trace files are append-only, so new events are always at the end.
      const all = await readTraceEvents(ctx.dataDir, ctx.workload);
      if (all.length > seen) show(all.slice(seen));
      seen = all.length;
    }, 1000);
  }
}

export async function stats(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const events = await readTraceEvents(ctx.dataDir, ctx.workload, flags.days ? { sinceDays: num(flags, "days", 7) } : {});
  const decisions = events.filter((event): event is DecisionEvent => event.ev === "decision");
  if (!decisions.length) {
    console.log(`No decisions recorded for "${ctx.workload}" in ${ctx.dataDir}.`);
    return;
  }
  const choices = new Map<string, string>();
  for (const event of events) if (event.ev === "choice") choices.set(event.decisionId, event.action);
  const tasks = events.filter((event) => event.ev === "task");
  const auto = decisions.filter((event) => event.outcome === "auto");
  const reasons: Record<string, number> = {};
  const sources: Record<string, number> = {};
  for (const event of decisions) {
    if (event.outcome === "auto") sources[event.source] = (sources[event.source] ?? 0) + 1;
    else if (event.reason) reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  }
  let labeled = 0;
  let agreed = 0;
  let wouldAuto = 0;
  let wouldAutoAgreed = 0;
  for (const event of decisions) {
    const choice = choices.get(event.id);
    if (!choice || !event.wouldChoose) continue;
    labeled++;
    const same = choice === event.wouldChoose;
    if (same) agreed++;
    if (event.wouldAuto && event.outcome !== "auto") {
      wouldAuto++;
      if (same) wouldAutoAgreed++;
    }
  }
  const latencies = decisions.map((event) => event.latencyMs).sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  const succeeded = tasks.filter((event) => event.ev === "task" && event.success).length;
  const frontierCost = ctx.file ? workloadConfig(ctx.file, ctx.workload).frontier?.costUsd ?? 0.03 : 0.03;
  const avoided = auto.filter((event) => !event.candidates.find((c) => c.key === event.chosen)?.reasoning).length;
  console.log(`Reflex stats · ${ctx.workload} · ${decisions.length} decisions\n`);
  console.log(`  auto-decided        ${auto.length} (${pct(auto.length / decisions.length)})`);
  console.log(`  by tier             ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}`);
  console.log(`  escalated by reason ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}`);
  console.log(`  latency             p50 ${p(0.5).toFixed(2)} ms · p95 ${p(0.95).toFixed(2)} ms · max ${(latencies[latencies.length - 1] ?? 0).toFixed(2)} ms`);
  if (labeled) {
    console.log(`  agreement w/ labels ${pct(agreed / labeled)} of ${labeled} labeled decisions`);
    if (wouldAuto) console.log(`  shadow: would auto  ${wouldAuto} (${pct(wouldAuto / labeled)} of labeled) at ${pct(wouldAutoAgreed / wouldAuto)} precision`);
  }
  if (tasks.length) console.log(`  tasks               ${tasks.length} · ${pct(succeeded / tasks.length)} succeeded`);
  console.log(`  est. savings        ${avoided} frontier calls ≈ $${(avoided * frontierCost).toFixed(2)}`);
}

// ------------------------------------------------------------------ eval / train / policies

function printReport(title: string, report: EvalReport): void {
  console.log(`${title}`);
  console.log(`  labeled examples   ${report.labeled}`);
  console.log(`  coverage (auto)    ${pct(report.coverage)}`);
  console.log(
    `  auto precision     ${report.autos ? `${pct(report.precision)} (95% lower bound ${pct(report.precisionLower)}, n=${report.autos})` : "–"}`,
  );
  console.log(`  calibration (ECE)  ${report.ece.toFixed(3)}`);
  console.log(`  confident escalations ${report.earlyEscalations}`);
  const tiers = Object.entries(report.byTier).map(([tier, s]) => `${tier} ${s.correct}/${s.auto}`).join(" · ");
  if (tiers) console.log(`  by tier            ${tiers}`);
  const risks = Object.entries(report.byRisk).map(([risk, s]) => `${risk} ${s.correct}/${s.auto}`).join(" · ");
  if (risks) console.log(`  by risk            ${risks}`);
}

function learnOptions(ctx: Awaited<ReturnType<typeof resolveContext>>, flags: Flags) {
  const config = ctx.file ? workloadConfig(ctx.file, ctx.workload) : { workload: ctx.workload };
  const options: Parameters<typeof trainPolicy>[2] = {
    targetPrecision: num(flags, "target-precision", 0.95),
    minExamples: config.learning?.minExamples ?? 20,
    minPatternSupport: config.learning?.minPatternSupport ?? 3,
    minCacheSupport: config.learning?.minCacheSupport ?? 3,
    minFamiliarity: config.learning?.minFamiliarity ?? 0.5,
    minMargin: config.minMargin ?? 0.1,
    allowStateful: config.allowStateful ?? false,
  };
  if (config.floors) options.floors = config.floors;
  return options;
}

export async function evaluate(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const registry = new PolicyRegistry(ctx.dataDir, ctx.workload);
  const version = str(flags, "version") ?? registry.current();
  if (!version) {
    console.log(`No promoted policy for "${ctx.workload}". Train one with \`npx reflex train\`.`);
    return;
  }
  const info = registry.list().find((item) => item.id === version);
  const events = await readTraceEvents(ctx.dataDir, ctx.workload);
  const all = buildExamples(events);
  const since = flags.all ? undefined : info?.createdAt;
  const examples = since ? all.filter((example) => example.ts > since) : all;
  const report = evaluatePolicy(registry.load(version), examples, learnOptions(ctx, flags));
  printReport(`Policy ${version} · ${ctx.workload} · ${since ? `examples after ${since}` : "all examples (includes training data)"}`, report);
  if (since && report.labeled === 0) console.log("\n  No new labeled data since this policy was trained. Use --all to include training data.");
}

export async function train(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const events = await readTraceEvents(ctx.dataDir, ctx.workload);
  const examples = buildExamples(events);
  const labeled = examples.filter((example) => example.kind === "label").length;
  console.log(`Training "${ctx.workload}" from ${examples.length} examples (${labeled} labeled)…`);
  if (labeled < 20) {
    console.log("Not enough labeled decisions yet (need ≥ 20). Run in shadow mode and report choices with observeChoice().");
    process.exitCode = 1;
    return;
  }
  const options = learnOptions(ctx, flags);
  const { policy, report, validation } = trainPolicy(ctx.workload, examples, options);
  printReport("\nCandidate (held-out validation)", report);
  const registry = new PolicyRegistry(ctx.dataDir, ctx.workload);
  const currentVersion = registry.current();
  let currentReport: EvalReport | undefined;
  if (currentVersion) {
    currentReport = evaluatePolicy(registry.load(currentVersion), validation, options);
    printReport(`\nCurrent ${currentVersion} (same validation data)`, currentReport);
  }
  const gate = checkPromotion(report, currentReport, { tolerance: num(flags, "tolerance", 0.015) });
  const version = registry.save(policy, str(flags, "note") ?? `trained on ${examples.length} examples`);
  console.log(`\n✔ saved candidate ${version} (thresholds ${JSON.stringify(policy.thresholds)})`);
  if (flags.promote) {
    if (gate.ok || flags.force) {
      registry.promote(version);
      console.log(`✔ promoted ${version}${gate.ok ? "" : " (forced past gate: " + gate.reason + ")"}`);
      console.log("  Running sidecars pick it up via POST /v1/policy/reload; SDK instances via reflex.reloadPolicy().");
    } else {
      console.log(`✖ not promoted: ${gate.reason}. Use --force to override.`);
      process.exitCode = 1;
    }
  } else {
    console.log(`  Promotion gate: ${gate.ok ? "PASS" : "FAIL"} (${gate.reason}). Promote with \`npx reflex promote ${version}\`.`);
  }
}

export async function policies(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const registry = new PolicyRegistry(ctx.dataDir, ctx.workload);
  const current = registry.current();
  const versions = registry.list();
  if (!versions.length) return console.log(`No policies for "${ctx.workload}".`);
  for (const info of versions) {
    const m = info.metrics;
    const metrics = m ? ` coverage ${pct(m.coverage)} precision ${pct(m.precision)} ece ${m.ece.toFixed(3)}` : "";
    console.log(`${info.id === current ? "*" : " "} ${info.id.padEnd(5)} ${info.createdAt.slice(0, 19)}${metrics}  ${info.note ?? ""}`);
  }
}

export async function promote(flags: Flags, version: string | undefined): Promise<void> {
  if (!version) throw new Error("usage: reflex promote <version>");
  const ctx = await resolveContext(contextFlags(flags));
  new PolicyRegistry(ctx.dataDir, ctx.workload).promote(version);
  console.log(`✔ promoted ${version} for "${ctx.workload}"`);
}

export async function rollback(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const version = new PolicyRegistry(ctx.dataDir, ctx.workload).rollback();
  console.log(version ? `✔ rolled back "${ctx.workload}" to ${version}` : `✔ "${ctx.workload}" is back on the base policy`);
}

// ------------------------------------------------------------------ serve / mcp / laya / bench

function serviceFor(ctx: Awaited<ReturnType<typeof resolveContext>>, flags: Flags): ReflexService {
  const overrides: { mode?: Mode; dataDir: string } = { dataDir: ctx.dataDir };
  const mode = str(flags, "mode");
  if (mode) overrides.mode = mode as Mode;
  const options: ConstructorParameters<typeof ReflexService>[0] = { defaultWorkload: ctx.workload, overrides };
  if (ctx.file) options.file = ctx.file;
  return new ReflexService(options);
}

export async function serve(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  const service = serviceFor(ctx, flags);
  const options: Parameters<typeof createSidecar>[1] = { host: str(flags, "host") ?? "127.0.0.1" };
  const token = str(flags, "token") ?? process.env.REFLEX_TOKEN;
  if (token) options.token = token;
  const server = createSidecar(service, options);
  const { port, host } = await listen(server, num(flags, "port", 7070), options.host);
  console.log(`Reflex sidecar on http://${host}:${port}  (dashboard: http://${host}:${port}/ui)`);
  console.log(`  default workload "${ctx.workload}", data ${ctx.dataDir}${token ? ", token required" : ""}`);
  const shutdown = async () => {
    server.close();
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function mcp(flags: Flags): Promise<void> {
  const ctx = await resolveContext(contextFlags(flags));
  // stdout belongs to the protocol: send any logging to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  await serveMcp(serviceFor(ctx, flags), { version: VERSION });
}

export async function laya(flags: Flags): Promise<void> {
  const python = process.env.REFLEX_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const args = ["-m", "reflex_laya", "--port", String(num(flags, "port", 7071)), "--checkpoint", str(flags, "checkpoint") ?? "english", "--device", str(flags, "device") ?? "cpu"];
  if (flags.mock) args.push("--mock");
  console.error(`Starting Laya sidecar: ${python} ${args.join(" ")}`);
  console.error("  (install with: pip install -e python/reflex-laya[laya]; use --mock to run without Laya)");
  const child = spawn(python, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export async function bench(flags: Flags): Promise<void> {
  const suiteFlag = str(flags, "suite") ?? "all";
  const suites = suiteFlag === "all" ? Object.keys(SUITES) : suiteFlag.split(",");
  const tasks = num(flags, "tasks", 300);
  const seed = num(flags, "seed", 42);
  const results = [];
  for (const suite of suites) {
    const result = await compare(suite, tasks, seed);
    results.push(result);
    if (!flags.json) console.log(formatComparison(result) + "\n");
  }
  if (flags.json) console.log(JSON.stringify(results, null, 2));
  if (flags.out) writeFileSync(String(flags.out), JSON.stringify(results, null, 2));
}

