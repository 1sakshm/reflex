import type { ActionKind, ActionRef, ActionSpec, ParamSchema, Risk } from "./types.ts";
import { digest, stableStringify } from "./util.ts";

type ActionOptions = Partial<Omit<ActionSpec, "id" | "kind">>;

function make(kind: ActionKind, id: string, defaults: ActionOptions, options: ActionOptions): ActionSpec {
  return { id, kind, risk: "stateful", ...defaults, ...options };
}

/**
 * Helpers for declaring action spaces. Defaults are conservative: anything
 * whose risk is not stated is treated as `stateful`.
 */
export const action = {
  tool(id: string, options: ActionOptions = {}): ActionSpec {
    return make("tool", id, {}, options);
  },
  model(tier: string, options: ActionOptions = {}): ActionSpec {
    const isFrontier = /frontier|opus|large|system.?2/i.test(tier);
    return make("model", tier, { risk: "cheap", reasoning: isFrontier }, options);
  },
  frontier(options: ActionOptions = {}): ActionSpec {
    return make(
      "model",
      "frontier",
      { risk: "cheap", reasoning: true, description: "Hand this step to the frontier reasoning model" },
      options,
    );
  },
  retrieval(id = "rag", options: ActionOptions = {}): ActionSpec {
    return make("retrieval", id, { risk: "cheap", readOnly: true }, options);
  },
  cache(id = "use_cache", options: ActionOptions = {}): ActionSpec {
    return make("cache", id, { risk: "safe", readOnly: true }, options);
  },
  search(id = "web_search", options: ActionOptions = {}): ActionSpec {
    return make("search", id, { risk: "cheap", readOnly: true }, options);
  },
  retry(id = "retry", options: ActionOptions = {}): ActionSpec {
    return make("retry", id, { risk: "cheap" }, options);
  },
  stop(options: ActionOptions = {}): ActionSpec {
    return make("stop", "stop", { risk: "safe", description: "The task is complete; stop" }, options);
  },
  askUser(options: ActionOptions = {}): ActionSpec {
    return make("ask_user", "ask_user", { risk: "safe", description: "Ask the user a question" }, options);
  },
  escalate(id = "escalate", options: ActionOptions = {}): ActionSpec {
    return make("escalate", id, { risk: "safe", reasoning: true }, options);
  },
  custom(id: string, risk: Risk, options: ActionOptions = {}): ActionSpec {
    return make("custom", id, { risk }, options);
  },
  /** Same action with concrete params, e.g. `action.with(readFile, { path })`. */
  with(base: ActionSpec, params: unknown): ActionSpec {
    return { ...base, params };
  },
};

/** Stable identity of a candidate: its id plus a short digest of its params. */
export function candidateKey(spec: { id: string; params?: unknown }): string {
  if (spec.params === undefined) return spec.id;
  return spec.id + "#" + digest(stableStringify(spec.params)).slice(0, 10);
}

export function refKey(ref: ActionRef): string {
  return typeof ref === "string" ? ref : candidateKey(ref);
}

export interface Candidate {
  key: string;
  spec: ActionSpec;
  /** Key of the params as supplied, when a schema transformed them (defaults, coercion). */
  alias?: string;
}

function validateParams(schema: ParamSchema, params: unknown): { ok: boolean; data?: unknown } {
  if (schema.safeParse) {
    const result = schema.safeParse(params);
    return result.success ? { ok: true, data: result.data } : { ok: false };
  }
  if (schema.parse) {
    try {
      return { ok: true, data: schema.parse(params) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, data: params };
}

/** Deduplicate candidates and drop any whose params fail validation. */
export function normalizeCandidates(actions: readonly ActionSpec[]): {
  candidates: Candidate[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const invalid: string[] = [];
  for (const raw of actions) {
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
    let spec = raw;
    const rawKey = candidateKey(raw);
    if (raw.paramsSchema && raw.params !== undefined) {
      const result = validateParams(raw.paramsSchema, raw.params);
      if (!result.ok) {
        invalid.push(raw.id);
        continue;
      }
      if (result.data !== undefined) spec = { ...raw, params: result.data };
    }
    const key = candidateKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(rawKey !== key ? { key, spec, alias: rawKey } : { key, spec });
  }
  return { candidates, invalid };
}

/** Resolve an action reference against candidates: exact key first, then a unique id match. */
export function resolveRef(
  ref: ActionRef,
  candidates: readonly { key: string; id: string; alias?: string | undefined }[],
): string | undefined {
  const key = refKey(ref);
  if (candidates.some((candidate) => candidate.key === key)) return key;
  const aliased = candidates.find((candidate) => candidate.alias === key);
  if (aliased) return aliased.key;
  const id = typeof ref === "string" ? ref.split("#")[0] : ref.id;
  const byId = candidates.filter((candidate) => candidate.id === id);
  if (byId.length === 1) return byId[0]?.key;
  return undefined;
}
