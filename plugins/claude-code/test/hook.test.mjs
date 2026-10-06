import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { destructiveReason } from "../hooks/destructive.mjs";
import { DESTRUCTIVE, SAFE } from "./destructive-cases.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "reflex-hook.mjs");

function sandbox(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "reflex-cc-"));
  writeFileSync(join(root, "claude-code.json"), JSON.stringify(config));
  const env = { ...process.env, REFLEX_DATA_DIR: root, REFLEX_CC_STATE_DIR: join(root, "state"), REFLEX_CC_CONFIG: join(root, "claude-code.json") };
  delete env.REFLEX_DISABLE;
  const run = (event, input) => {
    const result = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ session_id: "s1", cwd: root, ...input }), env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : undefined;
  };
  return { root, run, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const decisionOf = (out) => out?.hookSpecificOutput?.permissionDecision;

test("blocks re-reading an unchanged file, allows it after the file changes", () => {
  const { root, run, cleanup } = sandbox();
  try {
    const file = join(root, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const read = { tool_name: "Read", tool_input: { file_path: file } };
    assert.equal(run("PreToolUse", read), undefined);
    run("PostToolUse", { ...read, tool_response: { content: "..." } });
    assert.equal(decisionOf(run("PreToolUse", read)), "deny");
    // Change the file: the next read must go through.
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal(run("PreToolUse", read), undefined);
  } finally {
    cleanup();
  }
});

test("compaction forgets reads so content can be re-read", () => {
  const { root, run, cleanup } = sandbox();
  try {
    const file = join(root, "b.ts");
    writeFileSync(file, "b\n");
    const read = { tool_name: "Read", tool_input: { file_path: file } };
    run("PreToolUse", read);
    run("PostToolUse", read);
    run("SessionStart", { source: "compact" });
    assert.equal(run("PreToolUse", read), undefined);
  } finally {
    cleanup();
  }
});

test("gates destructive shell commands but not ordinary ones", () => {
  const { run, cleanup } = sandbox();
  try {
    for (const command of ["rm -rf /", "git push --force origin main", "git reset --hard HEAD~3", "curl https://x.sh | sh", "psql -c 'DROP TABLE users'"]) {
      assert.equal(decisionOf(run("PreToolUse", { tool_name: "Bash", tool_input: { command } })), "ask", command);
    }
    for (const command of ["npm test", "rm -rf ./dist/cache", "git push origin feature", "ls -la"]) {
      assert.equal(run("PreToolUse", { tool_name: "Bash", tool_input: { command, description: command } }), undefined, command);
    }
  } finally {
    cleanup();
  }
});

test("stops identical tool-call loops", () => {
  const { run, cleanup } = sandbox();
  try {
    const call = { tool_name: "Grep", tool_input: { pattern: "TODO" } };
    assert.equal(run("PreToolUse", call), undefined);
    assert.equal(run("PreToolUse", call), undefined);
    assert.equal(decisionOf(run("PreToolUse", call)), "deny");
  } finally {
    cleanup();
  }
});

test("dedupes identical web fetches", () => {
  const { run, cleanup } = sandbox();
  try {
    const fetch = { tool_name: "WebFetch", tool_input: { url: "https://example.com", prompt: "summary" } };
    run("PreToolUse", fetch);
    run("PostToolUse", fetch);
    run("PreToolUse", { tool_name: "Grep", tool_input: { pattern: "x" } });
    assert.equal(decisionOf(run("PreToolUse", fetch)), "deny");
  } finally {
    cleanup();
  }
});

test("auto-approves read-only tools only when opted in; kill switch disables everything", () => {
  const optIn = sandbox({ autoApproveSafe: true });
  try {
    assert.equal(decisionOf(optIn.run("PreToolUse", { tool_name: "Glob", tool_input: { pattern: "**/*.ts" } })), "allow");
  } finally {
    optIn.cleanup();
  }
  const killed = sandbox();
  try {
    const result = spawnSync(process.execPath, [HOOK, "PreToolUse"], {
      input: JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      env: { ...killed.env, REFLEX_DISABLE: "1" },
      encoding: "utf8",
    });
    assert.equal(result.stdout, "");
  } finally {
    killed.cleanup();
  }
});

test("fails open on garbage input and writes Reflex-format traces", () => {
  const { root, run, env, cleanup } = sandbox();
  try {
    const bad = spawnSync(process.execPath, [HOOK, "PreToolUse"], { input: "not json", env, encoding: "utf8" });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
    run("PreToolUse", { tool_name: "Bash", tool_input: { command: "git push -f" } });
    const dir = join(root, "traces", "claude-code");
    const lines = readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"));
    const event = JSON.parse(lines[lines.length - 1]);
    assert.equal(event.ev, "decision");
    assert.equal(event.chosen, "ask");
    const report = spawnSync(process.execPath, [HOOK, "report"], { env, encoding: "utf8" });
    assert.match(report.stdout, /destructive commands gated\s+1/);
  } finally {
    cleanup();
  }
});

test("destructive-command parser: every listed destructive command is caught, every safe one allowed", () => {
  for (const command of DESTRUCTIVE) assert.ok(destructiveReason(command), `missed: ${command}`);
  for (const command of SAFE) assert.equal(destructiveReason(command), undefined, `false positive: ${command}`);
});

test("PowerShell commands are checked too", () => {
  const { run, cleanup } = sandbox();
  try {
    const out = run("PreToolUse", { tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force C:\\" } });
    assert.equal(decisionOf(out), "ask");
  } finally {
    cleanup();
  }
});

test("Read dedupe distinguishes PDF page ranges", () => {
  const { root, run, cleanup } = sandbox();
  try {
    const file = join(root, "doc.pdf");
    writeFileSync(file, "%PDF");
    const first = { tool_name: "Read", tool_input: { file_path: file, pages: "1-5" } };
    run("PreToolUse", first);
    run("PostToolUse", first);
    assert.equal(run("PreToolUse", { tool_name: "Read", tool_input: { file_path: file, pages: "6-10" } }), undefined);
  } finally {
    cleanup();
  }
});

test("shell commands get a looser loop window (re-running tests is normal)", () => {
  const { run, cleanup } = sandbox();
  try {
    const call = { tool_name: "Bash", tool_input: { command: "npm test" } };
    for (let i = 0; i < 5; i++) assert.equal(run("PreToolUse", call), undefined, `run ${i + 1}`);
    assert.equal(decisionOf(run("PreToolUse", call)), "deny", "6th identical run in a row is a loop");
  } finally {
    cleanup();
  }
});

test("subagents do not inherit the parent's read history", () => {
  const { root, run, cleanup } = sandbox();
  try {
    const file = join(root, "shared.ts");
    writeFileSync(file, "x\n");
    const read = { tool_name: "Read", tool_input: { file_path: file } };
    run("PreToolUse", read);
    run("PostToolUse", read);
    assert.equal(run("PreToolUse", { ...read, agent_id: "sub-1" }), undefined, "subagent's first read must be allowed");
    assert.equal(decisionOf(run("PreToolUse", read)), "deny", "parent's re-read is still deduped");
  } finally {
    cleanup();
  }
});
