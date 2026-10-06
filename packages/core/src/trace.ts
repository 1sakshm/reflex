import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EncodedState } from "./encoder.ts";
import type { EscalationReason, Mode, Risk, Source, TakenBy } from "./types.ts";
import { sanitizeName, stableStringify } from "./util.ts";

export interface TraceCandidate {
  key: string;
  id: string;
  kind: string;
  risk: Risk;
  reasoning?: boolean;
  params?: unknown;
  prob?: number;
}

export interface DecisionEvent {
  ev: "decision";
  id: string;
  ts: string;
  workload: string;
  point: string;
  taskId?: string;
  stepId?: string;
  policyVersion: string;
  mode: Mode;
  stateDigest: string;
  state?: EncodedState;
  candidates: TraceCandidate[];
  rulesApplied: string[];
  source: Source;
  outcome: "auto" | "escalate";
  chosen?: string;
  confidence?: number;
  margin?: number;
  reason?: EscalationReason;
  detail?: string;
  /** What Reflex would have done (shadow/assist), for agreement measurement. */
  wouldChoose?: string;
  wouldAuto?: boolean;
  difficulty?: number;
  hedged?: boolean;
  latencyMs: number;
  backend?: string;
}

export interface ChoiceEvent {
  ev: "choice";
  ts: string;
  workload: string;
  decisionId: string;
  /** Candidate key, or `other:<ref>` when outside the action space. */
  action: string;
  takenBy: TakenBy;
}

export interface OutcomeEvent {
  ev: "outcome";
  ts: string;
  workload: string;
  decisionId: string;
  status: "ok" | "error" | "empty" | "timeout";
  takenBy?: TakenBy;
  latencyMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorClass?: string;
}

export interface TaskEvent {
  ev: "task";
  ts: string;
  workload: string;
  taskId: string;
  success: boolean;
  score?: number;
  costUsd?: number;
  latencyMs?: number;
  frontierCalls?: number;
  tokens?: number;
  feedback?: string;
}

export type TraceEvent = DecisionEvent | ChoiceEvent | OutcomeEvent | TaskEvent;

export interface TraceSink {
  write(event: TraceEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly dropped: number;
}

export class MemorySink implements TraceSink {
  readonly events: TraceEvent[] = [];
  dropped = 0;
  write(event: TraceEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class NullSink implements TraceSink {
  dropped = 0;
  write(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export function traceDir(dataDir: string, workload: string): string {
  return join(dataDir, "traces", sanitizeName(workload));
}

const liveSinks = new Set<JsonlSink>();
let exitHooksInstalled = false;

/** Flush buffered traces when the process winds down, even if the caller never calls close(). */
function installExitHooks(): void {
  if (exitHooksInstalled || typeof process === "undefined" || !process.on) return;
  exitHooksInstalled = true;
  process.on("beforeExit", () => {
    for (const sink of liveSinks) void sink.flush();
  });
  process.on("exit", () => {
    for (const sink of liveSinks) sink.flushSync();
  });
}

/**
 * Append-only JSONL, one file per day. Writes are buffered and flushed on a
 * timer off the decision path; a bounded queue drops (and counts) on overload.
 */
export class JsonlSink implements TraceSink {
  private readonly dir: string;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly maxQueue: number;
  private readonly flushMs: number;
  private ready: Promise<unknown>;
  dropped = 0;
  errors = 0;

  constructor(dataDir: string, workload: string, options: { maxQueue?: number; flushMs?: number; retentionDays?: number } = {}) {
    this.dir = traceDir(dataDir, workload);
    this.maxQueue = options.maxQueue ?? 50_000;
    this.flushMs = options.flushMs ?? 50;
    this.ready = mkdir(this.dir, { recursive: true }).then(() =>
      options.retentionDays ? this.prune(options.retentionDays) : undefined,
    );
    this.ready.catch(() => this.errors++);
    liveSinks.add(this);
    installExitHooks();
  }

  private file(): string {
    return join(this.dir, new Date().toISOString().slice(0, 10) + ".jsonl");
  }

  /** Last-chance synchronous write used on process exit. */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(), this.buffer.join("\n") + "\n");
      this.buffer = [];
    } catch {
      this.errors++;
    }
  }

  private async prune(days: number): Promise<void> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    for (const name of await readdir(this.dir)) {
      if (name.endsWith(".jsonl") && name.slice(0, 10) < cutoff) await unlink(join(this.dir, name)).catch(() => {});
    }
  }

  write(event: TraceEvent): void {
    if (this.buffer.length >= this.maxQueue) {
      this.dropped++;
      return;
    }
    // stableStringify never throws (BigInt, cycles) and always yields valid JSON.
    this.buffer.push(stableStringify(event));
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      // Never keep the process alive just to write traces.
      this.timer.unref?.();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return this.chain;
    const lines = this.buffer;
    this.buffer = [];
    const file = this.file();
    this.chain = this.chain
      .then(() => this.ready)
      .then(() => appendFile(file, lines.join("\n") + "\n"))
      .catch(() => {
        this.errors++;
      });
    return this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
    liveSinks.delete(this);
  }
}

/** Read all trace events for a workload, oldest first. Skips malformed lines. */
export async function readTraceEvents(
  dataDir: string,
  workload: string,
  options: { sinceDays?: number } = {},
): Promise<TraceEvent[]> {
  const dir = traceDir(dataDir, workload);
  if (!existsSync(dir)) return [];
  const cutoff = options.sinceDays
    ? new Date(Date.now() - options.sinceDays * 86_400_000).toISOString().slice(0, 10)
    : "";
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl") && name.slice(0, 10) >= cutoff).sort();
  const events: TraceEvent[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TraceEvent);
      } catch {
        // tolerate partial lines from crashes
      }
    }
  }
  return events;
}

export async function listWorkloads(dataDir: string): Promise<string[]> {
  const dir = join(dataDir, "traces");
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
