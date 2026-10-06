import {
  createReflex,
  workloadConfig,
  type ActionSpec,
  type DecideRequest,
  type Decision,
  type MetricsSnapshot,
  type Reflex,
  type ReflexConfig,
  type ReflexFileConfig,
  type StepOutcome,
  type TakenBy,
  type TaskOutcome,
} from "@reflex-ai/core";

export interface ServiceOptions {
  file?: ReflexFileConfig;
  defaultWorkload?: string;
  /** Applied to every workload (e.g. `mode` or `dataDir` from CLI flags). */
  overrides?: Partial<Omit<ReflexConfig, "workload">>;
}

/** Wire format of a decision: actions are plain JSON (no schema functions). */
export interface DecideBody {
  workload?: string;
  point: string;
  state?: Record<string, unknown>;
  actions: ActionSpec[];
  taskId?: string;
  stepId?: string;
  mode?: DecideRequest["mode"];
  timeoutMs?: number;
}

export class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** One Reflex instance per workload, created on first use. Shared by HTTP and MCP. */
export class ReflexService {
  private readonly instances = new Map<string, Reflex>();
  private readonly options: ServiceOptions;
  readonly defaultWorkload: string;

  constructor(options: ServiceOptions = {}) {
    this.options = options;
    this.defaultWorkload =
      options.defaultWorkload ?? Object.keys(options.file?.workloads ?? {})[0] ?? "default";
  }

  get(workload = this.defaultWorkload): Reflex {
    let reflex = this.instances.get(workload);
    if (!reflex) {
      const base: ReflexConfig = this.options.file
        ? workloadConfig(this.options.file, workload)
        : { workload };
      reflex = createReflex({ ...base, ...this.options.overrides, workload });
      this.instances.set(workload, reflex);
    }
    return reflex;
  }

  workloads(): string[] {
    const names = new Set([...Object.keys(this.options.file?.workloads ?? {}), ...this.instances.keys()]);
    return [...names];
  }

  async decide(body: DecideBody): Promise<Decision> {
    if (!body || typeof body.point !== "string") throw new RequestError("`point` is required");
    if (!Array.isArray(body.actions)) throw new RequestError("`actions` must be an array");
    const request: DecideRequest = { point: body.point, state: body.state ?? {}, actions: body.actions };
    if (body.taskId) request.taskId = body.taskId;
    if (body.stepId) request.stepId = body.stepId;
    if (body.mode) request.mode = body.mode;
    if (body.timeoutMs) request.timeoutMs = body.timeoutMs;
    return this.get(body.workload).decide(request);
  }

  async decideMany(body: { workload?: string; requests: DecideBody[] }): Promise<Decision[]> {
    if (!Array.isArray(body?.requests)) throw new RequestError("`requests` must be an array");
    return Promise.all(body.requests.map((request) => this.decide({ workload: body.workload, ...request })));
  }

  observe(body: { workload?: string; decisionId: string; action: string | { id: string; params?: unknown }; takenBy?: TakenBy }): { ok: boolean } {
    if (!body?.decisionId || body.action === undefined) throw new RequestError("`decisionId` and `action` are required");
    return { ok: this.get(body.workload).observeChoice(body.decisionId, body.action, body.takenBy ?? "frontier") };
  }

  outcome(body: StepOutcome & { workload?: string }): { ok: true } {
    if (!body?.decisionId || !body.status) throw new RequestError("`decisionId` and `status` are required");
    const { workload, ...outcome } = body;
    this.get(workload).outcome(outcome);
    return { ok: true };
  }

  task(body: TaskOutcome & { workload?: string }): { ok: true } {
    if (!body?.taskId || typeof body.success !== "boolean") throw new RequestError("`taskId` and `success` are required");
    const { workload, ...outcome } = body;
    this.get(workload).taskOutcome(outcome);
    return { ok: true };
  }

  metrics(workload?: string): MetricsSnapshot | MetricsSnapshot[] {
    if (workload) return this.get(workload).stats();
    return [...this.instances.values()].map((reflex) => reflex.stats());
  }

  reload(workload?: string): { workload: string; version: string }[] {
    const targets = workload ? [this.get(workload)] : [...this.instances.values()];
    return targets.map((reflex) => ({ workload: reflex.workload, version: reflex.reloadPolicy() }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.instances.values()].map((reflex) => reflex.close()));
  }
}
