import { LRU } from "./util.ts";

export interface BudgetConfig {
  maxStepsPerTask?: number;
  maxUsdPerTask?: number;
  maxFrontierCallsPerTask?: number;
  maxRetriesPerAction?: number;
  maxWallClockMs?: number;
  /** Escalate when the same action would be auto-chosen this many times in a row. */
  loopWindow?: number;
}

export interface TaskSnapshot {
  taskId: string;
  steps: number;
  costUsd: number;
  frontierCalls: number;
  elapsedMs: number;
  recentKeys: string[];
  retries: Record<string, number>;
}

interface TaskRecord {
  taskId: string;
  steps: number;
  costUsd: number;
  frontierCalls: number;
  startedAt: number;
  recentKeys: string[];
  retries: Map<string, number>;
  autoDecisions: string[];
}

/** In-memory per-task counters used for budgets, loop detection and credit assignment. */
export class TaskTracker {
  private readonly tasks = new LRU<string, TaskRecord>(10_000);

  private record(taskId: string): TaskRecord {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = {
        taskId,
        steps: 0,
        costUsd: 0,
        frontierCalls: 0,
        startedAt: Date.now(),
        recentKeys: [],
        retries: new Map(),
        autoDecisions: [],
      };
      this.tasks.set(taskId, task);
    }
    return task;
  }

  snapshot(taskId: string): TaskSnapshot {
    const task = this.record(taskId);
    return {
      taskId,
      steps: task.steps,
      costUsd: task.costUsd,
      frontierCalls: task.frontierCalls,
      elapsedMs: Date.now() - task.startedAt,
      recentKeys: [...task.recentKeys],
      retries: Object.fromEntries(task.retries),
    };
  }

  onDecide(taskId: string): void {
    this.record(taskId).steps++;
  }

  onChosen(taskId: string, key: string, kind: string, decisionId?: string): void {
    const task = this.record(taskId);
    task.recentKeys.push(key);
    if (task.recentKeys.length > 16) task.recentKeys.shift();
    if (kind === "retry") task.retries.set(key, (task.retries.get(key) ?? 0) + 1);
    if (decisionId) task.autoDecisions.push(decisionId);
  }

  onCost(taskId: string, costUsd: number, frontier: boolean): void {
    const task = this.record(taskId);
    task.costUsd += costUsd;
    if (frontier) task.frontierCalls++;
  }

  autoDecisions(taskId: string): string[] {
    return [...(this.tasks.peek(taskId)?.autoDecisions ?? [])];
  }

  end(taskId: string): void {
    this.tasks.delete(taskId);
  }
}

/** Returns a human-readable reason when a budget is exhausted. */
export function checkBudget(task: TaskSnapshot, budget: BudgetConfig): string | undefined {
  if (budget.maxStepsPerTask !== undefined && task.steps > budget.maxStepsPerTask) {
    return `step budget exhausted (${task.steps} > ${budget.maxStepsPerTask})`;
  }
  if (budget.maxUsdPerTask !== undefined && task.costUsd >= budget.maxUsdPerTask) {
    return `cost budget exhausted ($${task.costUsd.toFixed(4)} ≥ $${budget.maxUsdPerTask})`;
  }
  if (budget.maxFrontierCallsPerTask !== undefined && task.frontierCalls >= budget.maxFrontierCallsPerTask) {
    return `frontier-call budget exhausted (${task.frontierCalls})`;
  }
  if (budget.maxWallClockMs !== undefined && task.elapsedMs >= budget.maxWallClockMs) {
    return `wall-clock budget exhausted (${task.elapsedMs} ms)`;
  }
  return undefined;
}

/** True if choosing `key` now would make it the `window`-th identical choice in a row. */
export function isLoop(task: TaskSnapshot, key: string, window: number): boolean {
  if (window <= 1) return false;
  const previous = window - 1;
  if (task.recentKeys.length < previous) return false;
  return task.recentKeys.slice(-previous).every((recent) => recent === key);
}
