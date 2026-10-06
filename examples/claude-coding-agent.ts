/**
 * A minimal coding agent on the Claude API with Reflex as its System 1.
 *
 * Every step, Reflex decides first (in ~1 ms). Routine steps (re-running tests,
 * reading the file named in a stack trace, stopping once tests pass) run locally
 * without a Claude call. Anything Reflex isn't confident about, plus every edit
 * (a `stateful` action), goes to Claude. Claude's choices are fed back to
 * Reflex with `observeChoice`, so the agent gets cheaper the more you run it.
 *
 *   ANTHROPIC_API_KEY=... npm run claude-agent -- <repo-dir> "<test command>" [--auto]
 *
 * Reflex starts in shadow mode (it only watches). Pass --auto once
 * `npx reflex stats` shows it agrees with Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { action, createReflex, type ActionSpec } from "@reflex-ai/core";

const [repoArg, testCommand = "npm test"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const repo = resolve(repoArg ?? ".");
const mode = process.argv.includes("--auto") ? "auto" : "shadow";
const MAX_STEPS = 40;

const client = new Anthropic();
const reflex = createReflex({ workload: "claude-coding-agent", mode, dataDir: join(repo, ".reflex") });

// ------------------------------------------------------------------ tools

function inside(path: string): string {
  const full = resolve(repo, path);
  if (!full.startsWith(repo)) throw new Error(`path escapes the repository: ${path}`);
  return full;
}

function listFiles(dir = repo, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(relative(repo, full).replaceAll("\\", "/"));
    if (out.length > 400) break;
  }
  return out;
}

function runTests(): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execSync(testCommand, { cwd: repo, encoding: "utf8", stdio: "pipe", timeout: 120_000 }).slice(-4000) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-4000) };
  }
}

const tools: Anthropic.Beta.BetaTool[] = [
  { name: "list_files", description: "List files in the repository.", input_schema: { type: "object", properties: {} } },
  {
    name: "read_file",
    description: "Read a file from the repository.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Overwrite a file in the repository with new content.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  { name: "run_tests", description: `Run the test command (${testCommand}).`, input_schema: { type: "object", properties: {} } },
];

function execute(name: string, input: Record<string, unknown>): { text: string; ok: boolean } {
  try {
    switch (name) {
      case "list_files":
        return { text: listFiles().join("\n"), ok: true };
      case "read_file":
        return { text: readFileSync(inside(String(input.path)), "utf8").slice(0, 20_000), ok: true };
      case "write_file":
        writeFileSync(inside(String(input.path)), String(input.content));
        return { text: `wrote ${String(input.path)}`, ok: true };
      case "run_tests": {
        const result = runTests();
        return { text: (result.ok ? "TESTS PASSED\n" : "TESTS FAILED\n") + result.output, ok: result.ok };
      }
      default:
        return { text: `unknown tool ${name}`, ok: false };
    }
  } catch (error) {
    return { text: `error: ${error instanceof Error ? error.message : String(error)}`, ok: false };
  }
}

// ------------------------------------------------------------------ Reflex action space

const readFile = action.tool("read_file", { risk: "safe", readOnly: true });
const runTestsAction = action.tool("run_tests", { risk: "costly" });
const listFilesAction = action.tool("list_files", { risk: "safe", readOnly: true });
const writeFile = action.tool("write_file", { risk: "stateful" }); // never auto-executed by default

/** Candidate actions for this step: read any repo file named in the last output, plus the fixed tools. */
function candidates(lastOutput: string, files: string[]): ActionSpec[] {
  const mentioned = files.filter((file) => lastOutput.includes(file) || lastOutput.includes(file.split("/").pop() ?? "\u0000")).slice(0, 6);
  return [
    ...mentioned.map((path) => action.with(readFile, { path })),
    runTestsAction,
    listFilesAction,
    writeFile,
    action.frontier(),
    action.stop(),
  ];
}

// ------------------------------------------------------------------ agent loop

const SYSTEM =
  "You are a careful coding agent. Fix the failing tests in the repository with the smallest correct change. " +
  "Use the tools to inspect files and run tests. When the tests pass, reply with a one-line summary and no tool calls. " +
  "Some routine tool calls are made for you automatically; their results appear as [reflex] notes.";

const taskId = `fix-${Date.now()}`;
const messages: Anthropic.Beta.BetaMessageParam[] = [
  { role: "user", content: `Repository: ${repo}\nTest command: ${testCommand}\nMake the tests pass.` },
];
const files = listFiles();
const history: { action: string; status: string }[] = [];
let lastOutput = "";
let lastAction: string | undefined;
let lastOk = true;
let testsPassed = false;
let claudeCalls = 0;
let reflexSteps = 0;

for (let step = 0; step < MAX_STEPS; step++) {
  const decision = await reflex.decide({
    point: "next_action",
    taskId,
    state: {
      goal: "make the failing tests pass",
      ...(lastAction ? { lastAction } : {}),
      lastObservation: {
        status: lastOk ? "ok" : "error",
        type: lastAction === "run_tests" ? (testsPassed ? "tests_passed" : "tests_failed") : (lastAction ?? "start"),
        text: lastOutput.slice(-600),
      },
      history,
    },
    actions: candidates(lastOutput, files),
  });

  // ---- System 1: Reflex is confident and the action is low-risk.
  if (decision.type === "auto") {
    reflexSteps++;
    if (decision.action.id === "stop") break;
    const input = (decision.params ?? {}) as Record<string, unknown>;
    const result = execute(decision.action.id, input);
    reflex.outcome({ decisionId: decision.id, status: result.ok || decision.action.id === "run_tests" ? "ok" : "error", takenBy: "reflex" });
    // Append-only note so Claude keeps full context and the prompt cache prefix stays valid.
    messages.push({ role: "user", content: `[reflex] ran ${decision.action.id}${input.path ? `(${String(input.path)})` : ""}:\n${result.text}` });
    lastAction = decision.action.id;
    lastOutput = result.text;
    lastOk = result.ok;
    if (lastAction === "run_tests") testsPassed = result.ok;
    history.push({ action: lastAction, status: result.ok ? "ok" : "error" });
    continue;
  }

  // ---- System 2: Claude decides (and reasons) for this step.
  claudeCalls++;
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "high" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" }, // caches tools + system + transcript prefix
    system: SYSTEM,
    tools,
    messages,
  });
  if (response.stop_reason === "refusal") {
    console.error("Claude declined this request:", response.stop_details?.explanation ?? "");
    break;
  }
  messages.push({ role: "assistant", content: response.content });
  const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");

  if (toolUses.length === 0) {
    reflex.observeChoice(decision.id, "stop");
    for (const block of response.content) if (block.type === "text") console.log("Claude:", block.text);
    break;
  }

  // Teach Reflex what Claude did at this decision point (first tool call of the turn).
  const first = toolUses[0] as Anthropic.Beta.BetaToolUseBlock;
  const firstInput = first.input as Record<string, unknown>;
  reflex.observeChoice(decision.id, first.name === "read_file" ? { id: "read_file", params: { path: firstInput.path } } : first.name);

  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const use of toolUses) {
    const input = use.input as Record<string, unknown>;
    const result = execute(use.name, input);
    results.push({ type: "tool_result", tool_use_id: use.id, content: result.text, is_error: !result.ok && use.name !== "run_tests" });
    lastAction = use.name;
    lastOutput = result.text;
    lastOk = result.ok;
    if (use.name === "run_tests") testsPassed = result.ok;
    history.push({ action: use.name, status: result.ok ? "ok" : "error" });
  }
  reflex.outcome({ decisionId: decision.id, status: "ok", takenBy: "frontier" });
  messages.push({ role: "user", content: results });
}

reflex.taskOutcome({ taskId, success: testsPassed, frontierCalls: claudeCalls });
await reflex.close();
console.log(`\n${testsPassed ? "✔ tests pass" : "✖ tests still failing"} · Claude calls: ${claudeCalls} · steps handled by Reflex: ${reflexSteps} (mode: ${mode})`);
