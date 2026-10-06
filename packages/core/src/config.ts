import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackendConfig } from "./backend.ts";
import type { RedactionOptions } from "./redact.ts";
import type { Rule } from "./rules.ts";
import type { BudgetConfig } from "./tasks.ts";
import type { TraceSink } from "./trace.ts";
import type { Mode, Risk } from "./types.ts";

export type SpeedMode = "cost-first" | "balanced" | "latency-first";

export interface PointConfig {
  mode?: Mode;
  /** Question shown to the full-model backend for this decision point. */
  question?: string;
  thresholds?: Partial<Record<Risk, number | "never">>;
}

export interface ReflexConfig {
  workload: string;
  mode?: Mode;
  /** Where traces and policies live. Default `.reflex` in the working directory. */
  dataDir?: string;
  backend?: BackendConfig;
  /** Hard cap per decision; on timeout Reflex escalates. Default 75 ms. */
  timeoutMs?: number;
  /** Auto-execute thresholds per risk class. Override learned thresholds. */
  thresholds?: Partial<Record<Risk, number | "never">>;
  /** Learned thresholds can never go below these. */
  floors?: Partial<Record<Risk, number>>;
  /** Minimum gap between the top two candidates to auto-decide. Default 0.1. */
  minMargin?: number;
  /** Allow auto-executing `stateful` actions (writes, edits). Default false. */
  allowStateful?: boolean;
  /** Allow `destructive` actions when a `force` rule names them. Default false. Never auto otherwise. */
  allowDestructive?: boolean;
  budgets?: BudgetConfig;
  rules?: Rule[];
  points?: Record<string, PointConfig>;
  tiers?: { cache?: boolean; patterns?: boolean; head?: boolean; backend?: boolean };
  speed?: {
    mode?: SpeedMode;
    /** Difficulty above which Reflex escalates without running the full model. Default 0.85. */
    earlyEscalate?: number;
    /** Difficulty above which `onHedge` fires before the full model. Derived from `mode` if unset. */
    hedgeEscalation?: number;
    speculativeSafeActions?: boolean;
  };
  learning?: {
    /** Update the in-memory policy from labels and outcomes as they arrive. Default true. */
    online?: boolean;
    /** Labeled examples per point before the head tier is trusted. Default 20. */
    minExamples?: number;
    /** Minimum observations before the pattern tier is trusted. Default 3. */
    minPatternSupport?: number;
    /** Minimum observations of an exact state before the cache tier is trusted. Default 3. */
    minCacheSupport?: number;
    /**
     * In auto mode, escalate 1 in every 1/auditRate confident decisions anyway (reason "audit")
     * so Reflex keeps receiving labels: live precision, drift and contradiction detection.
     * Deterministic per decision point. Default 0.02 (1 in 50). 0 disables.
     */
    auditRate?: number;
    /** Familiarity below which a state counts as out of distribution. Default 0.5. */
    minFamiliarity?: number;
    /** Load the promoted policy from the registry at startup. Default true. */
    loadPolicy?: boolean;
  };
  storage?: {
    traces?: boolean;
    stateEncoding?: "redacted" | "digest";
    retentionDays?: number;
  };
  privacy?: { redactSecrets?: boolean; redactPatterns?: string[]; redactKeys?: string[] };
  /** Typical cost of one frontier step, for savings estimates. */
  frontier?: { costUsd?: number; latencyMs?: number };
  /** Throw internal errors instead of failing open. For tests only. */
  strict?: boolean;
  sink?: TraceSink;
}

/** File format for `reflex.config.{ts,mjs,js,json}`: shared defaults plus per-workload overrides. */
export interface ReflexFileConfig {
  dataDir?: string;
  defaults?: Omit<ReflexConfig, "workload">;
  workloads: Record<string, Omit<ReflexConfig, "workload">>;
}

export function defineConfig<T extends ReflexFileConfig | ReflexConfig>(config: T): T {
  return config;
}

export const DEFAULT_THRESHOLDS: Record<Risk, number | "never"> = {
  safe: 0.7,
  cheap: 0.8,
  costly: 0.9,
  stateful: 0.97,
  destructive: "never",
};

export const DEFAULT_FLOORS: Record<Risk, number> = {
  safe: 0.6,
  cheap: 0.75,
  costly: 0.85,
  stateful: 0.95,
  destructive: 1,
};

const HEDGE_BY_MODE: Record<SpeedMode, number> = {
  "cost-first": Infinity,
  balanced: 0.6,
  "latency-first": 0.3,
};

export interface ResolvedConfig {
  workload: string;
  mode: Mode;
  /** Kill switch (`REFLEX_DISABLE=1`): overrides every per-call and per-point mode. */
  disabled: boolean;
  /** `REFLEX_MODE` from the environment: overrides per-call and per-point modes too. */
  envMode: Mode | undefined;
  dataDir: string;
  backend: BackendConfig | undefined;
  timeoutMs: number;
  thresholds: Partial<Record<Risk, number | "never">>;
  floors: Record<Risk, number>;
  minMargin: number;
  allowStateful: boolean;
  allowDestructive: boolean;
  budgets: BudgetConfig;
  rules: Rule[];
  points: Record<string, PointConfig>;
  tiers: { cache: boolean; patterns: boolean; head: boolean; backend: boolean };
  speed: { mode: SpeedMode; earlyEscalate: number; hedgeEscalation: number; speculativeSafeActions: boolean };
  learning: {
    online: boolean;
    minExamples: number;
    minPatternSupport: number;
    minCacheSupport: number;
    auditRate: number;
    minFamiliarity: number;
    loadPolicy: boolean;
  };
  storage: { traces: boolean; stateEncoding: "redacted" | "digest"; retentionDays: number };
  privacy: RedactionOptions;
  frontier: { costUsd: number; latencyMs: number };
  strict: boolean;
  sink: TraceSink | undefined;
}

function envMode(): Mode | undefined {
  const env = typeof process !== "undefined" ? process.env : {};
  if (env.REFLEX_DISABLE === "1" || env.REFLEX_DISABLE === "true") return "off";
  const mode = env.REFLEX_MODE;
  return mode === "off" || mode === "shadow" || mode === "assist" || mode === "auto" ? mode : undefined;
}

export function resolveConfig(config: ReflexConfig): ResolvedConfig {
  if (!config.workload) throw new Error("Reflex config requires a `workload` name");
  const speedMode = config.speed?.mode ?? "balanced";
  const privacy: RedactionOptions = { enabled: config.privacy?.redactSecrets !== false };
  if (config.privacy?.redactPatterns) privacy.patterns = config.privacy.redactPatterns;
  if (config.privacy?.redactKeys) privacy.keys = config.privacy.redactKeys;
  const forced = envMode();
  return {
    workload: config.workload,
    mode: forced ?? config.mode ?? "shadow",
    disabled: forced === "off",
    envMode: forced,
    dataDir: config.dataDir ?? (typeof process !== "undefined" ? process.env.REFLEX_DATA_DIR : undefined) ?? ".reflex",
    backend: config.backend,
    timeoutMs: config.timeoutMs ?? 75,
    thresholds: config.thresholds ?? {},
    floors: { ...DEFAULT_FLOORS, ...config.floors },
    minMargin: config.minMargin ?? 0.1,
    allowStateful: config.allowStateful ?? false,
    allowDestructive: config.allowDestructive ?? false,
    budgets: { loopWindow: 3, ...config.budgets },
    rules: config.rules ?? [],
    points: config.points ?? {},
    tiers: {
      cache: config.tiers?.cache ?? true,
      patterns: config.tiers?.patterns ?? true,
      head: config.tiers?.head ?? true,
      backend: config.tiers?.backend ?? true,
    },
    speed: {
      mode: speedMode,
      earlyEscalate: config.speed?.earlyEscalate ?? 0.85,
      hedgeEscalation: config.speed?.hedgeEscalation ?? HEDGE_BY_MODE[speedMode],
      speculativeSafeActions: config.speed?.speculativeSafeActions ?? true,
    },
    learning: {
      online: config.learning?.online ?? true,
      minExamples: config.learning?.minExamples ?? 20,
      minPatternSupport: config.learning?.minPatternSupport ?? 3,
      minCacheSupport: config.learning?.minCacheSupport ?? 3,
      auditRate: config.learning?.auditRate ?? 0.02,
      minFamiliarity: config.learning?.minFamiliarity ?? 0.5,
      loadPolicy: config.learning?.loadPolicy ?? true,
    },
    storage: {
      traces: config.storage?.traces ?? true,
      stateEncoding: config.storage?.stateEncoding ?? "redacted",
      retentionDays: config.storage?.retentionDays ?? 30,
    },
    privacy,
    frontier: { costUsd: config.frontier?.costUsd ?? 0.03, latencyMs: config.frontier?.latencyMs ?? 3000 },
    strict: config.strict ?? false,
    sink: config.sink,
  };
}

const CONFIG_NAMES = ["reflex.config.ts", "reflex.config.mjs", "reflex.config.js", "reflex.config.json"];

export function findConfigFile(cwd = process.cwd()): string | undefined {
  for (const name of CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Load a config file. `.ts` configs rely on Node's built-in type stripping (Node ≥ 22.18). */
export async function loadConfigFile(path: string): Promise<ReflexFileConfig> {
  if (path.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8")) as ReflexFileConfig;
  }
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  const config = (mod.default ?? mod) as ReflexFileConfig | ReflexConfig;
  if ("workloads" in config) return config;
  const { workload, ...rest } = config;
  return { workloads: { [workload]: rest } };
}

/** Merge file defaults with one workload's overrides. */
export function workloadConfig(file: ReflexFileConfig, workload: string): ReflexConfig {
  const base = file.defaults ?? {};
  const own = file.workloads[workload] ?? {};
  const merged: ReflexConfig = { ...base, ...own, workload };
  const dataDir = own.dataDir ?? base.dataDir ?? file.dataDir;
  if (dataDir) merged.dataDir = dataDir;
  return merged;
}
