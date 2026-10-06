import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { action, createReflex } from "@reflex-ai/core";

const BIN = join(import.meta.dirname, "..", "src", "bin.ts");

function cli(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=reflex-source", BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

test("CLI: init → (shadow traces) → stats → train --promote → eval → policies → rollback → bench", async () => {
  // Inside the repo so the generated config can resolve @reflex-ai/core, as in a real install.
  const dir = mkdtempSync(join(import.meta.dirname, ".tmp-cli-"));
  try {
    const init = cli(dir, "init", "--workload", "demo");
    assert.equal(init.code, 0, init.out);
    assert.ok(existsSync(join(dir, "reflex.config.ts")));

    const reflex = createReflex({ workload: "demo", mode: "shadow", dataDir: join(dir, ".reflex") });
    const actions = [action.tool("read_file", { risk: "safe" }), action.tool("run_tests", { risk: "costly" }), action.frontier()];
    for (let i = 0; i < 120; i++) {
      const failing = i % 3 !== 0;
      const d = await reflex.decide({
        point: "next_action",
        taskId: `t${i}`,
        state: failing ? { lastAction: "run_tests", lastObservation: { status: "error", text: `ImportError m${i}` } } : { lastAction: "edit", lastObservation: { status: "ok", type: "edited" } },
        actions,
      });
      reflex.observeChoice(d.id, failing ? "read_file" : "run_tests");
      reflex.taskOutcome({ taskId: `t${i}`, success: true });
    }
    await reflex.close();

    const stats = cli(dir, "stats", "--workload", "demo");
    assert.equal(stats.code, 0, stats.out);
    assert.match(stats.out, /120 decisions/);

    const train = cli(dir, "train", "--workload", "demo", "--promote");
    assert.equal(train.code, 0, train.out);
    assert.match(train.out, /promoted v1/);

    const evaluation = cli(dir, "eval", "--workload", "demo", "--all");
    assert.equal(evaluation.code, 0, evaluation.out);
    assert.match(evaluation.out, /auto precision\s+100\.0%/);

    const listed = cli(dir, "policies", "--workload", "demo");
    assert.match(listed.out, /\* v1/);

    const rolled = cli(dir, "rollback", "--workload", "demo");
    assert.match(rolled.out, /base policy/);

    const trace = cli(dir, "trace", "--workload", "demo", "--tail", "3");
    assert.equal(trace.code, 0, trace.out);

    const bench = cli(dir, "bench", "--suite", "sim-support", "--tasks", "30", "--json");
    assert.equal(bench.code, 0, bench.out);
    assert.equal(JSON.parse(bench.out)[0].suite, "sim-support");

    const doctor = cli(dir, "doctor", "--workload", "demo", "--tune");
    assert.equal(doctor.code, 0, doctor.out);
    assert.ok(existsSync(join(dir, ".reflex", "tune.json")));

    const unknown = cli(dir, "nope");
    assert.equal(unknown.code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
