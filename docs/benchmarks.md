# Benchmarks (ReflexBench)

Reflex is judged at the **agent level**: does it lower dollars and seconds per *successful* task without lowering the success rate?

```bash
npx @reflex-ai/cli bench                         # both suites, 300 tasks, seed 42
npx @reflex-ai/cli bench --suite sim-coding --tasks 500 --seed 7 --json --out results.json
```

Each run executes the same seeded tasks twice, once with an **always-frontier** baseline and once with **Reflex learning online from zero**, and reports:

- task success rate and its change in percentage points
- $ per successful task
- frontier calls per task
- wall-clock per task
- Reflex auto rate, auto-decision precision, decision latency p50/p95
- a learning curve over task buckets

## Suites

| Suite | Agent | Notes |
|---|---|---|
| `sim-coding` | Bug fixer: run tests → read the file in the stack trace → frontier writes the fix → run tests → stop | 30% of bugs give an ambiguous error only the frontier can localize; 10% of tool calls fail transiently and need a retry. Picking the right file among 4 candidates is required. |
| `sim-support` | Ticket triage: FAQ cache / RAG + small model / frontier / human | Wrong cheap routes fail the ticket. Human handoff is expensive. |

## Results (v0.1.0, 200 tasks, 8 seeds)

| Suite | Success Δ | $ / successful task | Auto precision |
|---|---|---|---|
| `sim-coding` | 0.0 pp on all seeds | −62.2% to −65.4% | 100% |
| `sim-support` | 0.0 to −1.0 pp | −1.5% to −4.4% | 92–100% |

Decision latency of the local tiers, measured by `reflex doctor` on a laptop CPU: p50 ≈ 0.02 ms, p95 ≈ 0.05 ms.

## What these numbers mean, and what they don't

These suites are **seeded simulations** with an always-correct simulated frontier model and modeled costs and latencies. They verify Reflex's mechanics at the agent level: learning from labels, calibration, safe escalation, credit assignment, and that quality stays inside the 1–2 pp budget. They are **not** evidence of real-world savings.

The support suite shows the trade-off clearly: safety mechanisms (small-sample shrinkage, ≥ 3 observations for the exact cache, audit sampling) cost some savings in exchange for keeping quality within budget.

## Real-agent benchmarking

To measure your own agent, run it in shadow mode, then:

```bash
npx reflex stats      # agreement with your frontier model's choices; would-auto precision
npx reflex train      # held-out coverage and precision with a 95% lower bound
```

Real-agent suites (SWE-bench-style coding, τ-bench-style tool use, research QA) are on the roadmap. Contributions welcome.
