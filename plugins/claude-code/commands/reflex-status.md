---
description: Show what Reflex has saved in Claude Code (blocked re-reads, duplicate fetches, loops, gated commands)
allowed-tools: Bash(node:*)
---

Run this command and show its output to the user verbatim in a code block, then add one sentence on what stands out:

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/reflex-hook.mjs" report`
