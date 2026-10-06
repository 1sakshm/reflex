import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  action,
  buildExamples,
  checkPromotion,
  createReflex,
  evaluatePolicy,
  fitTemperature,
  functionBackend,
  MemorySink,
  PolicyRegistry,
  trainPolicy,
  type ActionSpec,
  type DecisionEvent,
  type ReflexConfig,
} from "@reflex-ai/core";

const readFile = action.tool("read_file", { risk: "safe", readOnly: true });
const grep = action.tool("grep", { risk: "safe", readOnly: true });
const runTests = action.tool("run_tests", { risk: "costly" });
const editFile = action.tool("edit_file", { risk: "stateful" });
const deploy = action.tool("deploy", { risk: "destructive" });
const frontier = action.frontier();
const ACTIONS: ActionSpec[] = [readFile, grep, runTests, frontier, action.stop()];

function make(overrides: Partial<ReflexConfig> = {}) {
  const sink = new MemorySink();
  const reflex = createReflex({
    workload: "test",
    mode: "auto",
    sink,
    learning: { loadPolicy: false, minExamples: 5 },
    ...overrides,
  });
  return { reflex, sink };
}

const failingTest = (module = "utils/date") => ({
  goal: "fix the failing date test",
  lastAction: "run_tests",
  lastObservation: { status: "error", errorClass: "ImportError", text: `cannot import ${module}` },
});

test("cold start escalates with a clear reason and never throws", async () => {
  const { reflex } = make();
  const d = await reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d.type, "escalate");
  assert.equal(d.type === "escalate" && d.reason, "low_confidence");
  assert.ok(d.latencyMs < 50, `latency ${d.latencyMs}`);
});

test("fails open when the backend throws", async () => {
  const { reflex } = make({
    backend: functionBackend("boom", () => {
      throw new Error("model crashed");
    }),
  });
  const d = await reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d.type, "escalate");
  assert.match(d.type === "escalate" ? d.detail : "", /model crashed/);
});

test("enforces the hard timeout on a hanging backend", async () => {
  const { reflex } = make({
    timeoutMs: 30,
    backend: functionBackend("slow", () => new Promise(() => {})),
  });
  const started = performance.now();
  const d = await reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d.type === "escalate" && d.reason, "timeout");
  assert.ok(performance.now() - started < 200);
});

test("backend scores drive auto decisions; destructive is never auto-executed", async () => {
  const confident = (key: string) =>
    functionBackend("fixed", (request) => ({
      probs: Object.fromEntries(request.candidates.map((c) => [c.key, c.key === key ? 0.97 : 0.03 / (request.candidates.length - 1)])),
    }));
  const ok = make({ backend: confident("read_file") });
  const d1 = await ok.reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d1.type, "auto");
  assert.equal(d1.type === "auto" && d1.source, "model");

  const danger = make({ backend: confident("deploy") });
  const d2 = await danger.reflex.decide({ point: "next_action", state: failingTest(), actions: [...ACTIONS, deploy] });
  assert.equal(d2.type === "escalate" && d2.reason, "risk");

  const edit = make({ backend: confident("edit_file") });
  const d3 = await edit.reflex.decide({ point: "next_action", state: failingTest(), actions: [...ACTIONS, editFile] });
  assert.equal(d3.type === "escalate" && d3.reason, "risk", "stateful needs allowStateful");

  const reason = make({ backend: confident("frontier") });
  const d4 = await reason.reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d4.type === "escalate" && d4.reason, "difficulty");
});

test("shadow mode never acts but records what it would have done", async () => {
  const { reflex, sink } = make({
    mode: "shadow",
    backend: functionBackend("fixed", (request) => ({
      probs: Object.fromEntries(request.candidates.map((c) => [c.key, c.id === "grep" ? 0.9 : 0.025])),
    })),
  });
  const d = await reflex.decide({ point: "next_action", state: failingTest(), actions: ACTIONS });
  assert.equal(d.type, "escalate");
  assert.equal(d.type === "escalate" && d.reason, "mode");
  assert.equal(d.type === "escalate" && d.shadow?.action, "grep");
  assert.equal(d.type === "escalate" && d.shadow?.wouldAuto, true);
  await reflex.flush();
  const event = sink.events.find((e) => e.ev === "decision") as DecisionEvent;
  assert.equal(event.wouldChoose, "grep");
});

test("rules: deny, force, requireEscalation, and forced destructive", async () => {
  const { reflex } = make({
    rules: [
      { id: "no-grep", type: "deny", actions: ["grep"] },
      { id: "rate-limit", type: "force", action: "retry_backoff", when: { path: "state.lastObservation.type", equals: "rate_limit" } },
      { id: "stuck", type: "requireEscalation", when: { path: "state.stepsSinceProgress", gte: 5 } },
      { id: "ship", type: "force", action: "deploy", when: { path: "state.goal", matches: "ship it" } },
    ],
  });
  const retry = action.retry("retry_backoff");
  const forced = await reflex.decide({
    point: "on_error",
    state: { lastObservation: { status: "error", type: "rate_limit" } },
    actions: [retry, frontier],
  });
  assert.equal(forced.type, "auto");
  assert.equal(forced.type === "auto" && forced.source, "rule");

  const stuck = await reflex.decide({ point: "next_action", state: { stepsSinceProgress: 7 }, actions: ACTIONS });
  assert.equal(stuck.type === "escalate" && stuck.reason, "rule");

  const denied = await reflex.decide({ point: "next_action", state: {}, actions: [grep] });
  assert.equal(denied.type === "escalate" && denied.reason, "rule");

  const destructive = await reflex.decide({ point: "release", state: { goal: "ship it" }, actions: [deploy, frontier] });
  assert.equal(destructive.type === "escalate" && destructive.reason, "risk");
});

test("learns from frontier labels: later identical situations are auto-decided", async () => {
  const { reflex } = make();
  for (let i = 0; i < 6; i++) {
    const d = await reflex.decide({ point: "next_action", state: failingTest(`mod${i}`), actions: ACTIONS, taskId: `t${i}` });
    if (d.type === "escalate") reflex.observeChoice(d.id, "read_file");
  }
  const d = await reflex.decide({ point: "next_action", state: failingTest("brand_new"), actions: ACTIONS, taskId: "t9" });
  assert.equal(d.type, "auto", JSON.stringify(d));
  assert.equal(d.type === "auto" && d.action.id, "read_file");
  assert.ok(d.type === "auto" && ["pattern", "head"].includes(d.source));
  const stats = reflex.stats();
  assert.ok(stats.auto >= 1);
  assert.ok(stats.shadow.labeled >= 1, "agreement is measured once Reflex has a prediction");
});

test("head tier learns params: picks the file mentioned in the observation", async () => {
  const { reflex } = make({ tiers: { patterns: false, cache: false } });
  const files = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];
  const rounds = (seed: number) => {
    const target = files[seed % files.length] as string;
    const actions = [
      ...files.map((path) => action.with(readFile, { path })),
      frontier,
    ];
    return { target, actions, state: { lastAction: "run_tests", lastObservation: { status: "error", text: `TypeError in ${target} line ${seed}` } } };
  };
  for (let i = 0; i < 60; i++) {
    const { target, actions, state } = rounds(i);
    const d = await reflex.decide({ point: "inspect", state, actions });
    if (d.type === "escalate") reflex.observeChoice(d.id, { id: "read_file", params: { path: target } });
  }
  let correct = 0;
  let autos = 0;
  for (let i = 100; i < 120; i++) {
    const { target, actions, state } = rounds(i);
    const d = await reflex.decide({ point: "inspect", state, actions });
    if (d.type === "auto") {
      autos++;
      if ((d.params as { path: string }).path === target) correct++;
    }
  }
  assert.ok(autos >= 10, `expected the head to become confident, autos=${autos}`);
  assert.equal(correct, autos, "every auto decision should pick the right file");
});

test("loop detection escalates repeated identical auto choices", async () => {
  const { reflex } = make({
    backend: functionBackend("fixed", (request) => ({
      probs: Object.fromEntries(request.candidates.map((c) => [c.key, c.id === "grep" ? 0.95 : 0.01])),
    })),
  });
  const reasons: string[] = [];
  for (let i = 0; i < 4; i++) {
    const d = await reflex.decide({ point: "next_action", state: { goal: "x" }, actions: ACTIONS, taskId: "loop" });
    reasons.push(d.type === "auto" ? "auto" : d.reason);
  }
  assert.deepEqual(reasons, ["auto", "auto", "loop", "loop"], "loopWindow 3: the third identical pick escalates");
});

test("budgets escalate once exhausted", async () => {
  const { reflex } = make({ budgets: { maxStepsPerTask: 2 } });
  const reasons: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await reflex.decide({ point: "p", state: {}, actions: ACTIONS, taskId: "b" });
    reasons.push(d.type === "auto" ? "auto" : d.reason);
  }
  assert.equal(reasons[2], "budget");
});

test("kill switch overrides per-call modes", async () => {
  process.env.REFLEX_DISABLE = "1";
  try {
    const { reflex } = make();
    const d = await reflex.decide({ point: "p", state: {}, actions: ACTIONS, mode: "auto" });
    assert.equal(d.type === "escalate" && d.reason, "mode");
  } finally {
    delete process.env.REFLEX_DISABLE;
  }
});

test("secrets are redacted before they reach traces", async () => {
  const { reflex, sink } = make();
  await reflex.decide({
    point: "p",
    state: { goal: "deploy with key sk-ant-abcdefghijklmnopqrstuvwxyz123456", lastObservation: "password=hunter22222" },
    actions: ACTIONS,
  });
  await reflex.flush();
  const text = JSON.stringify(sink.events);
  assert.ok(!text.includes("abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(!text.includes("hunter22222"));
  assert.ok(text.includes("[REDACTED]"));
});

test("hedging fires before the full model on likely-hard steps", async () => {
  const { reflex } = make({
    speed: { mode: "latency-first", earlyEscalate: 0.99 },
    backend: functionBackend("slowish", async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { probs: Object.fromEntries(request.candidates.map((c) => [c.key, 1 / request.candidates.length])) };
    }),
  });
  // Teach the difficulty head that this situation needs the frontier model.
  for (let i = 0; i < 12; i++) {
    const d = await reflex.decide({ point: "plan", state: { goal: "design a migration", lastObservation: { type: "spec" } }, actions: ACTIONS });
    reflex.observeChoice(d.id, "frontier");
  }
  let hedged = 0;
  const d = await reflex.decide({
    point: "plan",
    state: { goal: "design a migration", lastObservation: { type: "spec" } },
    actions: ACTIONS,
    onHedge: () => hedged++,
  });
  assert.equal(d.type, "escalate");
  assert.ok(hedged === 1 || (d.type === "escalate" && d.reason === "difficulty"), JSON.stringify(d));
});

test("decideMany batches and returns one decision per request", async () => {
  const { reflex } = make();
  const ds = await reflex.decideMany([
    { point: "a", state: {}, actions: ACTIONS },
    { point: "b", state: {}, actions: ACTIONS },
  ]);
  assert.equal(ds.length, 2);
  assert.notEqual(ds[0]?.id, ds[1]?.id);
});

test("offline training, evaluation, registry promotion and rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflex-test-"));
  try {
    const { reflex, sink } = make({ mode: "shadow", dataDir: dir });
    for (let i = 0; i < 200; i++) {
      const failing = i % 2 === 0;
      const d = await reflex.decide({
        point: "next_action",
        state: failing ? failingTest(`m${i}`) : { lastAction: "edit_file", lastObservation: { status: "ok", type: "edited" } },
        actions: ACTIONS,
      });
      reflex.observeChoice(d.id, failing ? "read_file" : "run_tests");
    }
    await reflex.flush();
    const examples = buildExamples(sink.events);
    assert.equal(examples.length, 200);
    const { policy, report } = trainPolicy("test", examples, { minExamples: 5 });
    assert.ok(report.coverage > 0.5, `coverage ${report.coverage}`);
    assert.ok(report.precision > 0.95, `precision ${report.precision}`);
    assert.ok(checkPromotion(report, undefined).ok);

    const registry = new PolicyRegistry(dir, "test");
    const v1 = registry.save(policy, "first");
    registry.promote(v1);
    const v2 = registry.save(policy, "second");
    registry.promote(v2);
    assert.equal(registry.current(), "v2");
    assert.equal(registry.rollback(), "v1");

    const loaded = registry.loadCurrent();
    assert.ok(loaded);
    const again = evaluatePolicy(loaded, examples.slice(-40), { minExamples: 5 });
    assert.ok(again.precision > 0.95);

    // A fresh instance picks up the promoted policy and auto-decides immediately.
    const fresh = createReflex({ workload: "test", mode: "auto", dataDir: dir, sink: new MemorySink(), learning: { minExamples: 5 } });
    assert.equal(fresh.policyVersion, "v1");
    const d = await fresh.decide({ point: "next_action", state: failingTest("unseen"), actions: ACTIONS });
    assert.equal(d.type === "auto" && d.action.id, "read_file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temperature fitting cools overconfident distributions", () => {
  const samples = Array.from({ length: 50 }, (_, i) => ({
    dist: new Map([
      ["a", 0.99],
      ["b", 0.01],
    ]),
    label: i % 2 === 0 ? "a" : "b",
  }));
  assert.ok(fitTemperature(samples) > 1);
});
