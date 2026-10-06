# Getting started

This guide takes you from zero to Reflex making real decisions in your agent, safely.

## 1. Install

```bash
npm install @reflex-ai/core          # the runtime (zero dependencies)
npm install -D @reflex-ai/cli        # optional: the `reflex` CLI (stats, train, serve, mcp, bench)
```

Node ≥ 22. TypeScript configs (`reflex.config.ts`) need Node ≥ 22.18; on older Node, `reflex init` writes `reflex.config.mjs` instead.

## 2. Create a config (optional)

```bash
npx reflex init --workload my-agent
```

This writes `reflex.config.ts` in **shadow mode** and adds `.reflex/` (traces and policies) to `.gitignore`. You can also skip the file and pass the config to `createReflex()` directly.

## 3. Describe your decision point

A *decision point* is a place in your loop where the agent picks what to do next. List the candidate actions with a **risk class**:

| Risk | Examples | Auto-execute threshold (default) |
|---|---|---|
| `safe` | read a file, cache lookup, list a directory | 0.70 |
| `cheap` | web search, RAG query, small-model call | 0.80 |
| `costly` | long test suite, large-context call | 0.90 |
| `stateful` | write/edit a file, send a draft | never, unless `allowStateful` (then 0.97) |
| `destructive` | delete, deploy, pay, email, force-push | **never** |

```ts
import { action, createReflex } from "@reflex-ai/core";

const reflex = createReflex({ workload: "my-agent", mode: "shadow" });

function candidates(lastOutput: string) {
  return [
    ...filesMentionedIn(lastOutput).map((path) => action.with(action.tool("read_file", { risk: "safe", readOnly: true }), { path })),
    action.tool("run_tests", { risk: "costly" }),
    action.tool("write_file", { risk: "stateful" }),
    action.frontier(),  // "this step needs real reasoning"
    action.stop(),
  ];
}
```

## 4. Wrap the step

```ts
const decision = await reflex.decide({
  point: "next_action",
  taskId,
  state: {
    goal: "make the failing tests pass",
    lastAction: "run_tests",
    lastObservation: { status: "error", errorClass: "ImportError", text: output.slice(-500) },
    history: recentActions,
  },
  actions: candidates(output),
});

if (decision.type === "auto") {
  await run(decision.action.id, decision.params);              // System 1: no frontier call
} else {
  const choice = await callFrontier(state, reflex.formatHints(decision)); // System 2
  reflex.observeChoice(decision.id, choice);                   // the learning signal
}
```

When the task ends:

```ts
reflex.taskOutcome({ taskId, success: testsPassed });
await reflex.close(); // flushes traces (also done automatically on process exit)
```

## 5. Watch it in shadow mode

In shadow mode Reflex never acts. It records what it *would* have done, and your frontier model's choices become labels.

```bash
npx reflex stats
#   agreement w/ labels 85.5% of 117 labeled decisions
#   shadow: would auto  63 (53.8% of labeled) at 100.0% precision
```

## 6. Train, check, promote

```bash
npx reflex train --promote
#   auto precision     100.0% (95% lower bound 70.1%, n=9)
#   ✔ promoted v1
```

`train` builds a candidate policy from your traces. It calibrates on one held-out slice and reports on another, and it only promotes if precision clears the gate. `npx reflex rollback` undoes a promotion instantly.

## 7. Turn on auto mode

```ts
const reflex = createReflex({ workload: "my-agent", mode: "auto" });
```

Start with the defaults: `safe`/`cheap`/`costly` actions only, with audit sampling on. Turn on `allowStateful` only once `reflex stats` shows sustained high precision for those actions.

## Kill switch

`REFLEX_DISABLE=1` makes every decision escalate, overriding all config. `REFLEX_MODE=shadow` forces shadow mode everywhere.

## Next

- [Concepts](concepts.md): the ladder, calibration, learning
- [Configuration](configuration.md): every option
- [API reference](api.md)
- [Integrations](integrations.md): sidecar, Python, MCP, Claude Code, Codex, Laya
