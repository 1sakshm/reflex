import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { action, createReflex, MemorySink } from "@reflex-ai/core";

const python = process.env.REFLEX_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const hasPython = spawnSync(python, ["--version"]).status === 0;

test("TS runtime → Python Laya sidecar (mock scorer) → model-tier decision", { skip: !hasPython && "python not available" }, async () => {
  const child = spawn(python, ["-m", "reflex_laya", "--mock", "--port", "0"], {
    cwd: join(import.meta.dirname, "..", "..", "..", "python", "reflex-laya"),
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sidecar did not start")), 10_000);
      child.stderr.on("data", (chunk: Buffer) => {
        const match = /listening on (http:\/\/\S+)/.exec(chunk.toString());
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
    });
    const reflex = createReflex({
      workload: "integration",
      mode: "auto",
      sink: new MemorySink(),
      timeoutMs: 2000,
      backend: { type: "laya", url },
      learning: { loadPolicy: false },
    });
    const readFile = action.tool("read_file", { risk: "safe", readOnly: true });
    const decision = await reflex.decide({
      point: "next_action",
      state: { goal: "fix test", lastObservation: { status: "error", text: "ImportError in date.ts date ts" } },
      actions: [action.with(readFile, { path: "date.ts" }), action.search("web_search"), action.frontier()],
    });
    // The mock scorer is lexical, so it may or may not clear the bar; either way the model tier must have answered.
    assert.ok(decision.hints.length > 0, JSON.stringify(decision));
    assert.equal(decision.hints[0]?.action.id, "read_file");
    assert.ok(decision.type === "auto" ? decision.source === "model" : decision.reason !== "timeout", JSON.stringify(decision));
    const many = await reflex.decideMany([
      { point: "a", state: { goal: "x" }, actions: [readFile, action.frontier()] },
      { point: "b", state: { goal: "x" }, actions: [readFile, action.frontier()] },
    ]);
    assert.equal(many.length, 2);
    await reflex.close();
  } finally {
    child.kill();
  }
});
