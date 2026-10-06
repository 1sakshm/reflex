/** Public types for the Reflex runtime. */

/** How bad a wrong auto-decision can be. Drives auto-execute thresholds. */
export type Risk = "safe" | "cheap" | "costly" | "stateful" | "destructive";

export const RISKS: readonly Risk[] = ["safe", "cheap", "costly", "stateful", "destructive"];

export type ActionKind =
  | "tool"
  | "model"
  | "retrieval"
  | "cache"
  | "search"
  | "retry"
  | "stop"
  | "ask_user"
  | "escalate"
  | "custom";

/** Anything with Zod-style `safeParse` or a throwing `parse` can validate params. */
export interface ParamSchema {
  safeParse?(value: unknown): { success: boolean; data?: unknown; error?: unknown };
  parse?(value: unknown): unknown;
}

/** A typed option the agent can take at a decision point. */
export interface ActionSpec {
  id: string;
  kind: ActionKind;
  risk: Risk;
  description?: string;
  /** Concrete parameters for this candidate (e.g. which file to read). */
  params?: unknown;
  paramsSchema?: ParamSchema;
  /** Read-only and idempotent: eligible for speculative execution and prefetch. */
  readOnly?: boolean;
  /** Choosing this action means "this step needs real reasoning" (System 2). */
  reasoning?: boolean;
  /** Priors used for savings estimates. */
  costUsd?: number;
  latencyMs?: number;
}

export type Mode = "off" | "shadow" | "assist" | "auto";

export interface Observation {
  status?: "ok" | "error" | "empty" | "timeout" | (string & {});
  type?: string;
  errorClass?: string;
  text?: string;
}

export type HistoryItem = string | { action: string; status?: string };

/** Conventional agent state fields. Any extra scalar fields are also used as features. */
export interface DecisionState {
  goal?: string;
  lastAction?: string;
  lastObservation?: Observation | string;
  history?: HistoryItem[];
  stepsSinceProgress?: number;
  [key: string]: unknown;
}

export interface HedgeInfo {
  decisionId: string;
  point: string;
  /** Probability that this step needs System 2. */
  difficulty: number;
}

export interface DecideRequest {
  point: string;
  state: DecisionState;
  actions: ActionSpec[];
  taskId?: string;
  stepId?: string;
  mode?: Mode;
  timeoutMs?: number;
  /**
   * Called before the slow full-model tier when the step is likely to escalate.
   * Start the frontier call in parallel; cancel it if the decision comes back `auto`.
   */
  onHedge?: (info: HedgeInfo) => void;
  signal?: AbortSignal;
}

export interface Hint {
  key: string;
  action: ActionSpec;
  confidence: number;
}

/** Which ladder tier produced a decision. */
export type Source = "rule" | "cache" | "pattern" | "head" | "model" | "fallback";

export type EscalationReason =
  | "low_confidence"
  | "risk"
  | "rule"
  | "ood"
  | "timeout"
  | "internal_error"
  | "budget"
  | "mode"
  | "difficulty"
  | "loop"
  | "no_candidates"
  | "audit";

interface DecisionBase {
  id: string;
  point: string;
  hints: Hint[];
  latencyMs: number;
  policyVersion: string;
  hedged: boolean;
  difficulty?: number;
}

export interface AutoDecision extends DecisionBase {
  type: "auto";
  action: ActionSpec;
  key: string;
  params?: unknown;
  confidence: number;
  margin: number;
  source: Source;
  reason: string;
}

export interface EscalateDecision extends DecisionBase {
  type: "escalate";
  reason: EscalationReason;
  detail: string;
  /** In shadow/assist mode: what Reflex would have done in auto mode. */
  shadow?: { key: string; action: string; confidence: number; source: Source; wouldAuto: boolean };
}

export type Decision = AutoDecision | EscalateDecision;

/** Reference to the action that was actually taken. */
export type ActionRef = string | { id: string; params?: unknown };

export type TakenBy = "reflex" | "frontier" | "human" | "rule";

export interface StepOutcome {
  decisionId: string;
  status: "ok" | "error" | "empty" | "timeout";
  latencyMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorClass?: string;
  takenBy?: TakenBy;
}

export interface TaskOutcome {
  taskId: string;
  success: boolean;
  score?: number;
  costUsd?: number;
  latencyMs?: number;
  frontierCalls?: number;
  tokens?: number;
  feedback?: string;
}
