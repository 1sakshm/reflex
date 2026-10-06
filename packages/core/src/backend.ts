/**
 * Tier 6: the full decision model. Backends score a set of candidate actions
 * for one decision point in a single forward pass. Laya runs behind the
 * Python sidecar in `python/reflex-laya`; any HTTP service with the same
 * contract, or an in-process function, can be used instead.
 */

export interface BackendCandidate {
  key: string;
  id: string;
  kind: string;
  description?: string;
}

export interface BackendRequest {
  point: string;
  /** Natural-language question for the decision point. */
  question: string;
  state: Record<string, unknown>;
  candidates: BackendCandidate[];
}

export interface BackendResult {
  /** Probability per candidate key. Should sum to ~1. */
  probs: Record<string, number>;
  latencyMs?: number;
  model?: string;
}

export interface DecisionBackend {
  readonly name: string;
  score(request: BackendRequest, signal?: AbortSignal): Promise<BackendResult>;
  /** Optional: score several requests in one pass (Laya can share one forward pass). */
  scoreMany?(requests: BackendRequest[], signal?: AbortSignal): Promise<BackendResult[]>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
  warmup?(): Promise<void>;
  close?(): Promise<void>;
}

export type BackendConfig =
  | { type: "none" }
  | { type: "laya"; url?: string; checkpoint?: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | DecisionBackend;

export const DEFAULT_LAYA_URL = "http://127.0.0.1:7071";

/** Talks to any service implementing `POST /v1/score` and `POST /v1/score_batch`. */
export class HttpBackend implements DecisionBackend {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly extra: Record<string, unknown>;

  constructor(url: string, options: { name?: string; headers?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
    this.url = url.replace(/\/+$/, "");
    this.name = options.name ?? `http:${this.url}`;
    this.headers = { "content-type": "application/json", ...options.headers };
    this.extra = options.extra ?? {};
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method: "POST", headers: this.headers, body: JSON.stringify(body) };
    if (signal) init.signal = signal;
    const response = await fetch(this.url + path, init);
    if (!response.ok) throw new Error(`${this.name} ${path} → HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  score(request: BackendRequest, signal?: AbortSignal): Promise<BackendResult> {
    return this.post<BackendResult>("/v1/score", { ...this.extra, ...request }, signal);
  }

  async scoreMany(requests: BackendRequest[], signal?: AbortSignal): Promise<BackendResult[]> {
    const result = await this.post<{ results: BackendResult[] }>(
      "/v1/score_batch",
      { ...this.extra, requests },
      signal,
    );
    return result.results;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(this.url + "/healthz", { signal: AbortSignal.timeout(1500) });
      return { ok: response.ok, detail: await response.text() };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Wrap a plain function as a backend (tests, custom in-process models, ONNX bindings). */
export function functionBackend(
  name: string,
  fn: (request: BackendRequest, signal?: AbortSignal) => Promise<BackendResult> | BackendResult,
): DecisionBackend {
  return {
    name,
    score: async (request, signal) => fn(request, signal),
  };
}

/**
 * Micro-batches concurrent `score` calls within a short window and sends them
 * through `scoreMany` when the inner backend supports it (cross-agent batching).
 */
export class BatchingBackend implements DecisionBackend {
  readonly name: string;
  private readonly inner: DecisionBackend;
  private readonly windowMs: number;
  private queue: { request: BackendRequest; resolve: (r: BackendResult) => void; reject: (e: unknown) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(inner: DecisionBackend, windowMs = 2) {
    this.inner = inner;
    this.windowMs = windowMs;
    this.name = `batch(${inner.name})`;
  }

  score(request: BackendRequest, signal?: AbortSignal): Promise<BackendResult> {
    if (!this.inner.scoreMany) return this.inner.score(request, signal);
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.windowMs);
    });
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    try {
      const results =
        batch.length === 1 || !this.inner.scoreMany
          ? await Promise.all(batch.map((item) => this.inner.score(item.request)))
          : await this.inner.scoreMany(batch.map((item) => item.request));
      batch.forEach((item, i) => {
        const result = results[i];
        if (result) item.resolve(result);
        else item.reject(new Error("backend returned too few results"));
      });
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }

  health(): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.health ? this.inner.health() : Promise.resolve({ ok: true });
  }
}

export function resolveBackend(config: BackendConfig | undefined): DecisionBackend | undefined {
  if (!config) return undefined;
  if ("score" in config) return config;
  switch (config.type) {
    case "none":
      return undefined;
    case "laya": {
      const options: { name: string; headers?: Record<string, string>; extra: Record<string, unknown> } = {
        name: "laya",
        extra: { checkpoint: config.checkpoint ?? "english" },
      };
      if (config.headers) options.headers = config.headers;
      return new BatchingBackend(new HttpBackend(config.url ?? DEFAULT_LAYA_URL, options));
    }
    case "http": {
      const options: { headers?: Record<string, string> } = {};
      if (config.headers) options.headers = config.headers;
      return new BatchingBackend(new HttpBackend(config.url, options));
    }
  }
}
