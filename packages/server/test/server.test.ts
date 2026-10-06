import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { MemorySink } from "@reflex-ai/core";
import { createSidecar, listen, ReflexService, serveMcp } from "@reflex-ai/server";

const service = () =>
  new ReflexService({
    defaultWorkload: "svc",
    overrides: { mode: "auto", sink: new MemorySink(), learning: { loadPolicy: false, minExamples: 5 } },
  });

const actions = [
  { id: "read_file", kind: "tool", risk: "safe" },
  { id: "web_search", kind: "search", risk: "cheap" },
  { id: "frontier", kind: "model", risk: "cheap", reasoning: true },
];

test("HTTP sidecar: decide, observe, metrics, dashboard", async () => {
  const svc = service();
  const server = createSidecar(svc);
  const { port } = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    const decided = await post("/v1/decide", { point: "next_tool", state: { goal: "find bug" }, actions });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.type, "escalate");
    const observed = await post("/v1/observe", { decisionId: decided.json.id, action: "read_file" });
    assert.deepEqual(observed.json, { ok: true });
    const bad = await post("/v1/decide", { actions });
    assert.equal(bad.status, 400);
    const many = await post("/v1/decide_many", { requests: [{ point: "a", actions }, { point: "b", actions }] });
    assert.equal((many.json.decisions as unknown[]).length, 2);
    const metrics = (await (await fetch(base + "/v1/metrics?workload=svc")).json()) as { decisions: number };
    assert.equal(metrics.decisions, 3, "the invalid request is rejected before reaching Reflex");
    const ui = await fetch(base + "/ui");
    assert.match(await ui.text(), /Reflex Dashboard/);
  } finally {
    server.close();
    await svc.close();
  }
});

test("HTTP sidecar refuses non-loopback binding without a token and enforces tokens", async () => {
  assert.throws(() => createSidecar(service(), { host: "0.0.0.0" }), /token/);
  const server = createSidecar(service(), { token: "s3cret" });
  const { port } = await listen(server, 0);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/metrics`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(allowed.status, 200);
  } finally {
    server.close();
  }
});

test("MCP server: initialize, list tools, call reflex_decide and observe", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveMcp(service(), { input, output });
  const responses: Record<string, unknown>[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      responses.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  const waitFor = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const found = responses.find((response) => response.id === id);
      if (found) return found as { result: Record<string, unknown> };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no response for ${id}`);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const init = await waitFor(1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await waitFor(2);
  const names = (list.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(names.includes("reflex_decide") && names.includes("reflex_route_subtask"));

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reflex_decide", arguments: { point: "next_tool", state: { goal: "x" }, actions } } });
  const call = await waitFor(3);
  const decision = call.result.structuredContent as { type: string; decision_id: string };
  assert.equal(decision.type, "escalate");

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reflex_observe_choice", arguments: { decision_id: decision.decision_id, action: "web_search" } } });
  const observed = await waitFor(4);
  assert.deepEqual(observed.result.structuredContent, { ok: true });

  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal((await waitFor(5)).result.isError, true);

  send({ jsonrpc: "2.0", id: 6, method: "bogus/method" });
  assert.ok((responses.find((response) => response.id === 6) ?? (await waitFor(6))) as unknown);

  input.end();
  await done;
});
