#!/usr/bin/env node
/**
 * Set one version across every publishable artifact:
 *   node scripts/set-version.mjs 0.2.0
 * Updates npm packages (and their internal dependency ranges), Python packages,
 * the Claude Code plugin manifest, and the CLI/MCP version constant.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(2);
}

const npmPackages = ["packages/core", "packages/server", "packages/bench", "packages/cli"];
const internal = new Set(npmPackages.map((dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name));

const editJson = (path, fn) => {
  const full = join(root, path);
  const data = JSON.parse(readFileSync(full, "utf8"));
  fn(data);
  writeFileSync(full, JSON.stringify(data, null, 2) + "\n");
  console.log("updated", path);
};

for (const dir of [...npmPackages, "examples"]) {
  editJson(`${dir}/package.json`, (pkg) => {
    if (dir !== "examples") pkg.version = version;
    for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) if (internal.has(name)) pkg[field][name] = version;
    }
  });
}
editJson("package.json", (pkg) => (pkg.version = version));
editJson("plugins/claude-code/.claude-plugin/plugin.json", (plugin) => (plugin.version = version));

const replaceIn = (path, pattern, replacement) => {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after) throw new Error(`no version found in ${path}`);
  writeFileSync(full, after);
  console.log("updated", path);
};
replaceIn("packages/core/src/version.ts", /VERSION = "[^"]+"/, `VERSION = "${version}"`);
for (const path of ["python/reflex-laya/pyproject.toml", "python/reflex-agent-client/pyproject.toml"]) {
  replaceIn(path, /^version = "[^"]+"/m, `version = "${version}"`);
}
replaceIn("python/reflex-laya/reflex_laya/__init__.py", /__version__ = "[^"]+"/, `__version__ = "${version}"`);
replaceIn("python/reflex-agent-client/reflex_agent/__init__.py", /__version__ = "[^"]+"/, `__version__ = "${version}"`);
replaceIn("plugins/claude-code/.mcp.json", /@reflex-ai\/cli@[^"]+"/, `@reflex-ai/cli@${version}"`);
console.log(`\nAll artifacts set to ${version}. Next: update CHANGELOG.md, commit, tag v${version}.`);
