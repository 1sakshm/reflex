# Reflex

[![CI](https://github.com/1sakshm/reflex/actions/workflows/ci.yml/badge.svg)](https://github.com/1sakshm/reflex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@reflex-ai/core?label=%40reflex-ai%2Fcore)](https://www.npmjs.com/package/@reflex-ai/core)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**A local, ultra-fast "System 1" decision runtime for AI agents.**

Agents use frontier models for hard reasoning, and also for hundreds of tiny decisions: *which tool next, search or not, read another file, retry, which model tier, stop?* Reflex makes those micro-decisions locally in **microseconds to milliseconds**, returns calibrated confidence, executes high-confidence low-risk actions immediately, and escalates everything else to Claude/GPT/Gemini or a human. It learns from outcomes, so each workload converges on its cheapest successful execution policy.

> Stop using a hundreds-of-billions-of-parameters reasoning model to make a three-option decision.

```bash
npm install @reflex-ai/core            # zero-dependency runtime
npx @reflex-ai/cli init                # optional CLI: init · stats · train · serve · mcp · bench
```

**Website:** [1sakshm.github.io/reflex](https://1sakshm.github.io/reflex/) · **Docs:** [Getting started](docs/getting-started.md) · [Concepts](docs/concepts.md) · [Configuration](docs/configuration.md) · [API](docs/api.md) · [Integrations](docs/integrations.md) · [Benchmarks](docs/benchmarks.md) · [FAQ](docs/faq.md) · [Product spec (PRD)](PRD.md)

```text
 agent state ──▶ REFLEX ladder (stops at the first confident tier)
                   0 kill switch / mode        <0.1 ms
                   1 rules (force/deny/budget) <0.5 ms
                   2 exact decision cache      <0.5 ms
                   3 trajectory pattern table  <1 ms
                   4 hashed head + difficulty  ~0.02–0.05 ms measured
                   6 full model (Laya sidecar) ~33–40 ms on GPU (0.8–2.7 s on a laptop CPU)
                 ──▶ AUTO: execute    or    ESCALATE: frontier / human (+ hints)
                 ──▶ traces ──▶ learn online + `reflex train` ──▶ versioned policy
```

## Results so far (ReflexBench, simulated)

`npx reflex bench`, 200 tasks per suite, 8 seeds (1, 2, 3, 7, 42, 99, 123, 2026), against an always-frontier baseline on the same tasks:

| Suite | Task success Δ | $ / successful task | Frontier calls / task | Wall-clock / task | Auto-decision precision |
|---|---|---|---|---|---|
| `sim-coding` (tests → locate → edit → tests → stop) | **0.0 pp** on all seeds | **−62.2% to −65.4%** | ≈ −62% | ≈ −43% | 100% |
| `sim-support` (FAQ cache / RAG / frontier / human) | 0.0 to −1.0 pp | −1.5% to −4.4% | ≈ −12% | ≈ −8% | 92–100% |

Local decision latency, measured by `reflex doctor` on a laptop CPU: **p50 0.021 ms, p95 0.050 ms** (rules → cache → patterns → head).

> **Honest caveat:** these suites are seeded simulations with an always-correct simulated frontier model and modeled costs and latencies. They validate Reflex's mechanics at the agent level: learning from labels, calibration, safe escalation, and credit assignment. They are **not** evidence of real-world savings. Real-agent benchmarks (SWE-bench-style, τ-bench-style) are the next milestone.

## Quickstart (2 minutes, no API key)

```bash
git clone https://github.com/1sakshm/reflex && cd reflex && npm install
cd examples
npm run quickstart            # shadow mode: Reflex only watches
npm run stats                 # what it would have done
npm run train                 # learn + calibrate a policy, promote it if it clears the gate
npm run quickstart -- --auto  # Reflex now takes the routine calls
```

Typical output: shadow mode would have auto-decided 63 of 117 labeled decisions at 100% precision. After `train --promote`, auto mode handles **89 of 120** decisions locally, with 100% task success. The rest are the genuine reasoning questions, which it correctly escalates, plus one audit sample.

## Use it in an agent (TypeScript)

```ts
import { action, createReflex } from "@reflex-ai/core";

const reflex = createReflex({ workload: "coding-agent", mode: "shadow" }); // start safe

const actions = [
  action.with(action.tool("read_file", { risk: "safe", readOnly: true }), { path: "src/date.ts" }),
  action.tool("run_tests", { risk: "costly" }),
  action.tool("write_file", { risk: "stateful" }), // never auto-executed unless allowStateful
  action.frontier(),                                 // "this step needs real reasoning"
  action.stop(),
];

const d = await reflex.decide({ point: "next_action", taskId, state: { goal, lastAction, lastObservation, history }, actions });
if (d.type === "auto") {
  run(d.action, d.params);                                 // System 1
} else {
  const chosen = await askFrontier(state, reflex.formatHints(d)); // System 2
  reflex.observeChoice(d.id, chosen);                      // ← the learning signal
}
reflex.taskOutcome({ taskId, success });
```

Adoption ladder: **shadow** (log only) → `reflex stats` → **assist** (hints only) → **auto** on `safe` actions → `reflex train --promote` → wider auto with learned thresholds. A complete Claude-powered coding agent is in [examples/claude-coding-agent.ts](examples/claude-coding-agent.ts).

## What's in the box

| Path | What it is |
|---|---|
| [`packages/core`](packages/core) | `@reflex-ai/core`: the runtime. Zero runtime dependencies. Ladder, rules, budgets, loop detection, calibration, risk gating, modes, hedging, speculation, traces, policy registry, offline training and evaluation. |
| [`packages/server`](packages/server) | `@reflex-ai/server`: local HTTP sidecar (+ `/ui` dashboard, token auth) and a dependency-free **MCP server** (stdio). |
| [`packages/cli`](packages/cli) | `@reflex-ai/cli`: `reflex init · doctor --tune · trace · stats · train · eval · policies · promote · rollback · serve · mcp · laya · bench` |
| [`packages/bench`](packages/bench) | `@reflex-ai/bench`: ReflexBench harness and simulated suites; agent-level metrics and learning curves. |
| [`plugins/claude-code`](plugins/claude-code) | Claude Code plugin: hooks (unchanged re-read and duplicate-fetch blocking, loop stopping, destructive-command gating, opt-in auto-approve), skill, commands, MCP tools. |
| [`integrations/codex`](integrations/codex) | Codex setup via MCP + AGENTS.md guidance. |
| [`python/reflex-laya`](python/reflex-laya) | **Laya full-model sidecar** (tier 6). Groups decisions that share a state into one forward pass. `--mock` scorer for CI. |
| [`python/reflex-agent-client`](python/reflex-agent-client) | Minimal fail-open Python client for the sidecar (`pip install reflex-agent-client`). |
| [`examples`](examples) | No-key quickstart; Claude coding agent (`claude-opus-5-5`, prompt caching, server-side fallbacks). |

## Integrations

**TypeScript, in-process (fastest):** `createReflex()` as above.

**Any language, via sidecar:**
```bash
npx @reflex-ai/cli serve --port 7070   # dashboard at http://127.0.0.1:7070/ui
curl -s localhost:7070/v1/decide -d '{"point":"next_tool","state":{"goal":"..."},"actions":[{"id":"read_file","kind":"tool","risk":"safe"}]}'
```
Endpoints: `POST /v1/decide · /v1/decide_many · /v1/observe · /v1/outcome · /v1/task · /v1/policy/reload`, `GET /v1/metrics · /healthz · /ui`. Non-loopback binding requires `--token`.

**Python:** `pip install reflex-agent-client`, then `from reflex_agent import Reflex, action`. See [python/reflex-agent-client](python/reflex-agent-client).

**MCP (any MCP client):** `npx -y @reflex-ai/cli mcp`. Tools: `reflex_decide`, `reflex_decide_many`, `reflex_observe_choice`, `reflex_outcome`, `reflex_task_outcome`, `reflex_route_subtask`, `reflex_metrics`.

**Claude Code:**
```bash
claude plugin marketplace add 1sakshm/reflex
claude plugin install reflex@reflex
```
Then `/reflex-status` shows what it blocked. Configure in `~/.reflex/claude-code.json`; `REFLEX_DISABLE=1` turns it off. In Claude Code the host model still makes each turn's decision itself, so the plugin removes *wasted* work (re-reads, duplicate fetches, loops) rather than replacing turns. The biggest savings come from SDK/framework integrations (PRD §15.1).

**Codex:** add `npx -y @reflex-ai/cli mcp` as an MCP server; see [integrations/codex](integrations/codex/README.md).

**Laya (full-model tier):**
```bash
pip install "reflex-laya[laya]"                 # Laya + PyTorch (on Windows, torch 2.5.x is known-good)
reflex-laya --checkpoint english --device cpu   # or `reflex-laya --mock`: no model, same API
```
then set `backend: { type: "laya" }` in `reflex.config.ts`. Reflex enforces `timeoutMs` (default 75 ms) and fails open if the sidecar is slow or down. **Use it with a GPU**: on a laptop CPU the real model measured 0.8–2.7 s per decision, and its zero-shot top choice was right in 2 of 4 test situations (Reflex's gating escalated both misses). On CPU, the default local tiers are the right choice. Details: [integrations](docs/integrations.md#laya-the-full-model-tier).

## Safety model

- **Fail open:** any internal error, timeout or unavailable backend becomes `escalate`. Reflex never throws into your agent or makes it wait past `timeoutMs`.
- **Risk classes are mandatory:** `safe` < `cheap` < `costly` < `stateful` < `destructive`. Auto-execute thresholds rise with risk. `stateful` needs `allowStateful`. **`destructive` is never auto-executed**, even when the model is 99% confident; a `force` rule only works with `allowDestructive`.
- **Small-sample shrinkage:** an uncalibrated online head must clear a higher bar until it has seen enough examples. This is what keeps early mistakes rare (see the support results). The exact cache needs ≥ 3 observations of the identical state.
- **Audit sampling:** in auto mode, 1 in 50 confident decisions still goes to System 2 (`reason: "audit"`), so Reflex keeps measuring its live precision and notices drift or contradictory labels.
- **Rules always win:** `force`, `deny`, `allowOnly`, `requireEscalation`, plus budgets and loop detection.
- **Promotion gate:** `reflex train` fits calibration and thresholds on one held-out slice and reports metrics on a separate one. It refuses to promote a policy whose precision (or its 95% Wilson lower bound) is too low or regresses. `reflex rollback` is instant.
- **Privacy:** local by default, no telemetry. Secrets (API keys, tokens, JWTs, private keys, `password=…`) are redacted before anything is stored or learned from.
- **Kill switch:** `REFLEX_DISABLE=1` overrides everything.

## Development

```bash
npm install
npm test               # 51 tests (core, regressions, server, MCP, CLI e2e, bench, Claude Code hooks, TS↔Python integration)
npm run test:python    # Laya sidecar + Python client
npm run typecheck
npm run build          # dist/ for publishing
npm run reflex -- bench
```

Node ≥ 22.18 runs the TypeScript sources directly (`--conditions=reflex-source`); the built `dist/` supports Node ≥ 22.

## Status vs the PRD

Built in v0.1: everything above. **Not yet built** (tracked from the PRD):

- In-process ONNX/WebGPU backend, distilled "Reflex-Mini" student, LoRA adapters, early-exit layers. Tier 6 currently runs via the Laya sidecar.
- Semantic (embedding) decision cache (tier 5), conformal selective prediction, contextual-bandit exploration.
- Canary rollouts with auto-rollback, OpenTelemetry export, SQLite trace store (JSONL is used today), signed releases/SBOM.
- Framework adapters (Vercel AI SDK, OpenAI Agents SDK, LangGraph, Mastra), auto-import of MCP tool lists into action spaces.
- Real-agent ReflexBench suites (coding, research, tool-use, browser, voice) and published reproducible results.

## License

[Apache-2.0](LICENSE)
