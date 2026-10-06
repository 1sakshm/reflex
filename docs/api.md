# API reference (`@reflex-ai/core`)

## `createReflex(config: ReflexConfig): Reflex`

Creates a runtime for one workload. See [configuration](configuration.md).

## `reflex.decide(request): Promise<Decision>`

```ts
await reflex.decide({
  point: "next_action",           // decision point name
  state: { goal, lastAction, lastObservation, history, stepsSinceProgress, ...anyScalars },
  actions: ActionSpec[],          // candidates
  taskId?: string,                // enables budgets, loop detection, credit assignment
  stepId?: string,
  mode?: "off" | "shadow" | "assist" | "auto",
  timeoutMs?: number,
  onHedge?: ({ decisionId, point, difficulty }) => void, // start System 2 early
  signal?: AbortSignal,
});
```

Never throws (unless `strict: true`) and never takes longer than `timeoutMs`. Returns a `Decision` (see [concepts](concepts.md#decisions)).

`state.lastObservation` can be a string or `{ status, type, errorClass, text }`. Other scalar fields in `state` are used as features. Fields with secret-like names are redacted.

## `reflex.decideMany(requests): Promise<Decision[]>`

Several decisions at once; full-model calls are micro-batched.

## `reflex.observeChoice(decisionId, action, takenBy = "frontier"): boolean`

Report what was actually done after an escalation (or in shadow mode). `action` is an action id, a candidate key, or `{ id, params }`. Returns `false` if the decision is no longer in memory (the choice is still traced).

## `reflex.outcome({ decisionId, status, costUsd?, latencyMs?, tokensIn?, tokensOut?, errorClass?, takenBy? })`

Report the result of executing a step. `status`: `ok | error | empty | timeout`. Repeated reports for the same decision are ignored.

## `reflex.taskOutcome({ taskId, success, score?, costUsd?, latencyMs?, frontierCalls?, feedback? })`

Report whether the whole task succeeded.

## `reflex.prepare(state)`

Pre-compute per-state work while a tool is still running.

## `reflex.speculate(decision, run): { key, result } | undefined`

Start the most likely action early, but only if it is `safe` and `readOnly`.

## `reflex.formatHints(decision): string`

One-line hint for the frontier prompt, e.g. `[reflex] likely next actions: read_file (62%), grep (21%).` Append it *after* your stable prompt prefix so it doesn't break prompt caching.

## `reflex.stats(): MetricsSnapshot`

In-memory counters: decisions, auto rate, by tier, by escalation reason, latency percentiles, shadow agreement, task success, estimated savings.

## Policies

- `reflex.policyVersion`: version in use (`"base"` before any promotion).
- `reflex.reloadPolicy()`: load the currently promoted version.
- `reflex.savePolicy(note?)`: save the live, online-updated policy as a new candidate version (not promoted).
- `reflex.flush()` / `reflex.close()`: flush traces. They are also flushed automatically on process exit.

## Action helpers

```ts
action.tool(id, { risk, readOnly?, description?, paramsSchema? })   // default risk: "stateful" (conservative)
action.model(tier, opts)        // "frontier"-like tiers are marked reasoning
action.frontier(opts)           // "this step needs System 2"
action.retrieval(id?, opts)     // cheap, readOnly
action.cache(id?, opts)         // safe, readOnly
action.search(id?, opts)        // cheap, readOnly
action.retry(id?, opts)         // cheap, kind "retry" (counts toward maxRetriesPerAction)
action.stop(opts) · action.askUser(opts) · action.escalate(id?, opts)
action.custom(id, risk, opts)
action.with(spec, params)       // same action with concrete params (e.g. which file)
```

`paramsSchema` accepts anything with Zod-style `safeParse` or a throwing `parse`. Candidates with invalid params are dropped.

## Backends

```ts
import { functionBackend, HttpBackend, BatchingBackend, type DecisionBackend } from "@reflex-ai/core";

const myModel: DecisionBackend = functionBackend("my-model", async ({ point, question, state, candidates }) => ({
  probs: Object.fromEntries(candidates.map((c) => [c.key, score(state, c)])),
}));
createReflex({ workload: "x", backend: myModel });
```

HTTP contract (implemented by `python/reflex-laya`): `POST /v1/score` `{point, question, state, candidates:[{key,id,kind,description?}]}` → `{probs:{key:p}}`; `POST /v1/score_batch` `{requests:[…]}` → `{results:[…]}`; `GET /healthz`.

## Offline learning

```ts
import { readTraceEvents, buildExamples, trainPolicy, evaluatePolicy, checkPromotion, PolicyRegistry } from "@reflex-ai/core";

const examples = buildExamples(await readTraceEvents(".reflex", "my-agent"));
const { policy, report } = trainPolicy("my-agent", examples);
const gate = checkPromotion(report, undefined);
const registry = new PolicyRegistry(".reflex", "my-agent");
const version = registry.save(policy, "manual train");
if (gate.ok) registry.promote(version);
```

## Sinks

`JsonlSink` (default), `MemorySink` (tests), `NullSink`, or implement `TraceSink { write, flush, close, dropped }`.
