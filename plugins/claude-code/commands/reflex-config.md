---
description: Explain how to configure or disable the Reflex hooks
---

Tell the user how to configure Reflex for Claude Code:

- Settings live in `~/.reflex/claude-code.json` (create it if missing). Defaults:
  `{"dedupeReads": true, "dedupeFetches": true, "loopWindow": 3, "destructive": "ask", "autoApproveSafe": false, "dedupeWindow": 30, "traces": true}`
- `destructive` can be `"ask"`, `"deny"` or `"off"`. `autoApproveSafe: true` skips permission prompts for read-only tools (Read, Glob, Grep, LS).
- Set the environment variable `REFLEX_DISABLE=1` to turn every Reflex hook into a no-op.
- Traces are written to `~/.reflex/traces/claude-code/` in Reflex format; `npx reflex stats --workload claude-code --data-dir ~/.reflex` summarizes them.

If the user asked to change a setting, offer to edit `~/.reflex/claude-code.json` for them.
