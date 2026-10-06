#!/usr/bin/env node
/**
 * Reflex for Claude Code: fast, deterministic hook-level reflexes.
 *
 * Claude Code makes each turn's decision inside the model, so Reflex cannot skip
 * those turns (PRD §15.1, tier T3). What it can do, in a few milliseconds per tool call:
 *   • block re-reads of files that haven't changed since Claude last read them
 *   • block identical repeated WebFetch/WebSearch calls in the same session
 *   • stop identical tool-call loops
 *   • require confirmation for destructive shell commands
 *   • (opt-in) auto-approve read-only tools
 * and log every decision in Reflex trace format for `reflex stats`.
 *
 * Zero dependencies. Usage (from hooks.json): node reflex-hook.mjs <event>
 * Also: node reflex-hook.mjs report   → savings summary
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { destructiveReason } from "./destructive.mjs";

const WORKLOAD = "claude-code";
const DATA_DIR = process.env.REFLEX_DATA_DIR ?? join(homedir(), ".reflex");
const STATE_DIR = process.env.REFLEX_CC_STATE_DIR ?? join(tmpdir(), "reflex-claude-code");
const TRACE_DIR = join(DATA_DIR, "traces", WORKLOAD);

const DEFAULTS = {
  disabled: false,
  dedupeReads: true,
  dedupeFetches: true,
  /** Block a tool call identical to the previous N-1 calls. 0 disables. */
  loopWindow: 3,
  /** Shell commands are often legitimately re-run (flaky tests, polling): looser window. */
  shellLoopWindow: 6,
  /** "ask" (require confirmation), "deny", or "off" for destructive shell commands. */
  destructive: "ask",
  /** Auto-approve read-only tools (skips permission prompts). Off by default. */
  autoApproveSafe: false,
  /** Only dedupe a read if it happened within the last N tool calls. */
  dedupeWindow: 30,
  traces: true,
  /** Estimated cost of one avoidable tool round trip, for the savings report. */
  estimatedUsdPerAvoidedCall: 0.01,
};

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"]);
const FETCH_TOOLS = new Set(["WebFetch", "WebSearch"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);


function loadConfig() {
  let file = {};
  const path = process.env.REFLEX_CC_CONFIG ?? join(DATA_DIR, "claude-code.json");
  try {
    if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // ignore a malformed config; defaults are safe
  }
  const config = { ...DEFAULTS, ...file };
  if (process.env.REFLEX_DISABLE === "1" || process.env.REFLEX_DISABLE === "true") config.disabled = true;
  return config;
}

// ------------------------------------------------------------------ state

/** State is per session AND per agent: a subagent has not seen what its parent read. */
function stateKey(input) {
  const agent = input.agent_id ?? input.subagent_id ?? "";
  return String(input.session_id ?? "unknown") + (agent ? "__" + agent : "");
}

function statePath(sessionId) {
  return join(STATE_DIR, String(sessionId ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
}

function loadState(sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), "utf8"));
  } catch {
    return { calls: 0, reads: {}, fetches: {}, recent: [], task: 0, stats: { dedupedReads: 0, dedupedFetches: 0, loops: 0, destructive: 0, approved: 0 } };
  }
}

function saveState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = statePath(sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

// ------------------------------------------------------------------ traces (Reflex format)

let idCounter = 0;
function newId() {
  return Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 8);
}

function trace(config, event) {
  if (!config.traces) return;
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(join(TRACE_DIR, new Date().toISOString().slice(0, 10) + ".jsonl"), JSON.stringify({ ts: new Date().toISOString(), workload: WORKLOAD, ...event }) + "\n");
  } catch {
    // tracing must never break the hook
  }
}

function decisionEvent(input, state, chosen, reason, detail, started) {
  const blocked = chosen !== "allow" && chosen !== "pass";
  return {
    ev: "decision",
    id: newId(),
    point: "pre_tool_use",
    taskId: `${input.session_id}#${state.task}`,
    policyVersion: "hooks-v1",
    mode: "auto",
    stateDigest: "",
    state: { lastAction: input.tool_name, obs: { type: input.tool_name, text: summarize(input.tool_name, input.tool_input).slice(0, 200) } },
    candidates: [
      { key: "pass", id: "pass", kind: "tool", risk: "safe" },
      { key: chosen, id: chosen, kind: "custom", risk: "safe" },
    ],
    rulesApplied: reason ? [reason] : [],
    source: "rule",
    outcome: blocked ? "auto" : "escalate",
    ...(blocked ? { chosen, confidence: 1, margin: 1 } : { reason: "mode", detail: "passed through to Claude Code" }),
    detail,
    latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

// ------------------------------------------------------------------ helpers

function summarize(tool, input = {}) {
  if (tool === "Bash") return String(input.command ?? "");
  if (tool === "Read" || WRITE_TOOLS.has(tool)) return String(input.file_path ?? input.notebook_path ?? "");
  if (tool === "WebFetch") return String(input.url ?? "");
  if (tool === "WebSearch") return String(input.query ?? "");
  return JSON.stringify(input).slice(0, 300);
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

function mtime(path, cwd) {
  try {
    return statSync(resolve(cwd ?? ".", path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function output(json) {
  if (json) process.stdout.write(JSON.stringify(json));
}

function preToolDecision(decision, reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

// ------------------------------------------------------------------ events

function onPreToolUse(input, config) {
  const started = performance.now();
  const state = loadState(stateKey(input));
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const signature = tool + ":" + stable(toolInput);
  state.calls++;
  let verdict;

  // 1. Destructive shell commands (bash, PowerShell, cmd).
  if (SHELL_TOOLS.has(tool) && config.destructive !== "off") {
    const why = destructiveReason(String(toolInput.command ?? ""));
    if (why) {
      state.stats.destructive++;
      verdict = {
        chosen: config.destructive === "deny" ? "deny" : "ask",
        rule: "destructive-command",
        reason: `Reflex: this command looks destructive (${why}). Confirm it is intended.`,
      };
    }
  }

  // 2. Identical-call loops. Reads are covered by the mtime-aware dedupe below
  // (a re-read after the file changed is legitimate, not a loop).
  const window = SHELL_TOOLS.has(tool) ? config.shellLoopWindow : config.loopWindow;
  if (!verdict && window > 1 && tool !== "Read") {
    const recent = state.recent.slice(-(window - 1));
    if (recent.length === window - 1 && recent.every((item) => item === signature)) {
      state.stats.loops++;
      verdict = {
        chosen: "deny",
        rule: "loop",
        reason: `Reflex: this exact ${tool} call has run ${window - 1} times in a row with the same input. Try a different approach instead of repeating it.`,
      };
    }
  }

  // 3. Re-reading an unchanged file.
  if (!verdict && tool === "Read" && config.dedupeReads && toolInput.file_path) {
    const key = stable(toolInput);
    const previous = state.reads[key];
    const current = mtime(toolInput.file_path, input.cwd);
    if (previous && current !== undefined && previous.mtime === current && state.calls - previous.call <= config.dedupeWindow) {
      state.stats.dedupedReads++;
      verdict = {
        chosen: "deny",
        rule: "dedupe-read",
        reason: `Reflex: ${toolInput.file_path} has not changed since you read it ${state.calls - previous.call} tool calls ago; use that earlier content. (If it is no longer in your context, read a specific range with offset/limit.)`,
      };
    }
  }

  // 4. Repeating an identical web fetch/search.
  if (!verdict && FETCH_TOOLS.has(tool) && config.dedupeFetches) {
    const previous = state.fetches[signature];
    if (previous !== undefined && state.calls - previous <= config.dedupeWindow) {
      state.stats.dedupedFetches++;
      verdict = {
        chosen: "deny",
        rule: "dedupe-fetch",
        reason: `Reflex: an identical ${tool} ran ${state.calls - previous} tool calls ago in this session; reuse that result.`,
      };
    }
  }

  // 5. Optional auto-approval of read-only tools.
  if (!verdict && config.autoApproveSafe && SAFE_TOOLS.has(tool)) {
    state.stats.approved++;
    verdict = { chosen: "allow", rule: "auto-approve-safe", reason: "Reflex: read-only tool auto-approved." };
  }

  state.recent.push(signature);
  if (state.recent.length > 20) state.recent.shift();
  saveState(stateKey(input), state);
  trace(config, decisionEvent(input, state, verdict?.chosen ?? "pass", verdict?.rule, verdict?.reason ?? "", started));
  if (verdict) output(preToolDecision(verdict.chosen, verdict.reason));
}

function onPostToolUse(input, config) {
  const state = loadState(stateKey(input));
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const response = input.tool_response ?? input.tool_output;
  const failed = Boolean(response && typeof response === "object" && (response.is_error || response.error || response.success === false));
  if (tool === "Read" && toolInput.file_path && !failed) {
    const key = stable(toolInput);
    const current = mtime(toolInput.file_path, input.cwd);
    if (current !== undefined) state.reads[key] = { call: state.calls, mtime: current };
  }
  if (WRITE_TOOLS.has(tool)) {
    // Our own write changes mtime, but drop the entry anyway so a post-edit re-read is never blocked.
    const path = toolInput.file_path ?? toolInput.notebook_path;
    for (const key of Object.keys(state.reads)) if (key.includes(JSON.stringify(String(path)).slice(1, -1))) delete state.reads[key];
  }
  if (FETCH_TOOLS.has(tool) && !failed) state.fetches[tool + ":" + stable(toolInput)] = state.calls;
  saveState(stateKey(input), state);
  trace(config, { ev: "outcome", decisionId: "", status: failed ? "error" : "ok", takenBy: "frontier", errorClass: failed ? tool : undefined });
}

function onUserPromptSubmit(input, config) {
  const state = loadState(stateKey(input));
  if (state.calls > 0 || state.task > 0) {
    trace(config, { ev: "task", taskId: `${input.session_id}#${state.task}`, success: true, feedback: "superseded-by-next-prompt" });
  }
  state.task++;
  state.recent = [];
  saveState(stateKey(input), state);
}

function onSessionStart(input) {
  const state = loadState(stateKey(input));
  // After compaction or /clear, earlier file contents may no longer be in context: forget them.
  if (input.source === "compact" || input.source === "clear") {
    state.reads = {};
    state.fetches = {};
    state.recent = [];
  }
  saveState(stateKey(input), state);
}

function onStop(input, config) {
  const state = loadState(stateKey(input));
  trace(config, { ev: "task", taskId: `${input.session_id}#${state.task}`, success: true, feedback: "stop" });
}

// ------------------------------------------------------------------ report

function report(config) {
  const totals = { dedupedReads: 0, dedupedFetches: 0, loops: 0, destructive: 0, approved: 0, sessions: 0 };
  if (existsSync(STATE_DIR)) {
    for (const name of readdirSync(STATE_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const state = JSON.parse(readFileSync(join(STATE_DIR, name), "utf8"));
        totals.sessions++;
        for (const key of Object.keys(state.stats ?? {})) totals[key] = (totals[key] ?? 0) + state.stats[key];
      } catch {
        // skip
      }
    }
  }
  const avoided = totals.dedupedReads + totals.dedupedFetches + totals.loops;
  const lines = [
    `Reflex for Claude Code${config.disabled ? " (DISABLED)" : ""}`,
    `  sessions tracked            ${totals.sessions}`,
    `  unchanged re-reads blocked  ${totals.dedupedReads}`,
    `  duplicate fetches blocked   ${totals.dedupedFetches}`,
    `  tool-call loops stopped     ${totals.loops}`,
    `  destructive commands gated  ${totals.destructive}`,
    `  read-only tools auto-approved ${totals.approved}${config.autoApproveSafe ? "" : " (autoApproveSafe is off)"}`,
    `  avoidable round trips       ${avoided} (≈ $${(avoided * config.estimatedUsdPerAvoidedCall).toFixed(2)} at $${config.estimatedUsdPerAvoidedCall}/call, an estimate)`,
    `  traces                      ${TRACE_DIR}`,
    `  config                      ${process.env.REFLEX_CC_CONFIG ?? join(DATA_DIR, "claude-code.json")}`,
  ];
  console.log(lines.join("\n"));
}

// ------------------------------------------------------------------ main

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

const event = process.argv[2];
const config = loadConfig();
try {
  if (event === "report") {
    report(config);
  } else if (!config.disabled) {
    const input = await readStdin();
    const name = event ?? input.hook_event_name;
    if (name === "PreToolUse" || name === "pre") onPreToolUse(input, config);
    else if (name === "PostToolUse" || name === "post") onPostToolUse(input, config);
    else if (name === "UserPromptSubmit" || name === "prompt") onUserPromptSubmit(input, config);
    else if (name === "SessionStart" || name === "session") onSessionStart(input);
    else if (name === "Stop" || name === "stop") onStop(input, config);
  }
} catch (error) {
  // Fail open: never block Claude Code because of a Reflex bug.
  process.stderr.write(`reflex hook error (ignored): ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exitCode = 0;
