import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, runBench } from "@reflex-ai/bench";

test("sim-coding: Reflex cuts $/success and frontier calls at iso-quality", async () => {
  const result = await compare("sim-coding", 150, 7);
  assert.ok(result.delta.successPp >= -2, `success Δ ${result.delta.successPp.toFixed(1)} pp`);
  assert.ok(result.delta.usdPerSuccessPct < -30, `$/success Δ ${result.delta.usdPerSuccessPct.toFixed(1)}%`);
  assert.ok(result.delta.frontierCallsPct < -30, `frontier Δ ${result.delta.frontierCallsPct.toFixed(1)}%`);
  assert.ok(result.reflex.autoPrecision > 0.97, `auto precision ${result.reflex.autoPrecision}`);
  assert.ok(result.reflex.reflexLatencyMs.p95 < 25, `p95 ${result.reflex.reflexLatencyMs.p95} ms`);
});

test("sim-support: quality stays within the 2 pp budget", async () => {
  const result = await compare("sim-support", 200, 7);
  assert.ok(result.delta.successPp >= -2, `success Δ ${result.delta.successPp.toFixed(1)} pp`);
  assert.ok(result.reflex.frontierCallsPerTask < result.baseline.frontierCallsPerTask);
});

test("benchmarks are deterministic for a seed", async () => {
  const a = await runBench({ suite: "sim-coding", tasks: 40, seed: 3, policy: "frontier" });
  const b = await runBench({ suite: "sim-coding", tasks: 40, seed: 3, policy: "frontier" });
  assert.equal(a.totalUsd, b.totalUsd);
  assert.equal(a.steps, b.steps);
});
