/**
 * Minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Exposes Reflex decisions, feedback and metrics as MCP tools and resources.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ReflexService } from "./service.ts";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const actionSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Action identifier, e.g. read_file, web_search, frontier" },
    kind: {
      type: "string",
      enum: ["tool", "model", "retrieval", "cache", "search", "retry", "stop", "ask_user", "escalate", "custom"],
    },
    risk: { type: "string", enum: ["safe", "cheap", "costly", "stateful", "destructive"] },
    description: { type: "string" },
    params: { description: "Concrete parameters for this candidate, e.g. { path }" },
    readOnly: { type: "boolean" },
    reasoning: { type: "boolean", description: "True if choosing this means the step needs real reasoning" },
  },
  required: ["id", "kind", "risk"],
};

const decideSchema = {
  type: "object",
  properties: {
    workload: { type: "string" },
    point: { type: "string", description: "Decision point, e.g. next_tool, should_search, on_error, model_tier" },
    state: {
      type: "object",
      description: "Compact agent state: goal, lastAction, lastObservation {status,type,errorClass,text}, history",
    },
    actions: { type: "array", items: actionSchema },
    taskId: { type: "string" },
  },
  required: ["point", "actions"],
};

export const TOOLS = [
  {
    name: "reflex_decide",
    description:
      "Ask Reflex (fast local System-1) to make a routine agent decision. Returns {type:'auto', action} when confident, " +
      "or {type:'escalate', hints} when the step needs your own reasoning. Takes ~1–40 ms.",
    inputSchema: decideSchema,
  },
  {
    name: "reflex_decide_many",
    description: "Several Reflex decisions in one call (shares one model pass).",
    inputSchema: {
      type: "object",
      properties: { workload: { type: "string" }, requests: { type: "array", items: decideSchema } },
      required: ["requests"],
    },
  },
  {
    name: "reflex_observe_choice",
    description: "Tell Reflex which action you actually took after an escalation, so it learns to decide it next time.",
    inputSchema: {
      type: "object",
      properties: {
        workload: { type: "string" },
        decision_id: { type: "string" },
        action: { type: "string", description: "The action id (or candidate key) you chose" },
        taken_by: { type: "string", enum: ["frontier", "human", "rule"] },
      },
      required: ["decision_id", "action"],
    },
  },
  {
    name: "reflex_outcome",
    description: "Report the result of executing a step Reflex decided.",
    inputSchema: {
      type: "object",
      properties: {
        workload: { type: "string" },
        decision_id: { type: "string" },
        status: { type: "string", enum: ["ok", "error", "empty", "timeout"] },
        cost_usd: { type: "number" },
        latency_ms: { type: "number" },
        error_class: { type: "string" },
      },
      required: ["decision_id", "status"],
    },
  },
  {
    name: "reflex_task_outcome",
    description: "Report whether the overall task succeeded.",
    inputSchema: {
      type: "object",
      properties: {
        workload: { type: "string" },
        task_id: { type: "string" },
        success: { type: "boolean" },
        cost_usd: { type: "number" },
      },
      required: ["task_id", "success"],
    },
  },
  {
    name: "reflex_route_subtask",
    description:
      "Pick the cheapest model tier likely to handle a subtask (small / mid / frontier). Use before delegating to a subagent.",
    inputSchema: {
      type: "object",
      properties: {
        workload: { type: "string" },
        description: { type: "string" },
        tiers: { type: "array", items: { type: "string" }, description: "Default: small, mid, frontier" },
      },
      required: ["description"],
    },
  },
  {
    name: "reflex_metrics",
    description: "Reflex statistics: auto rate, escalations by reason, latency, estimated savings.",
    inputSchema: { type: "object", properties: { workload: { type: "string" } } },
  },
];

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean };

function ok(value: unknown): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
  if (value && typeof value === "object" && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

/** Strip non-essential decision fields so tool results stay small in the host model's context. */
function compact(decision: Awaited<ReturnType<ReflexService["decide"]>>): Record<string, unknown> {
  const hints = decision.hints.map((hint) => ({ action: hint.action.id, params: hint.action.params, confidence: Math.round(hint.confidence * 100) / 100 }));
  if (decision.type === "auto") {
    return { type: "auto", decision_id: decision.id, action: decision.action.id, params: decision.params, confidence: Math.round(decision.confidence * 100) / 100, source: decision.source, latency_ms: Math.round(decision.latencyMs * 10) / 10 };
  }
  return { type: "escalate", decision_id: decision.id, reason: decision.reason, detail: decision.detail, hints, shadow: decision.shadow, latency_ms: Math.round(decision.latencyMs * 10) / 10 };
}

export async function callTool(service: ReflexService, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const workload = typeof args.workload === "string" ? args.workload : undefined;
  switch (name) {
    case "reflex_decide":
      return ok(compact(await service.decide(args as never)));
    case "reflex_decide_many":
      return ok({ decisions: (await service.decideMany(args as never)).map(compact) });
    case "reflex_observe_choice":
      return ok(
        service.observe({
          workload,
          decisionId: String(args.decision_id),
          action: String(args.action),
          takenBy: (args.taken_by as "frontier" | "human" | "rule" | undefined) ?? "frontier",
        }),
      );
    case "reflex_outcome": {
      const outcome: Parameters<ReflexService["outcome"]>[0] = {
        decisionId: String(args.decision_id),
        status: args.status as "ok",
      };
      if (workload) outcome.workload = workload;
      if (typeof args.cost_usd === "number") outcome.costUsd = args.cost_usd;
      if (typeof args.latency_ms === "number") outcome.latencyMs = args.latency_ms;
      if (typeof args.error_class === "string") outcome.errorClass = args.error_class;
      return ok(service.outcome(outcome));
    }
    case "reflex_task_outcome": {
      const outcome: Parameters<ReflexService["task"]>[0] = { taskId: String(args.task_id), success: Boolean(args.success) };
      if (workload) outcome.workload = workload;
      if (typeof args.cost_usd === "number") outcome.costUsd = args.cost_usd;
      return ok(service.task(outcome));
    }
    case "reflex_route_subtask": {
      const tiers = Array.isArray(args.tiers) && args.tiers.length ? (args.tiers as string[]) : ["small", "mid", "frontier"];
      const decision = await service.decide({
        workload,
        point: "model_tier",
        state: { goal: String(args.description ?? "") },
        actions: tiers.map((tier, i) => ({ id: tier, kind: "model", risk: "cheap", reasoning: i === tiers.length - 1 })),
      });
      return ok(compact(decision));
    }
    case "reflex_metrics":
      return ok({ metrics: service.metrics(workload) });
    default:
      return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  }
}

export interface McpOptions {
  input?: Readable;
  output?: Writable;
  name?: string;
  version?: string;
}

/** Serve MCP on stdio until stdin closes. */
export function serveMcp(service: ReflexService, options: McpOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const write = (message: unknown) => output.write(JSON.stringify(message) + "\n");
  const reply = (id: JsonRpcRequest["id"], result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string) =>
    write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  const handle = async (request: JsonRpcRequest) => {
    const { id, method, params = {} } = request;
    const isNotification = id === undefined;
    try {
      switch (method) {
        case "initialize": {
          const requested = String(params.protocolVersion ?? "");
          return reply(id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: options.name ?? "reflex", version: options.version ?? "0.1.0" },
            instructions:
              "Reflex is a fast local System-1 decision runtime. For routine choices (which tool next, search or not, " +
              "retry or not, which model tier), call reflex_decide with the candidate actions. If it returns type 'auto', " +
              "take that action. If it returns 'escalate', decide yourself and then call reflex_observe_choice so Reflex learns.",
          });
        }
        case "ping":
          return isNotification ? undefined : reply(id, {});
        case "tools/list":
          return reply(id, { tools: TOOLS });
        case "tools/call": {
          const name = String(params.name ?? "");
          const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
          try {
            return reply(id, await callTool(service, name, args));
          } catch (error) {
            return reply(id, {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
        }
        case "resources/list":
          return reply(id, {
            resources: service.workloads().map((workload) => ({
              uri: `reflex://metrics/${workload}`,
              name: `Reflex metrics: ${workload}`,
              mimeType: "application/json",
            })),
          });
        case "resources/read": {
          const uri = String(params.uri ?? "");
          const match = /^reflex:\/\/metrics\/(.+)$/.exec(uri);
          if (!match) return fail(id, -32602, `Unknown resource ${uri}`);
          return reply(id, {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(service.metrics(match[1])) }],
          });
        }
        default:
          if (isNotification) return undefined;
          return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (!isNotification) fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    const inflight = new Set<Promise<unknown>>();
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        fail(null, -32700, "Parse error");
        return;
      }
      const task = handle(request);
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
    });
    lines.on("close", () => {
      void Promise.allSettled([...inflight]).then(async () => {
        await service.close();
        resolve();
      });
    });
  });
}
