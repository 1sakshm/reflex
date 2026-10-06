#!/usr/bin/env node
import { parseArgs } from "node:util";
import { VERSION } from "@reflex-ai/core";
import * as commands from "./commands.ts";

const HELP = `reflex: the System-1 decision runtime for AI agents

Usage: reflex <command> [options]

Setup
  init [--js]          Write reflex.config.ts (or .mjs) in shadow mode, and .reflex/
  doctor [--tune]      Check setup; benchmark local tiers and the backend; --tune writes .reflex/tune.json

Observe
  trace [--tail N] [--point P] [--follow] [--json]   Show recent decisions
  stats [--days N]     Auto rate, escalations, latency, label agreement, savings

Learn
  train [--promote] [--force] [--target-precision 0.95] [--tolerance 0.015]
                       Build a candidate policy from traces (held-out calibration + thresholds)
  eval [--version vN] [--all]   Evaluate a policy on labeled traces
  policies             List policy versions (* = promoted)
  promote <vN>         Promote a policy version
  rollback             Return to the previously promoted policy

Run
  serve [--port 7070] [--host 127.0.0.1] [--token T] [--mode M]   Local sidecar + dashboard (/ui)
  mcp [--mode M]       MCP server on stdio
  laya [--port 7071] [--checkpoint english] [--device cpu] [--mock]   Start the Laya full-model sidecar (Python)
  bench [--suite all|sim-coding|sim-support] [--tasks 300] [--seed 42] [--json] [--out file]

Global options
  -v, version          Print the version
  --workload NAME      Workload (default: first in config, or the only traced one)
  --data-dir DIR       Data directory (default: .reflex)
  --config FILE        Config file (default: ./reflex.config.{ts,mjs,js,json})

Environment
  REFLEX_DISABLE=1     Kill switch: every decision escalates
  REFLEX_MODE=M        Override mode (off | shadow | assist | auto)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "string" },
      v: { type: "boolean" },
      workload: { type: "string", short: "w" },
      "data-dir": { type: "string" },
      config: { type: "string" },
      tail: { type: "string" },
      point: { type: "string" },
      days: { type: "string" },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      token: { type: "string" },
      mode: { type: "string" },
      suite: { type: "string" },
      tasks: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
      checkpoint: { type: "string" },
      device: { type: "string" },
      "target-precision": { type: "string" },
      tolerance: { type: "string" },
    },
  });
  const flags = values as commands.Flags;
  const [command, ...rest] = positionals;
  if (command === "version" || flags.v || (!command && flags.version !== undefined)) {
    console.log(VERSION);
    return;
  }
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "init":
      return commands.init(flags);
    case "doctor":
      return commands.doctor(flags);
    case "trace":
      return commands.trace(flags);
    case "stats":
      return commands.stats(flags);
    case "train":
      return commands.train(flags);
    case "eval":
      return commands.evaluate(flags);
    case "policies":
      return commands.policies(flags);
    case "promote":
      return commands.promote(flags, rest[0]);
    case "rollback":
      return commands.rollback(flags);
    case "serve":
      return commands.serve(flags);
    case "mcp":
      return commands.mcp(flags);
    case "laya":
      return commands.laya(flags);
    case "bench":
      return commands.bench(flags);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error("reflex: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
