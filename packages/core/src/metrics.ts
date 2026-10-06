import type { Decision, EscalationReason, Source } from "./types.ts";
import { percentile } from "./util.ts";

export interface MetricsSnapshot {
  workload: string;
  decisions: number;
  auto: number;
  escalated: number;
  autoRate: number;
  bySource: Partial<Record<Source, number>>;
  byReason: Partial<Record<EscalationReason, number>>;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  hedged: number;
  shadow: { labeled: number; agreed: number; wouldAuto: number; wouldAutoAgreed: number };
  tasks: { total: number; succeeded: number; successRate: number };
  estimatedSavings: { frontierCallsAvoided: number; usd: number; ms: number };
  traceDropped: number;
}

/** In-memory counters for one Reflex instance. Cheap enough to update on every decision. */
export class Metrics {
  private readonly workload: string;
  private decisions = 0;
  private auto = 0;
  private hedged = 0;
  private readonly bySource: Partial<Record<Source, number>> = {};
  private readonly byReason: Partial<Record<EscalationReason, number>> = {};
  private readonly latencies = new Float64Array(4096);
  private latencyCount = 0;
  private shadowLabeled = 0;
  private shadowAgreed = 0;
  private shadowWouldAuto = 0;
  private shadowWouldAutoAgreed = 0;
  private tasks = 0;
  private succeeded = 0;
  private avoided = 0;
  private readonly frontierUsd: number;
  private readonly frontierMs: number;

  constructor(workload: string, frontier: { costUsd: number; latencyMs: number }) {
    this.workload = workload;
    this.frontierUsd = frontier.costUsd;
    this.frontierMs = frontier.latencyMs;
  }

  recordDecision(decision: Decision): void {
    this.decisions++;
    this.latencies[this.latencyCount % this.latencies.length] = decision.latencyMs;
    this.latencyCount++;
    if (decision.hedged) this.hedged++;
    if (decision.type === "auto") {
      this.auto++;
      this.bySource[decision.source] = (this.bySource[decision.source] ?? 0) + 1;
      if (!decision.action.reasoning) this.avoided++;
    } else {
      this.byReason[decision.reason] = (this.byReason[decision.reason] ?? 0) + 1;
    }
  }

  recordShadowLabel(agreed: boolean, wouldAuto: boolean): void {
    this.shadowLabeled++;
    if (agreed) this.shadowAgreed++;
    if (wouldAuto) {
      this.shadowWouldAuto++;
      if (agreed) this.shadowWouldAutoAgreed++;
    }
  }

  recordTask(success: boolean): void {
    this.tasks++;
    if (success) this.succeeded++;
  }

  snapshot(traceDropped = 0): MetricsSnapshot {
    const n = Math.min(this.latencyCount, this.latencies.length);
    const values = Array.from(this.latencies.subarray(0, n));
    return {
      workload: this.workload,
      decisions: this.decisions,
      auto: this.auto,
      escalated: this.decisions - this.auto,
      autoRate: this.decisions ? this.auto / this.decisions : 0,
      bySource: { ...this.bySource },
      byReason: { ...this.byReason },
      latencyMs: {
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: values.length ? Math.max(...values) : 0,
      },
      hedged: this.hedged,
      shadow: {
        labeled: this.shadowLabeled,
        agreed: this.shadowAgreed,
        wouldAuto: this.shadowWouldAuto,
        wouldAutoAgreed: this.shadowWouldAutoAgreed,
      },
      tasks: { total: this.tasks, succeeded: this.succeeded, successRate: this.tasks ? this.succeeded / this.tasks : 0 },
      estimatedSavings: {
        frontierCallsAvoided: this.avoided,
        usd: this.avoided * this.frontierUsd,
        ms: this.avoided * this.frontierMs,
      },
      traceDropped,
    };
  }
}
