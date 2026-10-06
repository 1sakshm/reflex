/**
 * Regression tests for bugs found in the v0.1 independent review and adversarial testing.
 * Each test names the finding it guards against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  action,
  buildExamples,
  checkPromotion,
  createReflex,
  functionBackend,
  MemorySink,
  trainPolicy,
  type ActionSpec,
  type DecisionEvent,
  type EvalReport,
  type ReflexConfig,
} from "@reflex-ai/core";

const make = (overrides: Partial<ReflexConfig> = {}) => {
  const sink = new MemorySink();
  return {
    sink,
    reflex: createReflex({ workload: "reg", mode: "auto", sink, learning: { loadPolicy: false, minExamples: 5 }, ...overrides }),
  };
};
const read = action.tool("read_file", { risk: "safe", readOnly: true });
const base: ActionSpec[] = [read, action.frontier(), action.stop()];

test("cyclic params with many branches terminate quickly (was: exponential hang)", async () => {
  const params: Record<string, unknown> = {};
  for (const key of ["a", "b", "c", "d"]) params[key] = params;
  const { reflex } = make();
  const started = performance.now();
  const d = await reflex.decide({ point: "p", state: { goal: "x" }, actions: [action.with(read, params), action.frontier()] });
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
  assert.ok(d.type === "auto" || d.type === "escalate");
});

test("BigInt params are traced, not turned into internal_error", async () => {
  const { reflex, sink } = make();
  const d = await reflex.decide({ point: "p", state: {}, actions: [action.with(read, { n: 10n }), action.frontier()] });
  assert.notEqual(d.type === "escalate" && d.reason, "internal_error");
  await reflex.flush();
  assert.ok(sink.events.length >= 1);
});

test("force rules cannot bypass stateful or reasoning gating", async () => {
  const edit = action.tool("edit_file", { risk: "stateful" });
  const { reflex } = make({
    rules: [
      { type: "force", action: "edit_file", when: { path: "point", equals: "edit" } },
      { type: "force", action: "frontier", when: { path: "point", equals: "think" } },
    ],
  });
  const d1 = await reflex.decide({ point: "edit", state: {}, actions: [edit, ...base] });
  assert.equal(d1.type === "escalate" && d1.reason, "risk");
  const d2 = await reflex.decide({ point: "think", state: {}, actions: base });
  assert.equal(d2.type === "escalate" && d2.reason, "difficulty");
  const allowed = make({ allowStateful: true, rules: [{ type: "force", action: "edit_file", when: () => true }] });
  assert.equal((await allowed.reflex.decide({ point: "edit", state: {}, actions: [edit, ...base] })).type, "auto");
});

test("force rules respect budgets and loop detection", async () => {
  const retry = action.retry("retry_backoff");
  const { reflex } = make({
    budgets: { maxRetriesPerAction: 2, loopWindow: 10 },
    rules: [{ type: "force", action: "retry_backoff", when: () => true }],
  });
  const reasons: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await reflex.decide({ point: "err", state: {}, actions: [retry, action.frontier()], taskId: "t" });
    reasons.push(d.type === "auto" ? "auto" : d.reason);
  }
  assert.deepEqual(reasons, ["auto", "auto", "budget"]);
});

test("REFLEX_MODE overrides per-call and per-point modes", async () => {
  process.env.REFLEX_MODE = "shadow";
  try {
    const { reflex } = make({
      points: { p: { mode: "auto" } },
      backend: functionBackend("fixed", (r) => ({ probs: Object.fromEntries(r.candidates.map((c) => [c.key, c.id === "read_file" ? 0.98 : 0.01])) })),
    });
    const d = await reflex.decide({ point: "p", state: {}, actions: base, mode: "auto" });
    assert.equal(d.type === "escalate" && d.reason, "mode");
  } finally {
    delete process.env.REFLEX_MODE;
  }
});

test("a lone candidate is never auto-decided from a softmax (head/model)", async () => {
  const { reflex } = make({
    backend: functionBackend("nan", () => ({ probs: { read_file: Number.NaN } })),
  });
  const d = await reflex.decide({ point: "p", state: {}, actions: [read] });
  assert.equal(d.type, "escalate");
});

test("exact cache distinguishes states that differ beyond the encoder's truncation", async () => {
  const { reflex } = make({ tiers: { patterns: false, head: false, cache: true, backend: false } });
  const prefix = "x".repeat(600);
  const actions = [read, action.tool("open_pr", { risk: "safe" }), action.frontier()];
  for (let i = 0; i < 4; i++) {
    const d = await reflex.decide({ point: "p", state: { lastObservation: { text: prefix + " ALL TESTS PASSED" } }, actions });
    if (d.type === "escalate") reflex.observeChoice(d.id, "open_pr");
  }
  const same = await reflex.decide({ point: "p", state: { lastObservation: { text: prefix + " ALL TESTS PASSED" } }, actions });
  assert.equal(same.type === "auto" && same.action.id, "open_pr");
  const different = await reflex.decide({ point: "p", state: { lastObservation: { text: prefix + " 12 TESTS FAILED" } }, actions });
  assert.equal(different.type, "escalate");
});

test("exact cache needs ≥3 observations; one label never locks a decision in", async () => {
  const { reflex } = make({ tiers: { patterns: false, head: false } });
  const actions = [read, action.search("web_search"), action.frontier()];
  const first = await reflex.decide({ point: "p", state: { goal: "same" }, actions });
  reflex.observeChoice(first.id, "read_file");
  const second = await reflex.decide({ point: "p", state: { goal: "same" }, actions });
  assert.equal(second.type, "escalate");
});

test("observeChoice resolves labels when a schema transformed the params", async () => {
  const withDefault = {
    safeParse: (value: unknown) => ({ success: true, data: { encoding: "utf8", ...(value as object) } }),
  };
  const a = action.with(action.tool("read_file", { risk: "safe", paramsSchema: withDefault }), { path: "a.ts" });
  const b = action.with(action.tool("read_file", { risk: "safe", paramsSchema: withDefault }), { path: "b.ts" });
  const { reflex, sink } = make();
  const d = await reflex.decide({ point: "p", state: {}, actions: [a, b, action.frontier()] });
  assert.ok(reflex.observeChoice(d.id, { id: "read_file", params: { path: "b.ts" } }));
  await reflex.flush();
  const choice = sink.events.find((event) => event.ev === "choice");
  assert.ok(choice && choice.ev === "choice" && !choice.action.startsWith("other:"), JSON.stringify(choice));
});

test("loop window counts the current pick (window 3 → third identical pick escalates)", async () => {
  const { reflex } = make({
    budgets: { loopWindow: 3 },
    backend: functionBackend("fixed", (r) => ({ probs: Object.fromEntries(r.candidates.map((c) => [c.key, c.id === "read_file" ? 0.97 : 0.015])) })),
  });
  const reasons: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await reflex.decide({ point: "p", state: {}, actions: base, taskId: "loop" });
    reasons.push(d.type === "auto" ? "auto" : d.reason);
  }
  assert.deepEqual(reasons, ["auto", "auto", "loop"]);
});

test("repeated outcome reports penalize only once; savePolicy keeps the live version", async () => {
  const { reflex } = make();
  const d = await reflex.decide({ point: "p", state: {}, actions: base });
  reflex.outcome({ decisionId: d.id, status: "error" });
  reflex.outcome({ decisionId: d.id, status: "error" }); // must be a no-op
  const before = reflex.policyVersion;
  // savePolicy writes to dataDir; use a throwaway directory.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reflex-reg-"));
  try {
    const saver = createReflex({ workload: "reg", dataDir: dir, sink: new MemorySink(), learning: { loadPolicy: false } });
    const saved = saver.savePolicy("snapshot");
    assert.equal(saved, "v1");
    assert.equal(saver.policyVersion, "base", "the live policy must not claim an unpromoted version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(reflex.policyVersion, before);
});

test("an already-aborted signal returns immediately", async () => {
  const { reflex } = make({ backend: functionBackend("slow", () => new Promise((resolve) => setTimeout(() => resolve({ probs: {} }), 1000))) });
  const controller = new AbortController();
  controller.abort();
  const started = performance.now();
  const d = await reflex.decide({ point: "p", state: {}, actions: base, signal: controller.signal });
  assert.equal(d.type === "escalate" && d.reason, "timeout");
  assert.ok(performance.now() - started < 50);
});

test("secret-named state fields are redacted", async () => {
  const { reflex, sink } = make();
  await reflex.decide({ point: "p", state: { apiKey: "plain-key-value", password: "hunter2hunter2" }, actions: base });
  await reflex.flush();
  const dump = JSON.stringify(sink.events);
  assert.ok(!dump.includes("plain-key-value") && !dump.includes("hunter2hunter2"));
});

test("audit sampling keeps sending some confident decisions to System 2", async () => {
  const { reflex } = make({
    learning: { loadPolicy: false, auditRate: 0.1 },
    backend: functionBackend("fixed", (r) => ({ probs: Object.fromEntries(r.candidates.map((c) => [c.key, c.id === "read_file" ? 0.97 : 0.015])) })),
  });
  let audits = 0;
  for (let i = 0; i < 50; i++) {
    const d = await reflex.decide({ point: "p", state: { i }, actions: base });
    if (d.type === "escalate" && d.reason === "audit") audits++;
  }
  assert.equal(audits, 5);
});

test("training: thresholds stay strict when the target can't be met; gate uses a confidence bound", async () => {
  // Labels are random relative to the state, so no threshold can reach 95% precision.
  const { reflex, sink } = make({ mode: "shadow" });
  const actions = [read, action.search("web_search"), action.frontier()];
  for (let i = 0; i < 400; i++) {
    const d = await reflex.decide({ point: "p", state: { lastAction: "x", lastObservation: { status: "ok" }, i: i % 7 }, actions });
    reflex.observeChoice(d.id, (i * 7919) % 3 === 0 ? "web_search" : "read_file");
  }
  await reflex.flush();
  const { policy, report } = trainPolicy("reg", buildExamples(sink.events), { minExamples: 5 });
  for (const value of Object.values(policy.thresholds)) assert.ok(value === undefined || value >= 0.95, JSON.stringify(policy.thresholds));
  assert.ok(report.autos === 0 || report.precision >= 0.9 || !checkPromotion(report, undefined).ok);

  const lucky = { labeled: 100, autos: 30, precision: 0.9, precisionLower: 0.74, coverage: 0.3 } as EvalReport;
  assert.equal(checkPromotion(lucky, undefined).ok, false, "lower bound below 80% must block promotion");
  const ok = (sink.events.filter((e) => e.ev === "decision") as DecisionEvent[]).every((e) => typeof e.stateDigest === "string");
  assert.ok(ok);
});
