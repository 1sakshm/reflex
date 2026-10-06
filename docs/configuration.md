# Configuration reference

Pass a `ReflexConfig` to `createReflex()`, or put several workloads in `reflex.config.{ts,mjs,js,json}` for the CLI, sidecar and MCP server:

```ts
import type { ReflexFileConfig } from "@reflex-ai/core";

export default {
  dataDir: ".reflex",
  defaults: { timeoutMs: 75 },
  workloads: {
    "coding-agent": { mode: "auto", allowStateful: false },
    "support-bot": { mode: "shadow" },
  },
} satisfies ReflexFileConfig;
```

## Options

| Option | Default | Description |
|---|---|---|
| `workload` | (required) | Name of this agent/workload. Traces and policies are kept per workload. |
| `mode` | `"shadow"` | `off`, `shadow`, `assist` or `auto`. |
| `dataDir` | `.reflex` | Where traces and policies live. Also `REFLEX_DATA_DIR`. |
| `backend` | none | Full-model tier: `{ type: "laya", url?, checkpoint? }`, `{ type: "http", url }`, or any `DecisionBackend`. |
| `timeoutMs` | `75` | Hard cap per decision. On timeout Reflex escalates. |
| `thresholds` | see below | Per-risk auto thresholds (`number` or `"never"`). Overrides learned thresholds. |
| `floors` | `{safe: .6, cheap: .75, costly: .85, stateful: .95}` | Learned thresholds never go below these. |
| `minMargin` | `0.1` | Required gap between the top two candidates. |
| `allowStateful` | `false` | Allow auto-executing `stateful` actions. |
| `allowDestructive` | `false` | Allow `destructive` actions **only** when a `force` rule names them. Never auto otherwise. |
| `budgets` | `{ loopWindow: 3 }` | See [Budgets](#budgets). |
| `rules` | `[]` | See [Rules](#rules). |
| `points` | `{}` | Per-decision-point `mode`, `question` (shown to the full model) and `thresholds`. |
| `tiers` | all `true` | Turn individual tiers off: `{ cache, patterns, head, backend }`. |
| `speed.mode` | `"balanced"` | `cost-first` (never hedge), `balanced` (hedge at difficulty ≥ 0.6), `latency-first` (≥ 0.3). |
| `speed.earlyEscalate` | `0.85` | Difficulty at which Reflex escalates without running the full model. |
| `speed.hedgeEscalation` | from mode | Difficulty at which `onHedge` fires. |
| `speed.speculativeSafeActions` | `true` | Allow `reflex.speculate()`. |
| `learning.online` | `true` | Learn from labels and outcomes as they arrive. |
| `learning.minExamples` | `20` | Labeled examples per point before the head tier is used. |
| `learning.minPatternSupport` | `3` | Observations before the pattern tier is used. |
| `learning.minCacheSupport` | `3` | Observations of an exact state before the cache tier is used. |
| `learning.auditRate` | `0.02` | Share of confident auto decisions sent to System 2 anyway. `0` disables. |
| `learning.minFamiliarity` | `0.5` | Below this, a state is out of distribution. |
| `learning.loadPolicy` | `true` | Load the promoted policy at startup. |
| `storage.traces` | `true` | Write JSONL traces. |
| `storage.stateEncoding` | `"redacted"` | `redacted` stores the compact redacted state; `digest` stores only a hash (no offline training). |
| `storage.retentionDays` | `30` | Old trace files are deleted at startup. |
| `privacy.redactSecrets` | `true` | Built-in secret redaction. |
| `privacy.redactPatterns` | `[]` | Extra regexes to redact. |
| `privacy.redactKeys` | `[]` | Extra field names to redact. |
| `frontier` | `{ costUsd: 0.03, latencyMs: 3000 }` | Typical frontier step, used for savings estimates. |
| `sink` | JSONL | Custom `TraceSink` (e.g. `MemorySink` in tests). |
| `strict` | `false` | Throw internal errors instead of failing open. Tests only. |

Default thresholds: `safe 0.70`, `cheap 0.80`, `costly 0.90`, `stateful 0.97` (needs `allowStateful`), `destructive never`.

## Budgets

```ts
budgets: {
  maxStepsPerTask: 80,
  maxUsdPerTask: 2,            // from outcome({ costUsd })
  maxFrontierCallsPerTask: 30,
  maxWallClockMs: 600_000,
  maxRetriesPerAction: 3,      // actions of kind "retry"
  loopWindow: 3,               // escalate when the same action would be chosen 3× in a row
}
```

Budgets need `taskId` on `decide()`. They apply to rule-forced actions too.

## Rules

Rules run before any learned tier and always win.

```ts
rules: [
  // Remove candidates
  { id: "no-force-push", type: "deny", actions: ["bash"], when: { path: "params.command", matches: "push\\s+--force" } },
  // Restrict candidates when a condition holds
  { type: "allowOnly", actions: ["read_*", "grep"], when: { path: "state.mode", equals: "read-only" } },
  // Force an action
  { id: "rate-limit", type: "force", action: "retry_backoff", when: { path: "state.lastObservation.errorClass", in: ["RateLimit", "429"] } },
  // Always ask System 2
  { id: "stuck", type: "requireEscalation", when: { path: "state.stepsSinceProgress", gte: 5 } },
]
```

- `points: ["next_*"]` limits a rule to matching decision points (`*` globs). `actions` also accepts globs.
- Conditions can be `{ path, equals | in | matches (+flags) | gte | lte | exists }`, combined with `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`, or a function `(ctx) => boolean`.
- Paths resolve against `{ point, workload, state, task, action, params }`.
- A `force` rule still respects risk gating (destructive needs `allowDestructive`, stateful needs `allowStateful`), budgets and loop detection.

## Environment variables

| Variable | Effect |
|---|---|
| `REFLEX_DISABLE=1` | Kill switch: every decision escalates (`reason: "mode"`). |
| `REFLEX_MODE=…` | Forces `off`/`shadow`/`assist`/`auto` everywhere, overriding per-call and per-point modes. |
| `REFLEX_DATA_DIR` | Default data directory. |
| `REFLEX_TOKEN` | Default auth token for `reflex serve`. |
| `REFLEX_PYTHON` | Python executable used by `reflex laya`. |
