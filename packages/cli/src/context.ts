import { homedir } from "node:os";
import { findConfigFile, listWorkloads, loadConfigFile, type ReflexFileConfig } from "@reflex-ai/core";

/** Expand a leading `~` so `--data-dir ~/.reflex` works in every shell (and from MCP configs). */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? homedir() + path.slice(1) : path;
}

export interface CliContext {
  configPath: string | undefined;
  file: ReflexFileConfig | undefined;
  dataDir: string;
  workload: string;
}

/** Resolve config file, data directory and workload from flags and the working directory. */
export async function resolveContext(flags: { workload?: string; "data-dir"?: string; config?: string }): Promise<CliContext> {
  const configPath = flags.config ?? findConfigFile();
  let file: ReflexFileConfig | undefined;
  if (configPath) {
    try {
      file = await loadConfigFile(configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /\.ts$/.test(configPath) && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(message)
        ? "This Node version can't load TypeScript configs; use Node ≥ 22.18 or rename it to reflex.config.mjs."
        : /Cannot find (package|module)/.test(message)
          ? "The config imports a package that isn't installed here; install it (npm i -D @reflex-ai/core) or use a type-only import."
          : "Fix the config file or pass --config.";
      throw new Error(`could not load ${configPath}: ${message}\n  ${hint}`);
    }
  }
  const dataDir = expandHome(flags["data-dir"] ?? file?.dataDir ?? file?.defaults?.dataDir ?? process.env.REFLEX_DATA_DIR ?? ".reflex");
  let workload = flags.workload;
  if (!workload) {
    const configured = Object.keys(file?.workloads ?? {});
    if (configured.length) workload = configured[0];
    else {
      const traced = await listWorkloads(dataDir);
      workload = traced.length === 1 ? traced[0] : "default";
    }
  }
  return { configPath, file, dataDir, workload: workload ?? "default" };
}
