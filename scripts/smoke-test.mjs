#!/usr/bin/env node
/**
 * Release smoke test: pack the npm tarballs exactly as they would be published,
 * install them into an empty project, and use them like a new user would.
 *
 *   npm run build && node scripts/smoke-test.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "reflex-smoke-"));
const packs = join(work, "packs");
const app = join(work, "app");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const results = [];
const quote = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
const run = (cmd, args, cwd, input) => {
  const env = { ...process.env, REFLEX_DISABLE: "" };
  // Windows can only spawn .cmd shims through a shell; quote the arguments ourselves in that case.
  const out =
    isWin && /\.cmd$/i.test(cmd)
      ? spawnSync([quote(cmd), ...args.map(quote)].join(" "), { cwd, encoding: "utf8", input, shell: true, env })
      : spawnSync(cmd, args, { cwd, encoding: "utf8", input, env });
  return { code: out.status, out: (out.stdout ?? "") + (out.stderr ?? "") };
};
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "\n      " + String(detail).trim().split("\n").slice(-8).join("\n      ")}`);
};

try {
  execFileSync(isWin ? "cmd" : "mkdir", isWin ? ["/c", "mkdir", packs, app] : ["-p", packs, app]);
  // 1. Pack (what `npm publish` would upload).
  for (const pkg of ["core", "server", "bench", "cli"]) {
    const result = run(npm, ["pack", "--json", "--pack-destination", packs], join(root, "packages", pkg));
    check(`npm pack @reflex-ai/${pkg}`, result.code === 0, result.out);
    let files = [];
    try {
      files = JSON.parse(result.out.slice(result.out.indexOf("[")))[0].files.map((file) => file.path);
    } catch {}
    const leaked = files.filter((path) => /tsbuildinfo|^test\/|\.reflex|node_modules/.test(path));
    check(`@reflex-ai/${pkg}: no test files, build info or local data`, files.length > 0 && leaked.length === 0, leaked.join("\n") || result.out);
    check(
      `@reflex-ai/${pkg}: ships dist, README and LICENSE (${files.length} files)`,
      files.some((path) => path.startsWith("dist/")) && files.includes("README.md") && files.includes("LICENSE"),
      files.join("\n"),
    );
  }
  const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz"));

  // 2. Install into an empty project.
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true, type: "module" }));
  const install = run(npm, ["install", "--no-audit", "--no-fund", ...tarballs.map((tgz) => join(packs, tgz))], app);
  check("npm install of all tarballs into an empty project", install.code === 0, install.out);

  const bin = join(app, "node_modules", ".bin", isWin ? "reflex.cmd" : "reflex");
  const reflex = (...args) => run(bin, args, app);

  // 3. CLI.
  const version = reflex("--version");
  check("reflex --version", version.code === 0 && version.out.trim() === JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version, version.out);
  check("reflex --help", reflex("--help").out.includes("Usage: reflex"));
  const init = reflex("init", "--workload", "smoke");
  check("reflex init writes a config", init.code === 0 && (existsSync(join(app, "reflex.config.ts")) || existsSync(join(app, "reflex.config.mjs"))), init.out);
  const doctor = reflex("doctor", "--tune");
  check("reflex doctor --tune (config loads, local tiers fast)", doctor.code === 0 && /local tiers .* p50/.test(doctor.out) && !/could not load/.test(doctor.out), doctor.out);
  const bench = reflex("bench", "--suite", "sim-coding", "--tasks", "40", "--json");
  check("reflex bench", bench.code === 0 && JSON.parse(bench.out)[0]?.reflex?.tasks === 40, bench.out);

  // 4. Library API from plain JavaScript (resolves to dist, not TS sources).
  writeFileSync(
    join(app, "use.mjs"),
    `import { createReflex, action, MemorySink, VERSION } from "@reflex-ai/core";
const resolved = import.meta.resolve("@reflex-ai/core");
if (!resolved.includes("/dist/")) throw new Error("resolved to " + resolved);
const r = createReflex({ workload: "smoke", mode: "auto", sink: new MemorySink(), learning: { loadPolicy: false, minExamples: 5 } });
const actions = [action.tool("read_file", { risk: "safe" }), action.tool("deploy", { risk: "destructive" }), action.frontier()];
const state = { lastAction: "run_tests", lastObservation: { status: "error", errorClass: "ImportError" } };
let auto = 0;
for (let i = 0; i < 30; i++) {
  const d = await r.decide({ point: "next", state, actions });
  if (d.type === "auto") { auto++; if (d.action.id !== "read_file") throw new Error("wrong auto " + d.action.id); }
  else r.observeChoice(d.id, "read_file");
}
const forced = createReflex({ workload: "smoke2", mode: "auto", sink: new MemorySink(), rules: [{ type: "force", action: "deploy", when: () => true }] });
const d = await forced.decide({ point: "x", state: {}, actions });
if (d.type === "auto") throw new Error("destructive was auto-executed");
console.log(JSON.stringify({ version: VERSION, auto }));
`,
  );
  const use = run(process.execPath, ["use.mjs"], app);
  let parsed;
  try {
    parsed = JSON.parse(use.out.trim().split("\n").pop());
  } catch {}
  check("library: learns, auto-decides correctly, never auto-executes destructive", use.code === 0 && parsed?.auto > 10, use.out);

  // 5. TypeScript consumers get types: core with no Node typings at all, and the full set
  //    in a typical Node project (with @types/node, an optional peer of server/cli).
  const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
  const tsconfig = (files, types) =>
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", lib: ["ES2023", "DOM"], strict: true, noEmit: true, skipLibCheck: false, types }, files });
  writeFileSync(
    join(app, "core-consumer.ts"),
    `import { createReflex, action, type Decision } from "@reflex-ai/core";
const r = createReflex({ workload: "t" });
const d: Promise<Decision> = r.decide({ point: "p", state: {}, actions: [action.stop()] });
void d;
// @ts-expect-error risk must be a known class
action.tool("x", { risk: "yolo" });
`,
  );
  writeFileSync(join(app, "tsconfig.core.json"), tsconfig(["core-consumer.ts"], []));
  const tscCore = run(process.execPath, [tscBin, "-p", join(app, "tsconfig.core.json")], app);
  check("TypeScript: @reflex-ai/core types need no @types/node", tscCore.code === 0, tscCore.out);

  const typesNode = run(npm, ["install", "--no-audit", "--no-fund", "-D", "@types/node@^24"], app);
  writeFileSync(
    join(app, "full-consumer.ts"),
    `import { ReflexService, createSidecar } from "@reflex-ai/server";
import { compare } from "@reflex-ai/bench";
const service = new ReflexService({ defaultWorkload: "t" });
const server = createSidecar(service);
void server; void compare;
`,
  );
  writeFileSync(join(app, "tsconfig.full.json"), tsconfig(["full-consumer.ts"], ["node"]));
  const tscFull = run(process.execPath, [tscBin, "-p", join(app, "tsconfig.full.json")], app);
  check("TypeScript: server/bench types in a Node project", typesNode.code === 0 && tscFull.code === 0, typesNode.out + tscFull.out);

  // 6. MCP handshake through the installed binary.
  const mcp = run(
    bin,
    ["mcp", "--data-dir", join(work, "mcp-data")],
    app,
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  );
  check("reflex mcp: initialize + tools/list", /"protocolVersion":"2025-06-18"/.test(mcp.out) && /reflex_decide/.test(mcp.out), mcp.out);
} finally {
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${failed ? failed + " FAILED" : "ALL " + results.length + " CHECKS PASSED"}  (workspace: ${work})`);
  if (!failed) rmSync(work, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
