---
name: reflex-efficiency
description: Use when a task involves many routine steps (navigating files, re-running tests, repeated searches, choosing which subagent or model tier to delegate to). Explains how to work with the Reflex hooks and MCP tools so routine decisions are cheap and fast.
---

# Working efficiently with Reflex

Reflex is a fast local "System 1" that handles routine agent decisions so your reasoning is spent where it matters.

## What the hooks do

- **Unchanged re-reads are blocked.** If a `Read` is denied with "has not changed since you read it", the earlier content in your context is still current; use it. If that content is no longer in your context, read a specific range with `offset`/`limit`.
- **Duplicate fetches are blocked.** An identical `WebFetch`/`WebSearch` in the same session returns a denial; reuse the earlier result.
- **Loops are stopped.** If the same tool call with the same input is denied as a loop, change approach: different input, a different tool, or step back and reason about why it isn't working.
- **Destructive commands need confirmation.** `rm -rf` on broad paths, force pushes, hard resets, dropping tables, piping downloads into a shell, publishing packages.

## When to use the Reflex MCP tools

- **Before delegating to a subagent**, call `reflex_route_subtask` with a one-line description of the subtask. If it returns `type: "auto"` with `small` or `mid`, use a cheaper model for that subagent. If it returns `escalate`, choose yourself, then call `reflex_observe_choice` so Reflex learns.
- **For a routine choice between known options** (which of several files to open first, whether a search is needed), you may call `reflex_decide` with the candidate actions. Follow an `auto` answer directly; treat `escalate` hints as suggestions only.
- Don't call Reflex for decisions that need real reasoning (designing a fix, judging correctness). Those are yours.
