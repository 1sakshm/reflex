# Reflex for Claude Code

Fast, deterministic reflexes for every Claude Code tool call. They take milliseconds, need no model, and fail open.

- Blocks **re-reads of unchanged files** (mtime-checked; page/range-aware; reset after compaction; per subagent)
- Blocks **identical repeated WebFetch/WebSearch**
- Stops **identical tool-call loops**
- **Asks before destructive commands** in bash, PowerShell and cmd
- Adds the **Reflex MCP tools** (`reflex_route_subtask`, `reflex_decide`, …) and a skill explaining when to use them
- `/reflex-status` shows what it blocked

```bash
claude plugin marketplace add 1sakshm/reflex
claude plugin install reflex@reflex
```

Configure in `~/.reflex/claude-code.json`; `REFLEX_DISABLE=1` disables it. Details: [docs/integrations.md](../../docs/integrations.md#claude-code-plugin-t3).
