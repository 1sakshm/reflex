# Concepts

## System 1 and System 2

Most steps an agent takes are predictable from its state: re-run the tests, read the file in the stack trace, back off after a rate limit, stop when tests pass. Those are **System 1** decisions. A few steps need real reasoning: designing a fix, synthesizing research, handling an ambiguous request. Those are **System 2**.

Reflex is System 1. It answers routine decisions locally in microseconds to milliseconds, and hands everything else to your frontier model (System 2) or a human.

## The decision ladder

Every `decide()` call climbs a ladder and stops at the first rung that is confident enough:

| Tier | What it is | Typical latency |
|---|---|---|
| 0 | Kill switch / mode | < 0.1 ms |
| 1 | **Rules**: `force`, `deny`, `allowOnly`, `requireEscalation`, plus budgets and loop detection | < 0.5 ms |
| 2 | **Exact decision cache**: this exact state was decided before (≥ 3 observations) | < 0.5 ms |
| 3 | **Pattern table**: "after `run_tests` fails with `ImportError`, the next action is usually `read_file`" | < 1 ms |
| 4 | **Head**: online logistic regression over hashed (state token × action) features; also learns *which params* (e.g. which file) | ~0.02–0.05 ms |
| 4b | **Difficulty head**: P(this step needs System 2), used for early escalation and hedging | ~0.01 ms |
| 6 | **Full model** (optional): Laya (or any backend) scores all candidates in one forward pass | ~33–40 ms GPU; ~1–3 s laptop CPU |
| → | **Escalate** to the frontier model or a human, with top-k hints | seconds |

## Confidence and gating

Each tier produces a probability per candidate. Reflex then:

1. **Calibrates** it (temperature scaling fitted on held-out data by `reflex train`).
2. Applies **small-sample shrinkage** while a tier is uncalibrated: the bar rises toward 1 by `k/(k+n)` until enough labeled examples exist.
3. Compares the top candidate with its **risk-class threshold**, and requires a **margin** over the runner-up.
4. Never auto-executes `destructive` actions, and `stateful` ones only with `allowStateful`.
5. With a single candidate, accepts only evidence-counting tiers (cache, patterns), never a trivially-1.0 softmax.

If the top choice is a `reasoning` action (e.g. `action.frontier()`), Reflex escalates with `reason: "difficulty"`: it is confident the step needs System 2.

## Decisions

```ts
type Decision =
  | { type: "auto"; action; params; confidence; margin; source; reason; hints; latencyMs; … }
  | { type: "escalate"; reason; detail; hints; shadow?; latencyMs; … };
```

Escalation reasons:

| Reason | Meaning |
|---|---|
| `low_confidence` | No tier was sure enough (normal while learning) |
| `difficulty` | Reflex is confident this step needs reasoning |
| `risk` | The likely action is `destructive` or `stateful` and may not be auto-executed |
| `rule` | A `requireEscalation` rule matched, or rules denied every candidate |
| `budget` | A step, cost, frontier-call, wall-clock or retry budget is exhausted |
| `loop` | The same action would be chosen `loopWindow` times in a row |
| `ood` | The state is unfamiliar to the learned tiers |
| `audit` | A confident decision sampled for verification (1 in 50 by default) |
| `timeout` | The full model didn't answer within `timeoutMs`, or the request was aborted |
| `internal_error` | Something inside Reflex failed: it fails open instead of throwing |
| `mode` | Shadow, assist or off mode; `shadow` shows what it would have done |
| `no_candidates` | No valid actions were supplied |

## Modes

- **`shadow`** (default): never acts, logs what it would do. Start here.
- **`assist`**: like shadow, but intended for passing hints to the frontier model.
- **`auto`**: executes confident, allowed decisions.
- **`off`**: no-op passthrough.

## Learning

Reflex learns from three signals:

1. **Labels**: `observeChoice(decisionId, action)` after the frontier (or a human) decides. This is the main signal and teaches all tiers.
2. **Step outcomes**: `outcome({ decisionId, status })`. A failed auto decision is penalized once.
3. **Task outcomes**: `taskOutcome({ taskId, success })`. Success reinforces Reflex's own choices in the task. Failure penalizes the ones whose step failed plus the last two.

Online learning updates the in-memory policy immediately. `reflex train` rebuilds a policy from all traces offline, calibrates it, picks per-risk thresholds that meet a precision target, and saves a versioned candidate. `reflex promote` / `rollback` manage which version is live.

**Audit sampling** keeps labels flowing in auto mode: every Nth confident decision per point still goes to System 2, so live precision stays measured and drift or contradictory labels are noticed.

## Speed features

- **Hedging**: when the difficulty head says a step is probably hard, `onHedge` fires *before* the full model runs, so you can start the frontier call in parallel and cancel it if Reflex ends up confident.
- **Speculation**: `reflex.speculate(decision, run)` starts the most likely action early, but only if it is `safe` and `readOnly`.
- **Batching**: `decideMany()` sends several decisions to the backend in one pass. The Laya sidecar groups decisions that share a state into one forward pass.
- **Hard deadline**: `timeoutMs` (default 75 ms). Reflex never makes your agent wait longer.

## Traces and privacy

Every decision, choice, outcome and task result is appended to `.reflex/traces/<workload>/YYYY-MM-DD.jsonl`. Before anything is stored or learned from, Reflex redacts secrets: API keys, tokens, JWTs, private keys, bearer headers, `password=…`, and any field named like a secret. Nothing leaves your machine. Retention defaults to 30 days.
