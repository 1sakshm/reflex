/**
 * Simulated agent environments for ReflexBench.
 *
 * These are deliberately simple, seeded state machines. They test the
 * mechanics Reflex depends on (learning from frontier labels, calibration,
 * safe escalation, credit assignment) at the agent level. They are NOT
 * evidence about real-world savings; use the harness with a real agent for that.
 */
import { action, candidateKey, type ActionSpec, type DecisionState } from "@reflex-ai/core";

export type Rng = () => number;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: Rng, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

export interface Step {
  point: string;
  state: DecisionState;
  actions: ActionSpec[];
  /** Key of the correct action (what an always-right frontier model would choose). */
  oracle: string;
}

export interface StepResult {
  status: "ok" | "error" | "empty" | "timeout";
  /** Simulated wall-clock time of executing the action. */
  latencyMs: number;
  /** Simulated $ cost of executing the action (tools, small models). Frontier cost is added by the runner. */
  costUsd: number;
}

export interface Env {
  readonly done: boolean;
  readonly success: boolean;
  current(): Step;
  /** Execute an action. `byFrontier` = the frontier model performed this step itself. */
  step(key: string): StepResult;
}

export interface Suite {
  name: string;
  description: string;
  maxSteps: number;
  create(random: Rng, index: number): Env;
}

// ------------------------------------------------------------------ coding

const MODULES = ["auth", "billing", "date", "parser", "cache", "router", "config", "search", "upload", "session"];
const FILES = MODULES.map((m) => `src/${m}.ts`);

const readFile = action.tool("read_file", { risk: "safe", readOnly: true, description: "Read a source file" });
const runTests = action.tool("run_tests", { risk: "costly", description: "Run the test suite" });
const retryBackoff = action.retry("retry_backoff", { description: "Wait and retry the last tool call" });
const frontier = action.frontier({ description: "Reason about the code and write the fix" });
const stop = action.stop();

/**
 * A bug-fixing agent: run tests → read the failing file → (frontier) write fix → run tests → stop.
 * 30% of bugs give an ambiguous error that only the frontier model can localize.
 * Tools fail transiently 10% of the time and need a retry.
 */
class CodingEnv implements Env {
  private phase: "start" | "failing" | "located" | "edited" | "passing" | "tool_error" = "start";
  private resume: CodingEnv["phase"] = "start";
  private readonly bugFile: string;
  private readonly ambiguous: boolean;
  private readonly random: Rng;
  private readonly goal: string;
  private history: string[] = [];
  private lastAction: string | undefined;
  private lastObs: DecisionState["lastObservation"];
  done = false;
  success = false;

  constructor(random: Rng) {
    this.random = random;
    this.bugFile = pick(random, FILES);
    this.ambiguous = random() < 0.3;
    this.goal = `Fix the failing ${pick(random, ["unit", "integration", "regression"])} test in the ${pick(random, ["api", "web", "worker"])} service`;
  }

  private candidates(): ActionSpec[] {
    const files = new Set([this.bugFile]);
    while (files.size < 4) files.add(pick(this.random, FILES));
    return [...[...files].sort().map((path) => action.with(readFile, { path })), runTests, retryBackoff, frontier, stop];
  }

  private oracle(): string {
    switch (this.phase) {
      case "start":
      case "edited":
        return runTests.id;
      case "failing":
        return this.ambiguous ? frontier.id : candidateKey({ id: readFile.id, params: { path: this.bugFile } });
      case "located":
        return frontier.id;
      case "passing":
        return stop.id;
      case "tool_error":
        return retryBackoff.id;
    }
  }

  current(): Step {
    const state: DecisionState = { goal: this.goal, history: this.history.slice(-5) };
    if (this.lastAction) state.lastAction = this.lastAction;
    if (this.lastObs) state.lastObservation = this.lastObs;
    const actions = this.candidates();
    return { point: "next_action", state, actions, oracle: this.oracle() };
  }

  step(key: string): StepResult {
    const correct = key === this.oracle();
    const id = key.split("#")[0] as string;
    this.history.push(id);
    this.lastAction = id;
    const latency = id === "run_tests" ? 3000 : id === "frontier" ? 0 : 150;
    if (!correct) {
      if (id === "stop") {
        this.done = true;
        this.success = false;
        return { status: "ok", latencyMs: 10, costUsd: 0 };
      }
      this.lastObs = { status: "empty", type: "no_progress", text: `${id} did not help` };
      return { status: "empty", latencyMs: latency, costUsd: 0 };
    }
    if (id !== "frontier" && id !== "stop" && id !== "retry_backoff" && this.random() < 0.1) {
      this.resume = this.phase;
      this.phase = "tool_error";
      this.lastObs = { status: "error", type: "tool_error", errorClass: pick(this.random, ["Timeout", "RateLimit"]), text: "tool call failed" };
      return { status: "error", latencyMs: latency, costUsd: 0 };
    }
    switch (this.phase) {
      case "tool_error":
        this.phase = this.resume;
        this.lastObs = { status: "ok", type: "retried", text: "retry succeeded" };
        return this.redo();
      case "start":
        this.phase = "failing";
        this.lastObs = this.failure();
        break;
      case "failing":
        this.phase = "located";
        this.lastObs = { status: "ok", type: "file_contents", text: `${this.bugFile} contents, suspicious branch at line ${Math.floor(this.random() * 300)}` };
        break;
      case "located":
        this.phase = "edited";
        this.lastObs = { status: "ok", type: "edited", text: `patched ${this.bugFile}` };
        break;
      case "edited":
        this.phase = "passing";
        this.lastObs = { status: "ok", type: "tests_passed", text: "all tests passed" };
        break;
      case "passing":
        this.done = true;
        this.success = true;
        break;
    }
    return { status: "ok", latencyMs: latency, costUsd: 0 };
  }

  /** After a successful retry, the original tool call's effect happens. */
  private redo(): StepResult {
    const phase = this.phase;
    if (phase === "start") {
      this.phase = "failing";
      this.lastObs = this.failure();
    } else if (phase === "failing") {
      this.phase = "located";
      this.lastObs = { status: "ok", type: "file_contents", text: `${this.bugFile} contents` };
    } else if (phase === "edited") {
      this.phase = "passing";
      this.lastObs = { status: "ok", type: "tests_passed", text: "all tests passed" };
    }
    return { status: "ok", latencyMs: 150, costUsd: 0 };
  }

  private failure(): DecisionState["lastObservation"] {
    if (this.ambiguous) {
      return { status: "error", type: "test_failed", errorClass: "AssertionError", text: `expected ${Math.floor(this.random() * 9)} but received ${Math.floor(this.random() * 9)}` };
    }
    const errorClass = pick(this.random, ["ImportError", "TypeError", "ReferenceError"]);
    return { status: "error", type: "test_failed", errorClass, text: `${errorClass} at ${this.bugFile}:${Math.floor(this.random() * 300)}` };
  }
}

export const codingSuite: Suite = {
  name: "sim-coding",
  description: "Bug-fixing agent: tests → locate file → frontier edit → tests → stop; 30% ambiguous bugs; 10% transient tool errors.",
  maxSteps: 20,
  create: (random) => new CodingEnv(random),
};

// ------------------------------------------------------------------ support

const INTENTS = {
  faq: { words: ["password", "reset", "hours", "shipping", "address", "invoice copy"], route: "cached_answer" },
  kb: { words: ["configure", "integration", "webhook", "export", "api limits", "sso setup"], route: "rag_small_model" },
  complex: { words: ["outage", "data looks wrong", "migration", "contract terms", "bug in report"], route: "frontier" },
  human: { words: ["refund", "cancel my account", "legal", "chargeback", "angry"], route: "human_agent" },
} as const;

const supportActions: ActionSpec[] = [
  action.cache("cached_answer", { description: "Answer from the FAQ cache" }),
  action.retrieval("rag_small_model", { description: "Retrieve docs and answer with a small model" }),
  action.frontier({ description: "Answer with the frontier model" }),
  action.custom("human_agent", "safe", { description: "Hand off to a human agent" }),
];

/** One-step routing: answer from cache / RAG+small model / frontier / human. Wrong cheap routes fail the ticket. */
class SupportEnv implements Env {
  private readonly intent: keyof typeof INTENTS;
  private readonly message: string;
  done = false;
  success = false;

  constructor(random: Rng) {
    const roll = random();
    this.intent = roll < 0.4 ? "faq" : roll < 0.7 ? "kb" : roll < 0.9 ? "complex" : "human";
    const filler = pick(random, ["hi team,", "hello,", "quick question:", "urgent:", "hey -"]);
    const words = INTENTS[this.intent].words;
    this.message = `${filler} ${pick(random, words)} ${pick(random, ["please help", "thanks", "asap", "for our workspace", ""])}`.trim();
  }

  current(): Step {
    return {
      point: "route_ticket",
      state: { goal: "resolve the customer's ticket", lastObservation: { type: "customer_message", text: this.message }, channel: "email" },
      actions: supportActions,
      oracle: INTENTS[this.intent].route,
    };
  }

  step(key: string): StepResult {
    this.done = true;
    this.success = key === INTENTS[this.intent].route ||
      // A more capable route still resolves easier tickets, just at higher cost.
      (key === "frontier" && (this.intent === "faq" || this.intent === "kb"));
    const cost = key === "rag_small_model" ? 0.002 : key === "human_agent" ? 0.5 : 0;
    const latency = key === "cached_answer" ? 5 : key === "rag_small_model" ? 400 : key === "human_agent" ? 60_000 : 0;
    return { status: this.success ? "ok" : "error", latencyMs: latency, costUsd: cost };
  }
}

export const supportSuite: Suite = {
  name: "sim-support",
  description: "Support triage: FAQ cache / RAG + small model / frontier / human, from the customer message.",
  maxSteps: 1,
  create: (random) => new SupportEnv(random),
};

export const SUITES: Record<string, Suite> = {
  [codingSuite.name]: codingSuite,
  [supportSuite.name]: supportSuite,
};
