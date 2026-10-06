# Reflex for Codex

Codex talks to Reflex through MCP. Codex's model still decides each turn; Reflex gives it fast,
learned answers for routine choices and a cheap way to pick model tiers for sub-work.

## 1. Register the MCP server

Add this to `~/.codex/config.toml`, then restart Codex:

```toml
[mcp_servers.reflex]
command = "npx"
args = ["-y", "@reflex-ai/cli", "mcp", "--workload", "codex", "--data-dir", "~/.reflex"]
```

> MCP configuration keys can change between Codex versions. If this doesn't load, check
> `codex mcp --help` or the Codex docs for your version.

## 2. Tell Codex when to use it

Append [`AGENTS.snippet.md`](AGENTS.snippet.md) to your project's `AGENTS.md`.

## 3. Watch it learn

```bash
npx @reflex-ai/cli stats --workload codex --data-dir ~/.reflex
npx @reflex-ai/cli train --workload codex --data-dir ~/.reflex --promote
```

Codex doesn't have hook-level interception like Claude Code's `PreToolUse`, so the
dedupe/loop/destructive-command reflexes from the Claude Code plugin aren't available here yet.
