import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RequestError, type ReflexService } from "./service.ts";
import { DASHBOARD_HTML } from "./ui.ts";

export interface SidecarOptions {
  port?: number;
  host?: string;
  /** Required for non-loopback hosts. Clients send `Authorization: Bearer <token>`. */
  token?: string;
  maxBodyBytes?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RequestError("request body too large", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestError("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(payload);
}

/** The local sidecar: HTTP/JSON API for non-TS agents, plus `/ui`. */
export function createSidecar(service: ReflexService, options: SidecarOptions = {}): Server {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && !options.token) {
    throw new Error(`Refusing to bind ${host} without a token. Pass --token or bind 127.0.0.1.`);
  }
  const limit = options.maxBodyBytes ?? 1_000_000;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(response, 200, { ok: true, workloads: service.workloads() });
      if (url.pathname === "/" || url.pathname === "/ui") return send(response, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
      if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
        return send(response, 401, { error: "unauthorized" });
      }
      const workload = url.searchParams.get("workload") ?? undefined;
      if (request.method === "GET") {
        if (url.pathname === "/v1/metrics") return send(response, 200, service.metrics(workload));
        if (url.pathname === "/v1/workloads") return send(response, 200, { workloads: service.workloads() });
        return send(response, 404, { error: "not found" });
      }
      if (request.method !== "POST") return send(response, 405, { error: "method not allowed" });
      const body = (await readBody(request, limit)) as Record<string, unknown>;
      switch (url.pathname) {
        case "/v1/decide":
          return send(response, 200, await service.decide(body as never));
        case "/v1/decide_many":
          return send(response, 200, { decisions: await service.decideMany(body as never) });
        case "/v1/observe":
          return send(response, 200, service.observe(body as never));
        case "/v1/outcome":
          return send(response, 200, service.outcome(body as never));
        case "/v1/task":
          return send(response, 200, service.task(body as never));
        case "/v1/policy/reload":
          return send(response, 200, { reloaded: service.reload(workload ?? (body.workload as string | undefined)) });
        default:
          return send(response, 404, { error: "not found" });
      }
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      send(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.keepAliveTimeout = 60_000;
  return server;
}

export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : port, host });
    });
  });
}
