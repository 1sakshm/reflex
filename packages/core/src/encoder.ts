import type { DecisionState, Observation } from "./types.ts";
import type { Redactor } from "./redact.ts";
import { digest, stableStringify, tokenize, truncate } from "./util.ts";

/** Compact, redacted state that is stored in traces and fed to the model tiers. */
export interface EncodedState {
  goal?: string;
  lastAction?: string;
  obs?: { status?: string; type?: string; errorClass?: string; text?: string };
  history?: string[];
  stepsSinceProgress?: number;
  extra?: Record<string, string | number | boolean>;
}

/** Everything the local tiers need, computed once per decision. */
export interface Features {
  encoded: EncodedState;
  tokens: string[];
  /** Coarse situation signature used by the pattern table. */
  signature: string;
  /** Exact-match key for the decision cache. */
  stateDigest: string;
}

export interface EncoderLimits {
  goalChars: number;
  obsChars: number;
  historyItems: number;
  extraKeys: number;
  /** Rough token budget for the encoded state (PRD: ≤ 256). */
  maxTokens: number;
}

export const DEFAULT_LIMITS: EncoderLimits = {
  goalChars: 240,
  obsChars: 480,
  historyItems: 6,
  extraKeys: 12,
  maxTokens: 256,
};

const RESERVED = new Set(["goal", "lastAction", "lastObservation", "history", "stepsSinceProgress"]);

function normalizeObservation(obs: Observation | string | undefined): Observation | undefined {
  if (obs === undefined || obs === null) return undefined;
  if (typeof obs === "string") return { text: obs };
  return obs;
}

export function encodeState(
  state: DecisionState,
  redactor: Redactor,
  limits: EncoderLimits = DEFAULT_LIMITS,
): EncodedState {
  const encoded: EncodedState = {};
  if (typeof state.goal === "string" && state.goal) {
    encoded.goal = truncate(redactor.text(state.goal), limits.goalChars);
  }
  if (typeof state.lastAction === "string" && state.lastAction) encoded.lastAction = state.lastAction;
  const obs = normalizeObservation(state.lastObservation);
  if (obs) {
    const out: NonNullable<EncodedState["obs"]> = {};
    if (obs.status) out.status = String(obs.status);
    if (obs.type) out.type = String(obs.type);
    if (obs.errorClass) out.errorClass = String(obs.errorClass);
    if (obs.text) out.text = truncate(redactor.text(String(obs.text)), limits.obsChars);
    encoded.obs = out;
  }
  if (Array.isArray(state.history) && state.history.length) {
    encoded.history = state.history
      .slice(-limits.historyItems)
      .map((item) => (typeof item === "string" ? item : item.status ? `${item.action}:${item.status}` : item.action));
  }
  if (typeof state.stepsSinceProgress === "number") encoded.stepsSinceProgress = state.stepsSinceProgress;
  const extra: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(state)) {
    if (RESERVED.has(key) || count >= limits.extraKeys) continue;
    if (redactor.isSecretKey(key)) {
      extra[key] = "[REDACTED]";
      count++;
      continue;
    }
    if (typeof value === "string") extra[key] = truncate(redactor.text(value), 120);
    else if (typeof value === "number" || typeof value === "boolean") extra[key] = value;
    else continue;
    count++;
  }
  if (count) encoded.extra = extra;
  return encoded;
}

function bucket(n: number): string {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 7) return "4-7";
  return "8+";
}

/** Turn an encoded state into features. Deterministic: the same input gives the same features. */
export function featurize(encoded: EncodedState, limits: EncoderLimits = DEFAULT_LIMITS): Features {
  const tokens: string[] = [];
  const push = (token: string) => {
    if (tokens.length < limits.maxTokens) tokens.push(token);
  };
  if (encoded.lastAction) push("la:" + encoded.lastAction);
  if (encoded.obs?.status) push("st:" + encoded.obs.status);
  if (encoded.obs?.type) push("ty:" + encoded.obs.type);
  if (encoded.obs?.errorClass) push("ec:" + encoded.obs.errorClass);
  if (encoded.history) {
    for (const item of encoded.history) push("h:" + item);
    const last = encoded.history[encoded.history.length - 1];
    if (last) push("hl:" + last);
  }
  if (encoded.stepsSinceProgress !== undefined) push("sp:" + bucket(encoded.stepsSinceProgress));
  if (encoded.extra) {
    for (const [key, value] of Object.entries(encoded.extra)) {
      if (typeof value === "string") {
        if (value.length <= 40) push(`x:${key}=${value.toLowerCase()}`);
        for (const token of tokenize(value, 8)) push(`x:${key}:${token}`);
      } else if (typeof value === "boolean") push(`x:${key}=${value}`);
      else push(`x:${key}=${bucket(value)}`);
    }
  }
  for (const token of tokenize(encoded.obs?.text ?? "", 48)) push("o:" + token);
  for (const token of tokenize(encoded.goal ?? "", 24)) push("g:" + token);

  const signature = [
    encoded.lastAction ?? "-",
    encoded.obs?.status ?? "-",
    encoded.obs?.errorClass ?? encoded.obs?.type ?? "-",
  ].join("|");
  return { encoded, tokens, signature, stateDigest: digest(stableStringify(encoded)) };
}

/** Plain-text rendering used by the full-model backend (Laya) and hint formatting. */
export function renderState(encoded: EncodedState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (encoded.goal) out.goal = encoded.goal;
  if (encoded.lastAction) out.last_action = encoded.lastAction;
  if (encoded.obs) out.last_observation = encoded.obs;
  if (encoded.history) out.recent_actions = encoded.history;
  if (encoded.stepsSinceProgress !== undefined) out.steps_since_progress = encoded.stepsSinceProgress;
  if (encoded.extra) Object.assign(out, encoded.extra);
  return out;
}
