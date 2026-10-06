# Reflex — Product Requirements Document

> **A local, ultra-fast "System 1" decision runtime for AI agents.**
> Let Reflex handle the reflexes. Save the frontier model for actual reasoning.

| Field | Value |
|---|---|
| Document | Product Requirements Document (PRD) |
| Product | Reflex |
| Version | 0.1 (Draft) |
| Date | 2026-10-06 |
| Owner | Saksham Sharma |
| Status | Draft, open for review |
| Default decision model | Laya (pluggable) |
| License (proposed) | Apache-2.0 (core, SDKs, MCP server, plugins) |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Core Thesis and Insight](#3-core-thesis-and-insight)
4. [Goals and Non-Goals](#4-goals-and-non-goals)
5. [Target Users and Personas](#5-target-users-and-personas)
6. [Use Cases and User Stories](#6-use-cases-and-user-stories)
7. [Competitive Landscape and Differentiation](#7-competitive-landscape-and-differentiation)
8. [Product Principles](#8-product-principles)
9. [Core Concepts and Vocabulary](#9-core-concepts-and-vocabulary)
10. [System Architecture](#10-system-architecture)
11. [The Decision Pipeline](#11-the-decision-pipeline)
12. [Speed Architecture](#12-speed-architecture)
13. [Functional Requirements](#13-functional-requirements)
14. [Developer Experience and API Design](#14-developer-experience-and-api-design)
15. [Integration Surfaces](#15-integration-surfaces)
16. [The Learning System](#16-the-learning-system)
17. [Data Model](#17-data-model)
18. [Non-Functional Requirements](#18-non-functional-requirements)
19. [Safety, Guardrails and Trust](#19-safety-guardrails-and-trust)
20. [Evaluation and Benchmarking (ReflexBench)](#20-evaluation-and-benchmarking-reflexbench)
21. [Success Metrics and KPIs](#21-success-metrics-and-kpis)
22. [Roadmap and Milestones](#22-roadmap-and-milestones)
23. [Go-To-Market, Open Source and Community](#23-go-to-market-open-source-and-community)
24. [Risks and Mitigations](#24-risks-and-mitigations)
25. [Open Questions](#25-open-questions)
26. [Appendices](#26-appendices)

---

## 1. Executive Summary

Today's AI agents (Claude Code, Codex, browser agents, research agents, customer-support agents) use expensive frontier reasoning models for two very different kinds of work:

1. **Real reasoning:** designing a fix, synthesizing research, writing code, handling an ambiguous customer.
2. **Micro-decisions:** *Which tool next? Search the web or not? Read another file? Is the cache good enough? Retry? Which model tier? Stop? Ask the human?*

The second category is high-frequency, low-entropy and usually has 2–10 possible answers. Yet every one of these decisions often costs a full frontier-model round trip: hundreds of milliseconds to several seconds, thousands of context tokens, and real dollars.

**Reflex** is an open-source, local-first runtime that moves these micro-decisions out of the frontier LLM and into a fast, small decision model (Laya by default). For each decision point, Reflex:

1. Applies deterministic **rules** (hard constraints, policy, safety).
2. Runs a **small decision model** that scores a structured set of candidate actions in tens of milliseconds.
3. Produces **calibrated confidence**.
4. **Executes** high-confidence, low-risk actions immediately.
5. **Escalates** uncertain, high-risk or genuinely hard decisions to the frontier model (Claude, GPT, Gemini, …) or to a human.
6. **Records outcomes** (latency, cost, task success) and **learns** the cheapest successful execution policy for each workload over time.

Unlike model routers, which decide *which LLM answers a prompt*, Reflex **schedules an agent's whole execution path**. Models are one kind of action, alongside tools, retrieval, caches, search, retries, stopping and escalation.

Reflex will ship as:

- A **TypeScript/JavaScript SDK** (first-class, v1)
- An **MCP server**
- A **Claude Code plugin** (hooks + skill) and a **Codex integration**
- A **CLI** for tracing, replay, evaluation and policy training
- Later: a **Python SDK** and adapters for LangGraph, OpenAI Agents SDK, Vercel AI SDK, Mastra, CrewAI, LlamaIndex and others.

**Speed at a glance:**

| Who makes the micro-decision | Typical time |
|---|---|
| Reflex rules / cache / tiny head | < 1–3 ms |
| Reflex full decision model (GPU) | ~10–40 ms |
| Small/fast LLM | ~300 ms – 1 s |
| Frontier LLM | ~1 – 5+ s |

Reflex doesn't generate tokens, doesn't leave the machine and reads a compact state instead of the full context, so its decisions are **10–1000× faster** than asking any LLM. With tiered early exit, pre-decision and hedged escalation (§12), it aims to add **≈ 0–5 ms** to the agent's critical path.

**North-star outcome:** lower **dollars per successful task** and lower **wall-clock time per successful task**, with task success within **1–2 percentage points** of an always-frontier baseline, and **< 25–50 ms** worst-case decision overhead (≤ 5 ms p50 on the critical path).

---

## 2. Problem Statement

### 2.1 The "frontier tax" on trivial decisions

A typical agent loop looks like this:

```text
loop:
  state  = observe()
  action = frontier_llm(state)      # ← every step, including trivial ones
  result = execute(action)
  if done(result): break
```

Every step pays the full price of the frontier model, whether the step is "design the migration strategy" or "the test failed with a missing import, so read the file that defines it."

From the agent's point of view, many steps are *reflexes*:

| Micro-decision | Typical answer set | Does it need frontier reasoning? |
|---|---|---|
| Which tool should I call next? | 3–20 tools | Usually no |
| Should I search the web? | yes / no | Usually no |
| Should I read another file? | yes / no / which file | Often no |
| Is the cached answer good enough? | use / refresh | Usually no |
| The call failed. Should I retry? | retry / back off / give up / escalate | Usually no |
| Which model tier does this subtask need? | small / mid / frontier | No (that's the point) |
| Run the tests now? | yes / no | Usually no |
| Am I done? | stop / continue | Sometimes |
| Should I escalate to a human? | yes / no | Sometimes, and it's high-stakes |

### 2.2 Costs of the status quo

- **Dollar cost:** each frontier step re-reads a large, growing context. Micro-decisions inherit the full context cost of the agent.
- **Latency:** frontier round trips are typically hundreds of ms to several seconds. A 40-step task with 25 trivial steps wastes much of its wall-clock time on reflexes.
- **Rate limits and capacity:** trivial calls use up token-per-minute and request-per-minute budgets that should go to hard work.
- **Context pollution:** each trivial step adds tokens to the transcript, which degrades long-horizon reasoning and triggers compaction sooner.
- **No learning:** the agent makes the same micro-decision the same expensive way on every run, with no memory of what was cheapest and still worked.

### 2.3 Why existing tools don't solve it

- **Model routers** (e.g., Not Diamond, LiteLLM Auto Router, RouteLLM-style approaches) choose *which model* handles a *prompt*. They don't decide whether to call a model at all, which tool to run, whether to hit the cache, or whether to stop.
- **Hand-written heuristics** in agent code are brittle, workload-specific, don't produce calibrated confidence and don't improve with use.
- **Prompt caching** lowers the cost of a frontier call but doesn't remove the call or its latency.
- **Smaller general LLMs as routers** are still autoregressive generators (hundreds of ms or more) and are poorly calibrated for structured choices.

---

## 3. Core Thesis and Insight

> **Stop using a hundreds-of-billions-of-parameters reasoning model to make a three-option decision.**

1. **Most agent steps are low-entropy.** Given the state, the right next action is predictable most of the time. This is "System 1": fast, automatic, pattern-based.
2. **A small discriminative model can score structured options in one forward pass.** Laya reportedly reaches ~32.8 ms (multilingual checkpoint) and ~39.5 ms (English checkpoint) single-question latency on a T4 GPU, and several questions can share one forward pass. This turns a decision into a classification/scoring problem instead of a generation problem. Even unoptimized, that's 10–100× faster than an LLM round trip, and the speed architecture in §12 pushes most decisions into the low single-digit milliseconds.
3. **Calibrated confidence makes it safe.** If Reflex knows when it doesn't know, it can hand the decision to "System 2" (the frontier model) only when needed. Quality is preserved; most savings come from the easy majority.
4. **Outcome learning creates a moat.** A static classifier is a commodity. A runtime that learns the *cheapest successful policy per workload* from its own outcomes improves with use, and a coding agent, a voice agent and a research agent each end up with different policies tuned to their own results.
5. **The metric that matters is agent-level.** Classification accuracy is a proxy. The real measure is *dollars and seconds per successful task at the same success rate.*

**Market signal (to re-verify before external publication):** LiteLLM has publicly reported a RouterArena result of 74.5% lower cost while keeping 87.3% of frontier quality, and a production case study of 51.1% savings across 272,876 requests. That's model routing alone. Reflex aims for more by routing the *entire execution path* and by holding quality to within 1–2 points of frontier rather than ~87%.

---

## 4. Goals and Non-Goals

### 4.1 Goals (v1.0)

| # | Goal | Measure |
|---|---|---|
| G1 | Cut frontier-model calls per task | ≥ 40% fewer frontier calls per successful task on ReflexBench coding and research suites |
| G2 | Cut cost per successful task | ≥ 30% lower $/successful task vs always-frontier baseline |
| G3 | Keep quality | Task success within −2 pp (target −1 pp) of always-frontier baseline |
| G4 | Be fast | Critical-path overhead p50 ≤ 5 ms, p95 ≤ 25 ms; full-model decision p50 ≤ 25 ms / p95 ≤ 50 ms on reference GPU, p50 ≤ 60 ms on reference CPU; ≥ 30% faster wall-clock per successful task (see §12, §18) |
| G5 | Be easy to adopt | Working integration in ≤ 15 minutes and ≤ 20 lines of code for an existing TS agent loop |
| G6 | Be safe by default | Zero auto-executed actions in the `destructive` risk class without explicit opt-in; fail-open to frontier on any Reflex error |
| G7 | Learn from outcomes | Measurable improvement in $/successful task over the first 1,000 tasks of a workload, with no labeled data required |
| G8 | Be transparent | Every decision traceable: inputs, candidates, scores, confidence, rule hits, outcome |

### 4.2 Non-Goals (v1.0)

- **Not a frontier model replacement.** Reflex never tries to do the reasoning; it decides *whether and where* reasoning happens.
- **Not an agent framework.** Reflex plugs into existing loops and frameworks. It doesn't own the loop.
- **Not a general LLM gateway/proxy.** It may integrate with gateways (LiteLLM, OpenRouter), but it doesn't aim to be one.
- **Not a hosted service in v1.** Local-first. A hosted/team control plane is a possible later product (§23).
- **Not open-ended generation.** Reflex outputs a choice from a declared action space (plus optional structured parameters), not free text.
- **No training of the base decision model from scratch** in v1. Reflex fine-tunes heads/adapters and policies on top of Laya or other backends.

---

## 5. Target Users and Personas

### P1 — "Agent Builder Asha" (primary)
- Builds custom agents in TypeScript (Vercel AI SDK, OpenAI Agents SDK, Mastra, LangGraph.js or a hand-rolled loop).
- Pain: LLM bill grows with usage; agent feels slow; latency SLOs for user-facing products.
- Wants: a drop-in way to remove wasted calls without rewriting the agent, plus proof that quality didn't drop.

### P2 — "Power User Pranav" (Claude Code / Codex user)
- Uses Claude Code or Codex all day; pays for usage or hits rate limits.
- Pain: the agent burns turns on trivial steps, re-reads files, runs searches it doesn't need, retries blindly.
- Wants: install a plugin, see fewer wasted turns and a lower bill, no coding required.

### P3 — "Platform Engineer Priya"
- Runs agents in production at a company (support bots, internal research agents, voice agents).
- Pain: cost at scale, p95 latency, governance and auditability.
- Wants: per-workload policies, dashboards, safe rollout (shadow mode, canaries), audit logs, data staying on-prem.

### P4 — "Researcher Rahul"
- Studies agent efficiency, routing and learned scheduling.
- Wants: an open benchmark (ReflexBench), reproducible traces, pluggable decision models and policies.

### Anti-persona
- Teams wanting a hosted chatbot or a model-quality leaderboard. Reflex is infrastructure for agent builders.

---

## 6. Use Cases and User Stories

### 6.1 Flagship use cases

**UC1 — Coding agent tool selection.** After a failing test, decide between `read_file(path)`, `grep(symbol)`, `run_tests(subset)`, `edit` (needs frontier) or `ask_user`. Reflex handles navigation and inspection steps; the frontier model handles edits and design.

**UC2 — Research agent search gating.** Decide whether a sub-question needs web search, can be answered from RAG, is already in the cache, or needs frontier synthesis.

**UC3 — Retry/backoff policy.** On a tool error (timeout, 429, flaky test, network), decide retry-now / retry-with-backoff / switch-tool / escalate / give-up, learned from which choice actually recovered in the past.

**UC4 — Model tier selection for subtasks.** For each subtask (summarize log, classify intent, write function), choose small / mid / frontier model, with escalation if the small model's output fails validation.

**UC5 — Stop / continue.** Decide whether the agent has met the goal (tests green, answer complete), saving trailing "let me double check" turns, or flag that more work is needed.

**UC6 — Customer support triage.** Route each message to FAQ cache, KB retrieval + small model, frontier model, or human agent, with a calibrated human-escalation threshold.

**UC7 — Voice agent turn handling.** Under strict latency budgets (< 300 ms total), decide in real time whether a canned/cached response, a small model or the frontier model should produce the turn.

### 6.2 User stories

| ID | As a… | I want to… | So that… | Priority |
|---|---|---|---|---|
| US1 | Agent builder | wrap my agent's step function with `reflex.decide()` | trivial steps skip the frontier model | P0 |
| US2 | Agent builder | declare my action space with typed schemas | Reflex only picks valid actions with valid params | P0 |
| US3 | Agent builder | set per-action risk levels and confidence thresholds | dangerous actions are never auto-executed | P0 |
| US4 | Agent builder | run Reflex in shadow mode | I can measure agreement and savings before enabling it | P0 |
| US5 | Agent builder | report task outcomes with one call | Reflex learns which policies succeed | P0 |
| US6 | Claude Code user | install a plugin with one command | I get savings without writing code | P1 |
| US7 | Platform engineer | see $/task, escalation rate and success rate per workload | I can prove ROI and catch regressions | P1 |
| US8 | Platform engineer | pin, version and roll back policies | a bad policy can't silently degrade production | P1 |
| US9 | Researcher | export traces and replay them against a new policy offline | I can evaluate policies without running live agents | P1 |
| US10 | Any user | add hard rules (allow/deny/force) that override the model | I keep deterministic control | P0 |
| US11 | Any user | get a human-readable reason for each decision | I can debug and trust Reflex | P1 |
| US12 | Python agent builder | use the same API in Python | I can adopt Reflex in Python stacks | P2 |

---

## 7. Competitive Landscape and Differentiation

| Category | Examples | What they decide | Gap that Reflex fills |
|---|---|---|---|
| Model routers | Not Diamond, RouteLLM-style routers, Martian | Which LLM answers a prompt | Doesn't decide tools, cache, retries, stopping or escalation; prompt-level, not agent-step-level |
| Gateway auto-routing | LiteLLM Auto Router, OpenRouter auto | Model tier per request (heuristic, LLM classifier or System-One-style model) | Gateway sees requests, not agent state or task outcomes; doesn't schedule execution paths |
| Agent frameworks | LangGraph, OpenAI Agents SDK, Mastra, CrewAI | Orchestration structure, defined by the developer | Routing is hand-coded or LLM-driven; no learned, calibrated, cost-aware fast path |
| Semantic caches | GPTCache, gateway caches | Cache hit/miss by similarity | One action type only; no policy over alternatives |
| Guardrail tools | NeMo Guardrails, Guardrails AI | Allow/deny/validate | Safety filters, not efficiency schedulers |
| Small LLMs as routers | Haiku-class, 1–8B local models | Anything, via generation | Too slow for per-step reflexes; weak calibration; output parsing errors |

### Reflex's differentiation

1. **Action-space generality.** Models, tools, retrieval, cache, search, retry, stop, ask-user and escalate are all first-class actions in one policy.
2. **Agent-state awareness.** Decisions use the trajectory (recent steps, errors, budget used, goal), not just the current prompt.
3. **Calibrated confidence with risk-aware thresholds.** "Know when you don't know" is the core feature, not an add-on.
4. **Outcome learning per workload.** The policy improves from task success and cost signals, not just labels.
5. **Local-first and fast.** Runs on the developer's machine or inside the deployment; no extra network hop, no data leaving the boundary.
6. **Open source and pluggable.** Laya by default, with any decision model behind a common interface.

**Positioning statement:** *For teams building or running AI agents, Reflex is the open-source System-1 runtime that makes an agent's routine decisions in milliseconds and learns the cheapest path to success. Model routers pick a model per prompt; Reflex schedules the agent's whole execution path and sends only real reasoning to the frontier.*

---

## 8. Product Principles

1. **Fail open, never fail stuck.** Any Reflex error, timeout or low-confidence result falls back to the frontier model, so Reflex can only add speed, never take away correctness.
2. **Quality is the constraint; cost is the objective.** Optimize $/task and latency *subject to* success-rate parity.
3. **Escalation is a feature, not a failure.** A well-calibrated escalation is a correct decision.
4. **Deterministic first, learned second.** Rules and hard constraints run before the model and always win.
5. **Everything is traceable.** No decision without a trace record and a reason.
6. **Minimal intrusion.** Adoption should be a wrapper, not a rewrite.
7. **Local and private by default.** No telemetry leaves the machine unless the user explicitly opts in.
8. **Measure at the agent level.** Every feature is judged by ReflexBench task-level metrics, not proxy accuracy.
9. **Never make the agent wait.** Speed is the product. Do the cheapest check first, overlap work with tool execution, and keep everything that isn't the decision off the critical path.

---

## 9. Core Concepts and Vocabulary

| Concept | Definition |
|---|---|
| **Decision Point** | A named place in the agent loop where a choice is made (e.g., `next_tool`, `should_search`, `on_error`, `model_tier`, `should_stop`). |
| **State** | The structured input for a decision: goal, recent trajectory, last observation, errors, budgets used, workload metadata. Reflex serializes and truncates it into a compact feature representation. |
| **Action** | A typed option the agent can take. Has an `id`, a `kind` (`tool`, `model`, `retrieval`, `cache`, `search`, `retry`, `stop`, `ask_user`, `escalate`, `custom`), an optional parameter schema, a `risk` class and a cost/latency prior. |
| **Action Space** | The set of valid actions at a decision point, possibly filtered dynamically by rules. |
| **Policy** | The function mapping (state, action space) → scored actions. Made of rules + decision model + learned adjustments. Versioned. |
| **Confidence** | A calibrated probability that the chosen action is the one the reference policy (frontier or outcome-optimal) would have taken / that it leads to success. |
| **Threshold** | The minimum confidence to auto-execute. Can depend on action risk and workload. |
| **Escalation** | Handing the decision to System 2 (frontier LLM) or a human, optionally with Reflex's top-k candidates as hints. |
| **Outcome** | Observed result of an action and of the overall task: success/failure, latency, tokens, $ cost, user feedback. |
| **Trace** | The immutable record of a decision and its outcome, used for observability, replay and learning. |
| **Workload** | A logical grouping (e.g., `coding-agent/repo-x`, `support-bot/billing`) that owns its own policy and metrics. |
| **Mode** | `off`, `shadow` (predict and log only), `assist` (suggest to the frontier as a hint), `auto` (execute when confident). |

---

## 10. System Architecture

### 10.1 High-level flow

```text
                         ┌──────────────────────┐
                         │    AGENT / USER      │
                         │ Claude • Codex • etc │
                         └──────────┬───────────┘
                                    │  decision point + state
                                    ▼
          ┌─────────────────────────────────────────────────────┐
          │                        REFLEX                       │
          │                                                     │
          │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
          │  │ State    │→ │ Rules    │→ │ Decision Cache   │   │
          │  │ Encoder  │  │ Engine   │  │ (exact/semantic) │   │
          │  └──────────┘  └──────────┘  └────────┬─────────┘   │
          │                                       ▼             │
          │  ┌──────────────────┐   ┌──────────────────────┐    │
          │  │ Decision Model   │ → │ Calibrator + Risk-   │    │
          │  │ (Laya / ONNX /   │   │ aware Threshold Gate │    │
          │  │  custom backend) │   └──────────┬───────────┘    │
          │  └──────────────────┘              │                │
          │                       ┌────────────┴───────────┐    │
          │                       ▼                        ▼    │
          │                  AUTO-EXECUTE              ESCALATE │
          │                                                     │
          │  ┌───────────────────────────────────────────────┐  │
          │  │ Trace Store → Outcome Joiner → Policy Learner │  │
          │  └───────────────────────────────────────────────┘  │
          └─────────────────────────────────────────────────────┘
                 │                                   │
     ┌───────────┼──────────┬──────────┐             ▼
     ▼           ▼          ▼          ▼   ┌────────────────────────┐
   CACHE       TOOL       RAG     SMALL LLM│ Frontier reasoning LLM │
   SEARCH     RETRY      STOP     ASK USER │ Claude / GPT / Gemini  │
                                           │ (or human)             │
                                           └────────────────────────┘
```

### 10.2 Components

| Component | Responsibility | v1 implementation notes |
|---|---|---|
| **SDK Core** (`@reflex/core`) | Public API, decision orchestration, modes, fail-open logic | TypeScript, zero required native deps for rules-only mode |
| **State Encoder** | Turns agent state into a compact, model-ready representation; handles truncation, redaction and hashing | Pluggable encoders per agent type (coding, research, support) |
| **Rules Engine** | Deterministic allow/deny/force/filter rules; budget limits; safety constraints | Declarative YAML/TS config + TS predicate functions |
| **Decision Cache** | Returns a prior decision for identical/near-identical states | Exact hash cache in v1; semantic (embedding) cache in v1.x |
| **Decision Model Runtime** | Scores candidate actions; supports batching several decision questions in one forward pass | Backends: Laya (default), ONNX Runtime (CPU/GPU), remote HTTP sidecar, custom |
| **Calibrator** | Maps raw scores to calibrated probabilities per workload | Temperature scaling (v1), isotonic / conformal (v1.x) |
| **Threshold Gate** | Decides auto-execute vs escalate using confidence, risk class and budget | Risk-weighted thresholds; per-workload overrides |
| **Escalation Handler** | Calls the configured System-2 path with optional hints (top-k candidates, reason) | Callback-based; agent owns the frontier call |
| **Trace Store** | Append-only log of decisions and outcomes | SQLite (local default), JSONL export, OpenTelemetry spans |
| **Outcome Joiner** | Links decision traces to step and task outcomes for credit assignment | Uses `taskId`/`stepId` correlation |
| **Policy Learner** | Offline training of calibration, thresholds, adapters and bandit policies | CLI-driven (`reflex train`) in v1; background in v1.x |
| **Policy Registry** | Versioned policies per workload; pin, promote, roll back | Local files + manifest; signed in later versions |
| **MCP Server** | Exposes Reflex as MCP tools/resources | `@reflex/mcp` |
| **Plugins** | Claude Code plugin (hooks + skill), Codex integration | See §15 |
| **CLI** | `init`, `serve`, `trace`, `replay`, `eval`, `train`, `promote`, `bench` | `reflex` binary via npm |
| **Dashboard** | Local web UI for traces, metrics and policies | `reflex ui` (v1.x) |

### 10.3 Deployment modes

1. **In-process (default for TS):** decision model loaded via ONNX Runtime for Node / WebGPU; lowest latency.
2. **Local sidecar:** `reflex serve` exposes a local HTTP/gRPC/Unix-socket API, used by MCP, Python and multiple agents sharing one GPU-loaded model.
3. **Rules-only / lite:** no model loaded; deterministic rules + cache only. Zero heavy dependencies, useful for CI and for trying it out.
4. **Remote (later):** self-hosted Reflex server for a team or fleet.

---

## 11. The Decision Pipeline

Each `decide()` call runs this pipeline. Total budget: **p50 ≤ 25 ms, p95 ≤ 50 ms** (reference GPU).

```text
 1. Validate input & resolve decision point config            (~0.1 ms)
 2. Encode state (truncate, redact, featurize)                (~1–3 ms)
 3. Rules engine
      ├─ FORCE rule hit  → return forced action (confidence=1, source=rule)
      ├─ DENY rules      → remove actions from candidate set
      └─ budget checks   → may force escalate/stop
 4. Decision cache lookup → hit with fresh TTL → return (source=cache)
 5. Decision model scoring of remaining candidates            (~10–40 ms)
      (batched with other pending decision questions where possible)
 6. Calibrate scores → probabilities
 7. Threshold gate:
      p(top) ≥ threshold(risk(top), workload) AND margin ≥ min_margin
        → AUTO   (execute / return action)
      else
        → ESCALATE (return top-k hints + reason)
 8. Emit trace (async, non-blocking)
 9. Later: outcome() joins result → learning
```

**Timeout behavior:** if steps 2–7 exceed the configured `timeoutMs` (default 75 ms), Reflex returns `ESCALATE` with `reason: "timeout"`. The agent never waits on Reflex longer than the budget.

**Error behavior:** any exception inside Reflex → `ESCALATE` with `reason: "internal_error"`, logged, never thrown to the caller (unless `strict: true`).

### 11.1 Risk-aware thresholds

Not all mistakes cost the same. Reflex uses asymmetric thresholds by action risk class:

| Risk class | Examples | Default auto-execute threshold | Notes |
|---|---|---|---|
| `safe` | read file, grep, cache lookup, list dir | 0.70 | Cheap to be wrong; the agent recovers next step |
| `cheap` | web search, RAG query, small-model call | 0.80 | Small $ / latency cost if wrong |
| `costly` | long-running test suite, large-context frontier call | 0.90 | |
| `stateful` | write file, edit code, send non-final message | 0.97 + opt-in | Off by default in `auto` mode |
| `destructive` | delete, deploy, payment, send email, `rm -rf`, force push | **never auto** | Always escalates; cannot be overridden without `allowDestructive: true` and an explicit rule |

Thresholds are **learned per workload** over time (§16), but can't drop below a configured floor per risk class.

### 11.2 Multi-question batching

Laya-style models can answer several questions in one forward pass. Reflex exploits this:

- **Intra-step batching:** one step often needs several decisions (e.g., `should_search` + `model_tier` + `should_stop`). `reflex.decideMany()` answers them in one pass.
- **Cross-agent batching (sidecar):** concurrent requests from parallel subagents are micro-batched with a ≤ 2 ms collection window.

### 11.3 Speed optimizations in the pipeline

The pipeline above is the *logical* order. In practice Reflex runs it with the speed techniques in §12: tiered early exits (most decisions end at rules, cache or a tiny head and never reach the full model), state encoding precomputed while tools run, hedged escalation, and a fully off-thread trace path. Target: **≤ 5 ms added to the agent's critical path at p50**, even though the full model may take 10–40 ms when it runs.

---

## 12. Speed Architecture

Speed is Reflex's headline feature. This section lists everything Reflex does to make each decision, and the whole agent task, as fast as possible.

### 12.1 Why Reflex is faster than any LLM decision

| Who decides | Typical latency for one decision | Why |
|---|---|---|
| Reflex: rules / exact cache | **< 1 ms** | Hash lookup / predicate evaluation |
| Reflex: tiny head on cached embeddings | **~1–3 ms** | One small matrix multiply |
| Reflex: full decision model (Laya, GPU) | **~10–40 ms** | One forward pass, no token generation |
| Reflex: full decision model (CPU, INT8) | ~30–120 ms (target) | One forward pass on CPU |
| Small/fast LLM (Haiku-class, mini-class) | ~300 ms – 1 s | Network round trip + prefill + generating tokens |
| Frontier LLM (Opus, GPT, Gemini Pro) | ~1 – 5+ s | Network + large-context prefill + reasoning + generation |

*(LLM latencies are typical ranges, not measurements; ReflexBench will measure them per provider.)*

Three structural reasons make Reflex faster than any generative LLM, however small:

1. **No generation.** An LLM produces its answer token by token (plus JSON/tool-call formatting and often thinking tokens). Reflex scores all candidate actions in **one forward pass**.
2. **No network.** Reflex runs locally, in-process or over a local socket. No DNS, TLS, queueing or provider-side load.
3. **Tiny input.** Reflex sees a compact state encoding (target ≤ 256 tokens), not the agent's full 50k–200k-token context.

### 12.2 The real goal: zero added critical-path latency

What users feel is total task time, not Reflex's own compute time. So the speed target is about the **critical path**:

- **Auto-handled step:** time = Reflex decision + tool execution. The seconds a frontier call would have taken disappear.
- **Escalated step:** time = Reflex overhead + frontier call. **Reflex overhead here is the only real speed cost, and §12.4 drives it toward zero.**

**Headline speed targets:**

| Target | Value |
|---|---|
| Critical-path overhead added by Reflex, p50 | **≤ 5 ms** |
| Critical-path overhead added by Reflex, p95 | **≤ 25 ms** |
| Overhead on escalated steps with hedged escalation | **≈ 0 ms** (frontier call already in flight) |
| Share of decisions resolved before the full model (tiers 0–4) | **≥ 50%** after learning |
| Wall-clock time per successful task vs always-frontier | **≥ 30–50% faster** (T1/T2 integrations) |

### 12.3 The Reflex ladder: tiered early exit

Every decision climbs the cheapest tiers first and stops at the first tier that's confident enough. The expensive model only runs when the cheap tiers can't decide.

```text
 Tier 0  kill switch / mode=off                          < 0.1 ms
 Tier 1  rules engine (force / deny / budget)            < 0.5 ms
 Tier 2  exact decision cache (state-digest hash)        < 0.5 ms
 Tier 3  trajectory pattern table                        < 1 ms
         e.g. "test failed with ImportError → read_file(imported module)"
         learned n-gram/sequence statistics over past traces
 Tier 4  tiny heads on cached embeddings                 ~1–3 ms
         linear/MLP head over incrementally-updated state embedding;
         also a "difficulty" head that predicts "will escalate"
 Tier 5  semantic decision cache (ANN lookup)            ~1–3 ms
 Tier 6  full decision model (Laya / distilled student)  ~10–40 ms GPU
 Tier 7  escalate → frontier LLM / human                 seconds
```

- **Each tier has its own calibrated confidence** and can only auto-decide above its threshold for the action's risk class.
- **Early escalation:** if the Tier 4 difficulty head is confident the step is hard (e.g., "design a fix"), Reflex escalates immediately and skips Tier 6. Hard steps then pay ~2 ms instead of ~35 ms.
- **Learning moves decisions down the ladder:** as traces accumulate, more decisions are answered by Tiers 2–4. Reflex gets *faster* the longer a workload runs.

### 12.4 Hiding latency: overlap instead of waiting

1. **Pre-decision while tools run.** When an action is dispatched (e.g., `run_tests`, which may take seconds), Reflex immediately encodes everything it already knows (goal, history, the action just taken). When the observation arrives, it only encodes the new observation and runs the final scoring. For outcomes it can predict (tests pass / tests fail), it can **pre-score the next decision for each likely outcome** and simply pick the right one when the result lands.
2. **Incremental state encoding.** The goal and history are encoded once and cached; each step only encodes the delta (new observation). Implemented as a two-part encoder: cached context embedding + small fusion over the new observation (exact design depends on Laya's architecture, see §25).
3. **Hedged escalation.** When the Tier 4 difficulty head says "likely escalate" (but isn't certain), Reflex signals the agent to **start the frontier call in parallel** with the full-model check. If Reflex ends up confident, the frontier request is cancelled; if not, the frontier answer is already on its way. Escalated-step overhead ≈ 0.
   - Cost trade-off: a cancelled frontier request may still bill input tokens. Controlled by `speed.mode`:
     - `cost-first`: never hedge.
     - `balanced` (default): hedge only when P(escalate) ≥ 0.6.
     - `latency-first`: hedge whenever P(escalate) ≥ 0.3 (voice agents, interactive UIs).
4. **Speculative execution of safe actions.** For `safe`, read-only, idempotent actions (read file, grep, cache lookup, prefetch a URL), Reflex can start the top-1 candidate *while* the decision is still being finalized or the frontier is still thinking. If the action turns out to be chosen, its result is already available; if not, it's discarded. **Never** applied to `cheap`-with-side-effects, `stateful` or `destructive` actions.
5. **Prefetching.** If a pattern says "after reading `foo.ts`, the agent usually reads `foo.test.ts`", Reflex warms that file/retrieval into the agent's cache in the background (read-only only).
6. **Off-critical-path bookkeeping.** Trace writes, outcome joining, metrics and learning all run on background threads, batched, and never block a decision.

### 12.5 Making System 2 faster too

Reflex also speeds up the steps it escalates:

- **Prompt-cache friendliness.** Hints are appended *after* the stable prefix of the frontier prompt so they never break the provider's prompt cache.
- **Right-sized model and thinking budget.** For escalated steps, Reflex's `model_tier` and difficulty signals can pick a smaller tier or a lower reasoning/thinking budget when the step is "medium" rather than "hard."
- **Top-k hints.** Narrowing the choice ("likely `read_file` or `grep`") lets the frontier answer with shorter outputs.
- **Shorter context.** Every step Reflex handles is a frontier turn that never enters the transcript, so later frontier calls have smaller contexts, faster prefill, and need compaction later or never.
- **Fewer rate-limit waits.** Fewer frontier calls means fewer 429s and backoff delays, a hidden source of agent slowness.

### 12.6 Making the model itself fast

| Technique | Expected effect | Notes |
|---|---|---|
| **Compact state encoding** (≤ 256 tokens, structured template) | Large: attention cost grows with sequence length | Most important single lever; encoders are per agent type |
| **FP16 / BF16 on GPU** | ~1.5–2× vs FP32 | Default on GPU |
| **INT8 quantization on CPU** (dynamic or static) | ~2–3× vs FP32 on CPU | Re-check calibration after quantizing |
| **INT4 weight-only** (optional) | Smaller and faster on memory-bound hardware | Only if accuracy/calibration hold |
| **Graph-optimized runtimes:** ONNX Runtime, TensorRT (NVIDIA), CoreML/ANE (Apple), DirectML (Windows), OpenVINO (Intel) | 1.3–3× depending on hardware | Auto-selected by `reflex doctor --tune` |
| **Distilled student model** ("Reflex-Mini", e.g., 4–6 layers, per workload) | 2–4× vs the full model | Trained from the full model + frontier labels; full model stays as fallback |
| **Early-exit layers** | Easy inputs exit after a few layers | Confidence head at intermediate layers |
| **Multi-question single pass** | N decisions for roughly the price of one | `decideMany()` and cross-agent micro-batching |
| **Sequence-length bucketing, static shapes, CUDA graphs, I/O binding, pinned memory** | Removes per-call launch/allocation overhead | Matters at 10–40 ms scale |
| **Tokenizer caching** | Removes repeated tokenization of goal/history | Pairs with incremental encoding |
| **Always warm** | No cold-start spikes | Pre-warm on init; keep weights resident; optional periodic keep-alive to avoid GPU clock-down |
| **Thread tuning** (intra-op threads, core pinning) | Lower CPU p95 | Tuned per machine by auto-tune |

### 12.7 Runtime and transport

- **In-process native binding (N-API)** for Node/Bun: no IPC at all in the fast path.
- **Inference on a worker thread**, so the agent's event loop is never blocked.
- **Sidecar transport:** Unix domain socket (Linux/macOS) or named pipe (Windows), persistent connections, binary encoding (MessagePack or FlatBuffers). HTTP/JSON stays available for compatibility but isn't the hot path. Shared memory for very high request rates (P2).
- **Zero-allocation hot path:** pre-allocated buffers, object pools, no per-call schema compilation (schemas compiled once at startup).
- **Lazy loading:** heavy modules (model runtime, SQLite, OTel) load only when used; rules-only mode starts in milliseconds.

### 12.8 Hardware profiles and auto-tuning

`reflex doctor --tune` benchmarks the machine once and writes the fastest configuration:

| Profile | Backend | Precision | Expected full-model p50 (target) |
|---|---|---|---|
| NVIDIA GPU | TensorRT or ONNX CUDA | FP16 | ≤ 15–25 ms |
| Apple Silicon | CoreML (ANE/GPU) | FP16 | ≤ 20–35 ms |
| Windows GPU (non-NVIDIA) | ONNX DirectML | FP16 | ≤ 30–45 ms |
| Modern x86 CPU (AVX-512/VNNI) | ONNX / OpenVINO | INT8 | ≤ 40–60 ms |
| Other CPU / ARM | ONNX | INT8 + distilled student | ≤ 60–120 ms |
| No model | Rules + caches + pattern table only | n/a | < 1 ms |

Targets are hypotheses for M0 to confirm. On slower profiles Reflex automatically leans harder on Tiers 1–5, student models and hedged escalation, so critical-path overhead stays low.

### 12.9 Speed configuration

```ts
speed: {
  mode: "balanced",            // "cost-first" | "balanced" | "latency-first"
  timeoutMs: 75,               // hard cap; on timeout → escalate
  earlyExit: true,             // use tiers 1–5 before the full model
  earlyEscalate: 0.85,         // difficulty-head confidence to skip the full model
  hedgeEscalation: 0.6,        // P(escalate) at which to start frontier in parallel
  speculativeSafeActions: true,
  prefetch: true,
  preDecide: true,             // encode/pre-score while tools run
  student: "auto",             // use distilled student when available
  backend: "auto",             // chosen by `reflex doctor --tune`
}
```

### 12.10 Measuring speed (and never regressing)

- **Microbenchmarks:** per-tier latency (p50/p95/p99), per hardware profile.
- **Critical-path overhead:** time the agent actually waited on Reflex, measured in real agent runs (the headline number).
- **End-to-end:** wall-clock per successful task vs always-frontier and vs other routers on ReflexBench.
- **Tier distribution:** what share of decisions ended at each tier (should shift toward cheaper tiers over time).
- **Perf CI gate:** every PR runs the latency benchmark; a p50 regression > 5% or p95 regression > 10% blocks merge.

---

## 13. Functional Requirements

Priority: **P0** = required for v1.0 · **P1** = strongly desired for v1.0, required for v1.x · **P2** = later.

### 13.1 SDK Core

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | Provide `createReflex(config)` returning a Reflex instance. | P0 |
| FR-1.2 | Provide `decide({ point, state, actions, taskId, stepId })` returning a typed `Decision`. | P0 |
| FR-1.3 | Provide `decideMany([...])` for batched decisions. | P1 |
| FR-1.4 | Provide `outcome({ decisionId \| stepId, result, latencyMs, costUsd, tokens })` for step outcomes. | P0 |
| FR-1.5 | Provide `taskOutcome({ taskId, success, score?, costUsd?, feedback? })` for task-level outcomes. | P0 |
| FR-1.6 | Support modes `off`, `shadow`, `assist`, `auto` globally and per decision point. | P0 |
| FR-1.7 | Fail open: all internal errors and timeouts return `ESCALATE`; never throw unless `strict: true`. | P0 |
| FR-1.8 | Typed action schemas via Zod (TS) / JSON Schema; validate chosen parameters before returning. | P0 |
| FR-1.9 | Provide `wrapStep(fn)` / middleware helpers for common loop shapes. | P1 |
| FR-1.10 | Dependency-light: core package works in Node ≥ 22, Bun and Deno; browser/edge build for rules-only mode. | P1 |
| FR-1.11 | Expose a `reason` string and `source` (`rule` / `cache` / `model` / `fallback`) on each decision. | P0 |

### 13.2 Action Space and Decision Points

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | Actions declare `id`, `kind`, `description`, `risk`, optional `paramsSchema`, optional `costPrior` and `latencyPrior`. | P0 |
| FR-2.2 | Built-in action kinds: `tool`, `model`, `retrieval`, `cache`, `search`, `retry`, `stop`, `ask_user`, `escalate`, `custom`. | P0 |
| FR-2.3 | Built-in decision point templates: `next_tool`, `should_search`, `should_retrieve`, `use_cache`, `on_error`, `model_tier`, `should_stop`, `ask_user`, `escalate_human`. | P0 |
| FR-2.4 | Dynamic action spaces: actions can be added or removed per call (e.g., available tools change). | P0 |
| FR-2.5 | Auto-import action spaces from MCP tool lists and OpenAI/Anthropic tool definitions. | P1 |
| FR-2.6 | Parameter filling for simple params (e.g., which file path from candidates in state) via span selection / candidate scoring; complex params escalate. | P1 |

### 13.3 Rules Engine

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Rule types: `force`, `deny`, `allow-only`, `require-escalation`, `budget`. | P0 |
| FR-3.2 | Rules can be written declaratively (YAML/JSON) or as TS predicate functions. | P0 |
| FR-3.3 | Built-in budget rules: max steps, max $ per task, max frontier calls, max retries per action, wall-clock limit. | P0 |
| FR-3.4 | Built-in safety rules: destructive actions always escalate; loop detection (same action+params N times → escalate). | P0 |
| FR-3.5 | Rule evaluation ≤ 1 ms p95 for ≤ 100 rules. | P0 |
| FR-3.6 | Rule hit reported in trace and in `decision.reason`. | P0 |

### 13.4 Decision Model Runtime

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | Backend interface `DecisionBackend { load(), score(batch), info() }`. | P0 |
| FR-4.2 | Laya backend (default), supporting English and multilingual checkpoints. | P0 |
| FR-4.3 | ONNX Runtime backend with CPU, CUDA, CoreML/Metal and DirectML execution providers. | P0 |
| FR-4.4 | Quantized (INT8) models for CPU-only machines. | P1 |
| FR-4.5 | Remote backend (HTTP to sidecar) with the same interface. | P0 |
| FR-4.6 | Lazy model download on first use with checksum verification; offline mode with pre-downloaded weights. | P0 |
| FR-4.7 | Warm-up on init; report cold-start time. | P1 |
| FR-4.8 | Per-workload lightweight adapters/heads (LoRA or linear heads) loadable at runtime. | P1 |
| FR-4.9 | "Bring your own model": any classifier exposing (state, candidates) → scores. | P1 |

### 13.5 Confidence, Calibration and Gating

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | Every decision has a calibrated `confidence` ∈ [0, 1] and a `margin` (top-1 minus top-2). | P0 |
| FR-5.2 | Temperature-scaling calibration per decision point, fit from shadow-mode or labeled traces. | P0 |
| FR-5.3 | Expose Expected Calibration Error (ECE) per workload in `reflex eval`. | P0 |
| FR-5.4 | Risk-aware thresholds with per-class floors (§11.1). | P0 |
| FR-5.5 | Conformal / selective-prediction mode: guarantee auto-decision error ≤ α at a target coverage. | P1 |
| FR-5.6 | Out-of-distribution detection: unfamiliar states (low density vs training traces) force escalation. | P1 |

### 13.6 Escalation

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | Escalated decisions return `{ type: "escalate", hints: topK, reason }`. | P0 |
| FR-6.2 | Optional `onEscalate` callback so Reflex can call the frontier directly (for agents that delegate the whole loop). | P1 |
| FR-6.3 | Hint injection helper: format top-k candidates as a short system hint for the frontier prompt (`assist` mode). | P1 |
| FR-6.4 | Human escalation channel interface (CLI prompt, webhook, Slack later). | P2 |
| FR-6.5 | When a frontier model decides an escalated point, record its choice as a label for learning. | P0 |

### 13.7 Tracing, Outcomes and Observability

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | Persist every decision trace to a local SQLite store (default `~/.reflex/traces.db` or project `.reflex/`). | P0 |
| FR-7.2 | Async, non-blocking trace writes; bounded queue with drop counter. | P0 |
| FR-7.3 | Configurable PII redaction (regex + key-based) before persistence; option to store hashes only. | P0 |
| FR-7.4 | JSONL export/import of traces. | P0 |
| FR-7.5 | OpenTelemetry spans and metrics (GenAI semantic conventions where applicable). | P1 |
| FR-7.6 | Per-workload metrics: decisions, auto rate, escalation rate, auto-decision precision (vs. shadow labels), latency percentiles, estimated $ saved, task success rate. | P0 |
| FR-7.7 | `reflex trace` CLI: tail, filter and inspect decisions. | P0 |
| FR-7.8 | Local dashboard (`reflex ui`). | P1 |

### 13.8 Learning and Policy Management

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | `reflex train --workload X`: fit calibration, thresholds and (optionally) adapters from traces. | P0 |
| FR-8.2 | Offline policy evaluation (`reflex eval`) using replay and counterfactual estimators before promotion. | P0 |
| FR-8.3 | Policy versioning: every policy has an ID, parent, training data window, metrics and creation time. | P0 |
| FR-8.4 | `reflex promote` / `reflex rollback` with gating: a policy can't be promoted if offline-estimated success drops > configured tolerance. | P0 |
| FR-8.5 | Canary rollout: route X% of decisions to a candidate policy; auto-rollback on regression. | P1 |
| FR-8.6 | Contextual-bandit online learning with bounded exploration on `safe`/`cheap` actions only. | P1 |
| FR-8.7 | Distillation: learn from frontier decisions collected in shadow/escalation (imitation learning). | P0 |
| FR-8.8 | Federated/shared base policies (opt-in community priors for common agents, e.g., Claude Code). | P2 |

### 13.9 CLI

| Command | Purpose | Priority |
|---|---|---|
| `reflex init` | Scaffold config, detect framework, choose backend, download model | P0 |
| `reflex serve` | Run local sidecar (HTTP + Unix socket) | P0 |
| `reflex mcp` | Run MCP server (stdio / streamable HTTP) | P0 |
| `reflex trace` | Inspect traces | P0 |
| `reflex eval` | Offline evaluation of a policy on traces | P0 |
| `reflex train` | Train/calibrate a policy | P0 |
| `reflex promote` / `rollback` | Policy lifecycle | P0 |
| `reflex bench` | Run ReflexBench suites | P1 |
| `reflex replay` | Replay recorded tasks with a different policy (where tools are deterministic/mocked) | P1 |
| `reflex ui` | Local dashboard | P1 |
| `reflex doctor` | Check hardware, model, latency and config health | P0 |

### 13.10 Configuration

- Single config file `reflex.config.ts` (or `.yaml`) with workloads, decision points, actions, rules, thresholds, backend and storage.
- Environment variable overrides (`REFLEX_MODE`, `REFLEX_BACKEND`, `REFLEX_DISABLE=1` kill switch).
- Config validated at startup with clear error messages.

### 13.11 Speed and Latency

| ID | Requirement | Priority |
|---|---|---|
| FR-9.1 | Tiered early-exit ladder (§12.3): rules → exact cache → pattern table → tiny heads → semantic cache → full model, each with its own calibrated confidence. | P0 (tiers 0–2, 6), P1 (3–5) |
| FR-9.2 | Difficulty head with early escalation: skip the full model when a step is confidently "hard". | P1 |
| FR-9.3 | Hedged escalation: `decide()` can return `{ hedge: true }` early so the agent starts the frontier call in parallel; `cancelHedge()` when Reflex resolves to auto. Governed by `speed.mode`. | P1 |
| FR-9.4 | Pre-decision API: `reflex.prepare({ taskId, pendingAction })` encodes known state while a tool runs; `decide()` then only encodes the new observation. | P1 |
| FR-9.5 | Incremental state encoding with cached context embeddings and tokenizer caching. | P1 |
| FR-9.6 | Speculative execution and prefetch of `safe`, read-only, idempotent actions only; results discarded if not chosen. | P1 |
| FR-9.7 | Compact state encoders with a hard token budget (default 256) per agent type. | P0 |
| FR-9.8 | FP16 on GPU and INT8 on CPU by default; TensorRT, CoreML, DirectML and OpenVINO execution providers. | P0 (FP16/INT8, ONNX CUDA/CPU), P1 (others) |
| FR-9.9 | Distilled per-workload student model ("Reflex-Mini") with automatic fallback to the full model. | P1 |
| FR-9.10 | In-process native binding and worker-thread inference; sidecar over Unix socket / named pipe with a binary protocol. | P0 (worker thread, socket), P1 (N-API, binary protocol) |
| FR-9.11 | `reflex doctor --tune`: benchmark the machine and write the fastest backend/precision/thread/batch config. | P0 |
| FR-9.12 | Zero blocking I/O on the decision path: traces, metrics and learning run off-thread. | P0 |
| FR-9.13 | Perf CI gate: block merges on p50 regression > 5% or p95 regression > 10%. | P0 |
| FR-9.14 | Escalation helpers preserve frontier prompt-cache prefixes (hints appended after the stable prefix). | P1 |

---

## 14. Developer Experience and API Design

### 14.1 Minimal integration (TypeScript)

```ts
import { createReflex, action } from "@reflex/core";

const reflex = createReflex({
  workload: "coding-agent/my-repo",
  mode: "shadow",                // start safe: predict + log only
  backend: { type: "laya", checkpoint: "en" },
});

const actions = [
  action.tool("read_file",  { risk: "safe",  params: z.object({ path: z.string() }) }),
  action.tool("grep",       { risk: "safe",  params: z.object({ pattern: z.string() }) }),
  action.tool("run_tests",  { risk: "costly" }),
  action.model("frontier",  { risk: "cheap", description: "Think / edit / plan" }),
  action.stop(),
];

async function step(state: AgentState) {
  const d = await reflex.decide({
    point: "next_action",
    taskId: state.taskId,
    state: { goal: state.goal, history: state.recentSteps, lastObservation: state.lastObs },
    actions,
  });

  if (d.type === "auto") return execute(d.action, d.params);   // fast path
  return callFrontier(state, { hints: d.hints });              // System 2
}

// when the task ends:
await reflex.taskOutcome({ taskId, success: testsPassed, costUsd, latencyMs });
```

### 14.2 `Decision` type

```ts
type Decision =
  | {
      type: "auto";
      id: string;
      action: ActionRef;
      params?: unknown;
      confidence: number;      // calibrated
      margin: number;
      source: "rule" | "cache" | "model";
      reason: string;
      latencyMs: number;
      policyVersion: string;
    }
  | {
      type: "escalate";
      id: string;
      hints: Array<{ action: ActionRef; confidence: number }>;
      reason: "low_confidence" | "risk" | "rule" | "ood" | "timeout"
            | "internal_error" | "budget" | "mode";
      latencyMs: number;
      policyVersion: string;
    };
```

In `shadow` mode, `decide()` always returns `escalate` with `reason: "mode"` but records what it *would* have done. When the frontier then acts, the agent calls `reflex.observeChoice(decisionId, actionTaken)` (or integrations do this automatically), producing labeled data and agreement metrics.

### 14.3 Adoption ladder

1. **Install + shadow mode** (day 0): zero behavior change, collect agreement data.
2. **Review report** (`reflex eval`): "Reflex would have auto-decided 58% of steps with 97.4% agreement; estimated savings $X/day."
3. **Assist mode:** inject hints to the frontier (smaller saving, zero risk).
4. **Auto mode on `safe` actions.**
5. **Auto mode on `cheap`/`costly` actions**, with learned thresholds.
6. **Online learning** enabled.

### 14.4 DX requirements

- Time-to-first-decision ≤ 5 minutes from `npm i` (rules-only mode, no model download).
- Time-to-first-model-decision ≤ 15 minutes, including model download on a typical connection.
- Error messages include a fix suggestion and a docs link.
- Full TypeScript types; no `any` in the public API.
- Examples repo: hand-rolled loop, Vercel AI SDK, OpenAI Agents SDK, LangGraph.js, Mastra, MCP client.

---

## 15. Integration Surfaces

### 15.1 Integration depth tiers

Reflex's value depends on how much of the loop it can see and control. We're explicit about this:

| Tier | Surface | Control level | Expected savings |
|---|---|---|---|
| **T1 — Owned loop** | SDK inside a custom agent loop | Full: can replace frontier steps | Highest |
| **T2 — Framework adapter** | LangGraph, OpenAI Agents SDK, Vercel AI SDK, Mastra middleware | High: node/edge routing, tool selection, model choice | High |
| **T3 — Host plugin** | Claude Code hooks + skill, Codex integration | Partial: can gate/approve/short-circuit tool calls, choose subagent models, cache results, enforce budgets, inject hints; can't replace the host's own internal reasoning turns | Moderate |
| **T4 — MCP tool** | `reflex_decide` exposed to any MCP client | Advisory: the host model chooses to consult it | Lower (mostly batching, caching and routing of sub-work) |

> **Key honesty point:** in closed hosts like Claude Code and Codex, the host model makes each turn's decision itself. Reflex can't stop that turn from happening. It *can* cut wasted work (redundant reads, duplicate searches, blind retries, oversized model choices for subagents, unnecessary test runs) and steer the host. The biggest savings come from T1/T2. Marketing and benchmarks must report results per tier.

### 15.2 MCP server (`@reflex/mcp`)

- **Tools:**
  - `reflex_decide(point, state, actions)` → decision JSON
  - `reflex_decide_many(questions[])`
  - `reflex_outcome(decision_id, result)`
  - `reflex_cache_lookup(key | query)` / `reflex_cache_store(...)`
  - `reflex_route_subtask(description)` → recommended model tier / tool
- **Resources:** `reflex://policy/{workload}`, `reflex://metrics/{workload}`
- **Prompts:** `reflex-efficiency-guidelines` (teaches the host model when to consult Reflex)
- Transports: stdio and streamable HTTP.

### 15.3 Claude Code plugin

- **Hooks:**
  - `PreToolUse`: dedupe (block a `Read` of an unchanged file already in context, returning a cached summary), loop detection, budget enforcement, auto-approve `safe` tools based on policy, risk gating for destructive commands.
  - `PostToolUse`: record outcome, update caches, detect error patterns for retry policy.
  - `UserPromptSubmit`: classify task type/difficulty; recommend subagent/model tier; inject a short efficiency hint.
  - `Stop` / `SubagentStop`: record task outcome; optionally run a "done?" check.
- **Skill:** "Reflex efficiency" skill describing when to delegate to cheaper subagents and when to consult `reflex_decide`.
- **MCP:** bundles the Reflex MCP server.
- **Commands:** `/reflex status`, `/reflex savings`, `/reflex mode <shadow|assist|auto>`.

### 15.4 Codex integration

- MCP server registration + AGENTS.md guidance snippet.
- Use any hook/approval mechanism Codex exposes (to be confirmed, see §25) for the same gating and caching behaviors as Claude Code.

### 15.5 Gateway integrations (P1)

- **LiteLLM / OpenRouter:** Reflex as a pre-routing hook choosing model tier with agent-state context; complements rather than competes with gateway routing.

### 15.6 Python SDK (P2, v1.x)

- API parity with TS (`reflex.decide`, `outcome`, `task_outcome`), talking to the sidecar or loading ONNX in-process.
- Adapters: LangGraph, LlamaIndex, CrewAI, OpenAI Agents SDK (Python), Pydantic AI, DSPy.

---

## 16. The Learning System

The learning system is Reflex's long-term moat. It has to work with **no hand labels**, **sparse task-level rewards** and **strict safety constraints**.

### 16.1 Signals

| Signal | Source | Use |
|---|---|---|
| Frontier choice at escalated / shadow decisions | `observeChoice` | Imitation labels (distillation) |
| Step outcome (error, empty result, latency, cost) | `outcome()` | Immediate reward / negative signal |
| Task success / score | `taskOutcome()`, tests, evaluators | Delayed reward |
| User feedback (thumbs, edits, reverts) | Integrations | Reward shaping |
| Cost & latency | Measured | Penalty terms |

### 16.2 Objective

Per workload, maximize:

```text
R(task) = 1[success] − λ_cost · cost_usd − λ_lat · latency_s
subject to:  success_rate(policy) ≥ success_rate(frontier_baseline) − ε     (ε default 1–2 pp)
```

`λ` values are configurable per workload (a voice agent weights latency; a batch research agent weights cost).

### 16.3 Learning stages

1. **Cold start (prior policy):** base Laya model + built-in decision point templates + community priors where available. Conservative thresholds.
2. **Shadow distillation:** in `shadow` mode, the frontier model decides every step; Reflex learns to imitate it and to calibrate confidence ("when Reflex says 0.9, does it match the frontier 90% of the time?").
3. **Outcome-aware refinement:** once task outcomes accrue, move beyond imitation. If cheaper actions (cache over search, small model over frontier) lead to equal success, shift probability mass toward them.
4. **Online contextual bandits (opt-in):** bounded exploration (e.g., ε ≤ 5%) limited to `safe`/`cheap` actions, with off-policy logging (propensities recorded) for unbiased evaluation.

### 16.4 Credit assignment

Task-level success must be attributed to individual decisions:

- **Imitation-first:** most signal comes from per-step frontier labels, which avoids sparse-reward problems early on.
- **Step-level proxies:** immediate negative signals (tool error, empty retrieval, reverted edit, a retry being needed).
- **Counterfactual comparison:** for decision points with logged propensities, use inverse propensity scoring (IPS) / doubly robust estimators.
- **Paired runs (bench mode):** in ReflexBench, run the same task under different policies to measure task-level deltas directly.

### 16.5 Safe policy improvement

- A candidate policy must pass **offline evaluation** on held-out traces with confidence bounds before promotion.
- **Canary** rollout with automatic rollback if success-rate or escalation-rate metrics cross guardrails.
- **Floors:** learned thresholds can't go below per-risk-class floors.
- **Drift detection:** if the state distribution shifts (new tools, new repo, new model version), reduce auto rate and re-enter shadow sampling.
- **Frontier-model change handling:** when the System-2 model changes version, flag imitation labels from the old model and re-calibrate.

### 16.6 What is learned (v1 vs later)

| Artifact | v1.0 | v1.x | v2 |
|---|---|---|---|
| Calibration (temperature per point) | ✅ | | |
| Per-risk thresholds per workload | ✅ | | |
| Decision cache entries | ✅ | semantic | |
| Linear/MLP heads on frozen Laya embeddings | ✅ | | |
| LoRA adapters on Laya | | ✅ | |
| Contextual bandit policy | | ✅ | |
| Multi-step policy (RL over trajectories) | | | ✅ |
| Shared community priors | | | ✅ |

---

## 17. Data Model

### 17.1 Decision trace (stored)

```ts
interface DecisionTrace {
  id: string;                    // ulid
  timestamp: string;             // ISO-8601
  workload: string;
  point: string;                 // decision point name
  taskId?: string;
  stepId?: string;
  policyVersion: string;
  mode: "off" | "shadow" | "assist" | "auto";

  stateDigest: string;           // hash of encoded state
  stateEncoded?: string;         // redacted, truncated (configurable)
  candidates: Array<{ id: string; kind: string; risk: string; score: number; prob: number }>;
  rulesApplied: string[];
  source: "rule" | "cache" | "model" | "fallback";

  outcomeType: "auto" | "escalate";
  chosenAction?: string;
  chosenParams?: unknown;
  confidence?: number;
  margin?: number;
  escalationReason?: string;
  propensity?: number;           // for off-policy evaluation

  reflexLatencyMs: number;
  backend: string;
  hardware?: string;
}
```

### 17.2 Step outcome and task outcome

```ts
interface StepOutcome {
  decisionId: string;
  actionTaken: string;           // may differ from Reflex choice (shadow / escalate)
  takenBy: "reflex" | "frontier" | "human" | "rule";
  status: "ok" | "error" | "empty" | "timeout";
  latencyMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorClass?: string;
}

interface TaskOutcome {
  taskId: string;
  workload: string;
  success: boolean;
  score?: number;                // 0..1 graded
  totalCostUsd?: number;
  totalLatencyMs?: number;
  frontierCalls?: number;
  totalTokens?: number;
  feedback?: "positive" | "negative" | string;
}
```

### 17.3 Storage and retention

- Default: local SQLite with WAL; configurable retention (default 30 days or 1 GB, whichever first).
- `stateEncoded` storage levels: `full` (redacted), `digest-only`, `none`.
- Export: JSONL / Parquet (P1).
- Nothing leaves the machine unless the user configures an exporter.

---

## 18. Non-Functional Requirements

### 18.1 Performance

| Metric | Target (reference GPU, e.g., T4-class) | Target (reference CPU, e.g., 8-core laptop, INT8) |
|---|---|---|
| Critical-path overhead p50 (what the agent waits) | ≤ 5 ms | ≤ 10 ms |
| Critical-path overhead p95 | ≤ 25 ms | ≤ 60 ms |
| Full-model decision p50 | ≤ 25 ms | ≤ 60 ms |
| Full-model decision p95 | ≤ 50 ms | ≤ 120 ms |
| Rules/cache/pattern path p95 | ≤ 1 ms | ≤ 1 ms |
| Tiny-head path p95 | ≤ 3 ms | ≤ 5 ms |
| Decisions resolved before the full model | ≥ 50% after learning | ≥ 60% after learning |
| Batched decisions (4 questions) p50 | ≤ 35 ms | ≤ 90 ms |
| Sidecar throughput | ≥ 200 decisions/s | ≥ 30 decisions/s |
| Cold start (model load) | ≤ 5 s | ≤ 10 s |
| Memory (model loaded) | ≤ 1.5 GB VRAM | ≤ 1 GB RAM (INT8) |
| SDK core install size (no model) | ≤ 2 MB | ≤ 2 MB |

> Note: even unoptimized, Laya's reported 32.8–39.5 ms single-question latency on T4 is already 10–100× faster than an LLM decision. The stricter targets above exist so that Reflex adds almost nothing on escalated steps and on CPU-only machines. They're reached through the speed architecture in §12: tiered early exit, compact encodings, FP16/INT8, optimized runtimes, distilled students, pre-decision and hedged escalation. The full-model target is an M0 exit criterion and tracked as risk R1 (§24).

### 18.2 Reliability

- **Fail-open guarantee:** a Reflex failure must never block or crash the agent. Covered by chaos tests (kill the sidecar, corrupt the model, fill the disk).
- **Hard timeout** enforced on every decision (default 75 ms, configurable).
- **Kill switch:** `REFLEX_DISABLE=1` or `mode: "off"` makes Reflex a no-op passthrough with ≤ 0.1 ms overhead.
- **Determinism:** with a fixed policy version and no exploration, identical inputs produce identical decisions (for reproducible debugging).

### 18.3 Privacy and security

- Local-only by default; zero telemetry without explicit opt-in.
- Redaction before persistence; secrets detection (API keys, tokens) on by default.
- Model weights verified by SHA-256; signed releases (Sigstore) for npm packages and model artifacts.
- Sidecar binds to localhost/Unix socket by default; auth token required for non-local binding.
- Prompt-injection awareness: the decision model sees tool outputs that may be adversarial. Destructive actions are never auto-executed, so an injected "delete everything" can at most be *suggested*, never *executed*, by Reflex.
- SBOM published with each release.

### 18.4 Compatibility

- Node ≥ 22, Bun ≥ 1.1, Deno ≥ 2 (core); Windows, macOS (Apple Silicon + Intel), Linux (x64, arm64).
- GPU: NVIDIA CUDA, Apple Metal/CoreML, DirectML on Windows (P1).
- Python ≥ 3.10 (Python SDK, v1.x).

### 18.5 Observability of Reflex itself

- Internal metrics: queue depth, dropped traces, backend latency, cache hit rate, rule hit rate, timeout rate, error rate.
- `reflex doctor` reports hardware, backend, measured latency and config problems.

---

## 19. Safety, Guardrails and Trust

1. **Risk classes are mandatory.** Every action has a risk class; unknown/unspecified defaults to `stateful` (conservative).
2. **Destructive actions never auto-execute.** Hard-coded; overriding needs both `allowDestructive: true` in config and an explicit per-action `force` rule.
3. **Loop and runaway protection.** Repeated identical actions, exceeded budgets and escalating cost trigger forced escalation or stop.
4. **Human-in-the-loop hooks** for high-stakes workloads (support refunds, deployments).
5. **Explainability:** every decision carries `reason`, rule hits and top-k alternatives.
6. **Auditability:** immutable traces with policy version for every action Reflex took.
7. **Policy regression guardrails:** promotion gating, canaries, auto-rollback (§16.5).
8. **Honest metrics:** savings are reported alongside success-rate deltas, always together. The dashboard never shows "$ saved" without "success Δ".

---

## 20. Evaluation and Benchmarking (ReflexBench)

### 20.1 Philosophy

Reflex is judged at the **agent level**: *did the agent finish the task, and what did it cost in dollars, tokens, frontier calls and wall-clock time?* Decision accuracy is a diagnostic, not the headline.

### 20.2 Suites

| Suite | Task type | Source / approach | Success signal |
|---|---|---|---|
| `coding` | Bug fixing / feature tasks in real repos | SWE-bench Verified-style subset + internal tasks | Tests pass |
| `research` | Multi-hop question answering with search | HotpotQA / multi-hop web QA-style tasks | Exact match / LLM-judge with human audit |
| `tool-use` | API/tool orchestration | τ-bench-style / BFCL-style environments | Environment success check |
| `support` | Customer support conversations | Synthetic + anonymized scenarios | Resolution + policy compliance |
| `browser` (v1.x) | Web navigation | WebArena-style tasks | Task checker |
| `voice` (v1.x) | Latency-bound turn handling | Simulated dialogs | Turn latency + resolution |
| `micro` | Isolated decision points | Labeled decision datasets from traces | Accuracy, calibration (ECE), coverage |

### 20.3 Baselines

1. **Always-frontier** (reference quality and cost).
2. **Always-small** (lower bound on quality).
3. **Static heuristics** (hand-written rules).
4. **Model-router-only** (LiteLLM Auto Router–style tier selection).
5. **Small-LLM-as-router** (e.g., a Haiku-class model making the same decisions).
6. **Reflex variants:** rules-only, + model, + calibration, + learning (after N tasks).

### 20.4 Metrics reported for every run

| Metric | Definition |
|---|---|
| **Task success rate** | % tasks solved |
| **Success Δ vs frontier** | pp difference (must be ≥ −2, target ≥ −1) |
| **$ / successful task** | total cost ÷ successful tasks (**primary**) |
| **Tokens / successful task** | total frontier tokens ÷ successful tasks |
| **Frontier calls / task** | mean count |
| **Wall-clock / successful task** | mean and p95 |
| **Reflex overhead** | p50/p95 per decision, split into full-model time and critical-path time |
| **Tier distribution** | share of decisions resolved at each ladder tier (§12.3) |
| **Auto rate (coverage)** | % decisions handled without escalation |
| **Auto precision** | % auto decisions matching the frontier choice or leading to success |
| **ECE** | calibration error |
| **Learning curve** | $/successful task vs number of tasks seen |

### 20.5 Rigor

- Fixed seeds, pinned model versions, recorded dates; ≥ 3 runs per config with confidence intervals.
- Pareto plots (cost vs success) as the main visualization.
- Ablations for each component (rules, cache, model, calibration, learning).
- Public harness and traces so third parties can reproduce results.
- Report results **per integration tier** (§15.1).

---

## 21. Success Metrics and KPIs

### 21.1 North-star metric

**$ per successful agent task at iso-quality** (success within −2 pp of the frontier baseline), measured on ReflexBench and reported by opted-in users.

### 21.2 Product metrics

| Metric | v1.0 target | 6 months post-v1 target |
|---|---|---|
| Frontier calls / task reduction (T1/T2) | ≥ 40% | ≥ 55% |
| $ / successful task reduction (T1/T2) | ≥ 30% | ≥ 45% |
| Success Δ vs frontier | ≥ −2 pp | ≥ −1 pp |
| Wall-clock / successful task reduction (T1/T2) | ≥ 30% | ≥ 50% |
| Critical-path overhead p50 / p95 (GPU) | ≤ 5 / 25 ms | ≤ 3 / 15 ms |
| Full-model decision p50 / p95 (GPU) | ≤ 25 / 50 ms | ≤ 15 / 35 ms |
| Decisions resolved before the full model | ≥ 50% | ≥ 65% |
| Auto-decision precision | ≥ 95% | ≥ 97% |
| ECE | ≤ 0.05 | ≤ 0.03 |
| Claude Code plugin (T3) $ / task reduction | ≥ 10% | ≥ 20% |

### 21.3 Adoption and community metrics

| Metric | 3 months post-launch | 12 months |
|---|---|---|
| GitHub stars | 1,500 | 8,000 |
| Weekly npm downloads (`@reflex/core`) | 2,000 | 20,000 |
| Production deployments (self-reported) | 10 | 100 |
| External contributors | 15 | 75 |
| Framework adapters | 4 | 10 |
| Time-to-first-decision (median, measured in user tests) | ≤ 10 min | ≤ 5 min |

### 21.4 Guardrail metrics (must not regress)

- Zero auto-executed destructive actions.
- Fail-open rate when Reflex errors = 100%.
- No increase in agent crash rate attributable to Reflex.

---

## 22. Roadmap and Milestones

Durations are estimates for a small core team (1–3 engineers) and should be re-planned after M0.

### M0 — Feasibility spike (weeks 0–3)
- Decision-model benchmark: Laya on T4, consumer GPU, Apple Silicon and CPU (ONNX, FP16, INT8); latency with batching and with 128/256/512-token state encodings.
- Measure frontier and small-LLM decision latency for the same decisions, for the published speed comparison.
- Collect ~5k shadow decisions from one coding agent; measure imitation agreement and calibration.
- **Exit criteria:** p50 ≤ 40 ms on GPU with a clear path to ≤ 25 ms; ≥ 50% of decisions answerable at ≥ 95% agreement in shadow; go/no-go on CPU viability.

### M1 — Alpha (weeks 3–10)
- `@reflex/core`: `decide`, `outcome`, `taskOutcome`, modes, rules, exact cache, fail-open, Laya + ONNX backends.
- SQLite traces, `reflex init / trace / eval / doctor`.
- Built-in decision points: `next_tool`, `should_search`, `on_error`, `model_tier`, `should_stop`.
- Temperature calibration + risk thresholds.
- Speed: tiers 0–2 of the ladder, compact encoders, FP16/INT8, worker-thread inference, `reflex doctor --tune`, perf CI gate.
- ReflexBench `coding` + `micro` suites, always-frontier baseline.
- Examples: hand-rolled loop, Vercel AI SDK.
- **Exit:** a T1 coding agent showing ≥ 25% $/task reduction at ≥ −2 pp success.

### M2 — Beta (weeks 10–18)
- MCP server; Claude Code plugin (hooks + skill); Codex integration.
- `reflex serve` sidecar with cross-agent batching.
- `reflex train / promote / rollback`, policy registry, offline evaluation.
- Heads on frozen embeddings; outcome-aware refinement.
- Speed: pattern table, tiny heads + difficulty head, pre-decision API, incremental encoding, hedged escalation, speculative safe actions.
- Adapters: OpenAI Agents SDK, LangGraph.js, Mastra.
- ReflexBench `research` + `tool-use` suites; public results page.
- OpenTelemetry export.
- **Exit:** G1–G4 met on two suites; 5 external design partners in shadow/auto mode.

### M3 — v1.0 GA (weeks 18–26)
- Hardening, docs, security review, signed releases, SBOM.
- Speed: distilled "Reflex-Mini" student, TensorRT/CoreML/DirectML providers, N-API binding, semantic decision cache; publish the speed report.
- Local dashboard (`reflex ui`).
- Canary rollout + auto-rollback.
- Conformal selective prediction (if ready).
- Launch: blog post, benchmark report, demo videos.
- **Exit:** all P0 requirements; G1–G8 met; public reproducible benchmark.

### v1.x (months 6–12)
- Python SDK + LangGraph/LlamaIndex/CrewAI/Pydantic AI adapters.
- Semantic decision cache; LoRA adapters; contextual bandits.
- LiteLLM/OpenRouter integrations.
- Browser and voice suites.

### v2 (12+ months)
- Multi-step trajectory policies (RL).
- Opt-in community priors for popular agents.
- Team/fleet control plane (self-hosted or managed): shared policies, org dashboards, RBAC, audit export.

---

## 23. Go-To-Market, Open Source and Community

### 23.1 Open-source strategy

- **Apache-2.0** for core, SDKs, MCP server, plugins, CLI, ReflexBench.
- Model weights licensed according to Laya's license (to be confirmed, §25).
- Public roadmap, RFC process for API changes, a CONTRIBUTING guide, and "good first issue" labels.

### 23.2 Launch narrative

- Headline: *"Your agent is paying frontier prices for reflexes."*
- Proof: reproducible ReflexBench Pareto charts; a before/after Claude Code session showing wasted turns removed; a live latency demo.
- Channels: GitHub, Hacker News, X/Twitter, Reddit (r/LocalLLaMA, r/ClaudeAI), MCP and agent-framework communities, conference talks.

### 23.3 Design partners

- 5–10 teams running agents in production (support, coding, research) for shadow-mode pilots during M2.
- Deliverable for partners: a "savings report" from shadow traces before any behavior change.

### 23.4 Possible sustainability models (post-v1, non-binding)

- Managed/self-hosted **team control plane** (shared policies, governance, SSO, audit).
- **Pretrained workload priors** for common agents.
- Support and SLAs for enterprises.
- The core runtime stays fully open and fully functional locally.

---

## 24. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Full decision model misses its ≤ 25 ms p50 target (especially on CPU), adding noticeable time on escalated steps | Medium | Medium | Still 10–100× faster than an LLM decision; critical-path overhead kept low via tiered early exit, early escalation, hedged escalation and pre-decision; compact encodings, FP16/INT8, optimized runtimes and distilled students; M0 go/no-go |
| R1b | Hedged escalation and speculative execution waste money or cause side effects | Medium | Medium | Hedging off in `cost-first` mode and threshold-gated otherwise; speculation strictly limited to `safe` read-only idempotent actions; track wasted-hedge cost as a metric |
| R2 | Silent quality degradation (agent completes fewer tasks) | Medium | Very high | Shadow-first adoption, calibration, risk floors, success-Δ always reported, canary + auto-rollback |
| R3 | Closed hosts (Claude Code, Codex) limit interception, so savings in T3 are modest | High | Medium | Be explicit about tiers; focus T3 on dedupe, caching, budgets, subagent routing; push T1/T2 as the primary value |
| R4 | Credit assignment is too noisy to learn from task outcomes | Medium | Medium | Imitation-first; step-level proxies; logged propensities; paired bench runs |
| R5 | Frontier models get cheaper/faster, eroding the value proposition | Medium | Medium | Latency, rate-limit, context-pollution and privacy benefits remain; pitch the "agent scheduler" story, not just cost |
| R6 | Frontier hosts build this natively | Medium | High | Be model-agnostic and cross-host; outcome learning on the user's own data; open source and local-first |
| R7 | Prompt injection steers Reflex into bad actions | Medium | High | Destructive never auto; risk floors; OOD detection; rules override |
| R8 | Context/state encoding loses information needed for correct decisions | Medium | Medium | Per-agent encoders; escalate on OOD; evaluate encoders in ReflexBench |
| R9 | Benchmark claims are seen as cherry-picked | Medium | Medium | Public harness, traces, CIs, baselines including strong competitors |
| R10 | Integration friction (every agent's loop is different) | High | Medium | Adapters, wrapStep helpers, MCP fallback, examples, adoption ladder |
| R11 | Laya license or availability constraints | Low–Medium | High | Pluggable backend interface; ONNX "bring your own model"; confirm licensing early |
| R12 | Distribution shift after frontier model upgrades | High | Medium | Drift detection, re-calibration, version-tagged labels |

---

## 25. Open Questions

1. **Laya specifics:** license for redistribution, ONNX exportability, context length, multi-question pass API, CPU latency, fine-tuning/adapter support?
2. **State encoding:** how much trajectory does the decision model need? What's the best compact encoding per agent type (coding vs research vs support)?
3. **Parameter filling:** how far can Reflex go beyond choosing an action (e.g., picking file paths) before it should escalate?
4. **Claude Code / Codex hook capabilities:** exactly which decisions can be intercepted, short-circuited or answered from cache via current hook APIs (PreToolUse output semantics, subagent model selection)? Needs a verification spike in M0/M1.
5. **Success signals for non-coding workloads:** what automated success checks are reliable enough to learn from (LLM judges with audits? user feedback?)
6. **Exploration ethics/UX:** is any online exploration acceptable for user-facing agents, or only in staging?
7. **Community priors:** what's the privacy-preserving way to share policies across users (aggregated statistics, federated updates, opt-in trace donation)?
8. **Pricing data:** how should Reflex know $ cost per model call (static price tables, gateway-reported costs, user-supplied)?
9. **Naming/namespace:** availability of the `reflex` npm scope/package names and trademark conflicts (e.g., the existing Reflex Python web framework). An alternative name or the scope `@reflex-ai/*` may be needed.
10. **Hosted offering timing:** when, if ever, to build the team control plane?
11. **Laya architecture for incremental encoding:** is it a bidirectional encoder (needs a two-part cached-context + fusion design) or can it reuse a prefix cache directly? Does it support early-exit heads?
12. **Hedging economics per provider:** which providers bill input tokens for cancelled streaming requests, and how quickly can a request be cancelled?

---

## 26. Appendices

### Appendix A — v1 Decision Catalog

| Decision point | Typical actions | Default risk mix | Primary success signal |
|---|---|---|---|
| `next_tool` | each registered tool, `frontier`, `stop` | safe–stateful | Step success + task success |
| `should_search` | `search`, `rag`, `cache`, `frontier_answer`, `skip` | cheap | Answer correctness |
| `use_cache` | `use_cached`, `refresh` | safe | Downstream correctness |
| `on_error` | `retry_now`, `retry_backoff`, `switch_tool`, `escalate`, `give_up` | safe–cheap | Recovery rate |
| `model_tier` | `small`, `mid`, `frontier` | cheap | Output validation + task success |
| `should_run_tests` | `run_all`, `run_subset`, `skip` | costly | Bugs caught / time saved |
| `should_read_more` | `read(path_i)`, `grep`, `enough_context` | safe | Edit success |
| `should_stop` | `stop`, `continue`, `verify` | safe | Task success |
| `ask_user` | `ask`, `proceed`, `escalate_frontier` | stateful | User satisfaction / fewer reversals |
| `escalate_human` | `human`, `continue_auto` | stateful | Resolution + compliance |

### Appendix B — Example `reflex.config.ts`

```ts
import { defineConfig } from "@reflex/core";

export default defineConfig({
  workloads: {
    "coding-agent/main": {
      mode: "auto",
      backend: { type: "laya", checkpoint: "en", device: "auto" },
      timeoutMs: 75,
      thresholds: {
        safe:   { auto: 0.70, floor: 0.60 },
        cheap:  { auto: 0.80, floor: 0.75 },
        costly: { auto: 0.90, floor: 0.85 },
        stateful: { auto: "never" },
        destructive: { auto: "never" },
      },
      budgets: { maxStepsPerTask: 80, maxUsdPerTask: 2.0, maxRetriesPerAction: 3 },
      rules: [
        { type: "deny",  when: "action.id == 'bash' && params.cmd matches /rm -rf|git push --force/" },
        { type: "force", when: "lastObservation.type == 'rate_limit'", action: "retry_backoff" },
        { type: "require-escalation", when: "state.stepsSinceProgress >= 5" },
      ],
      learning: { calibrate: true, heads: true, bandit: false, tolerancePp: 1.5 },
      storage: { path: ".reflex/traces.db", stateEncoding: "redacted", retentionDays: 30 },
    },
  },
  privacy: { telemetry: false, redactSecrets: true },
});
```

### Appendix C — Example trace (abbreviated)

```json
{
  "id": "01J9Z3K7Q4M2X8",
  "workload": "coding-agent/main",
  "point": "next_tool",
  "policyVersion": "coding-agent/main@7",
  "mode": "auto",
  "candidates": [
    { "id": "read_file", "risk": "safe",   "prob": 0.91 },
    { "id": "grep",      "risk": "safe",   "prob": 0.06 },
    { "id": "frontier",  "risk": "cheap",  "prob": 0.03 }
  ],
  "rulesApplied": [],
  "source": "model",
  "outcomeType": "auto",
  "chosenAction": "read_file",
  "chosenParams": { "path": "src/utils/date.ts" },
  "confidence": 0.91,
  "margin": 0.85,
  "reflexLatencyMs": 21.4
}
```

### Appendix D — Worked economics example (illustrative, not measured)

Assume a coding task with 40 steps, average frontier step cost $0.03 and latency 3 s, with 60% of steps being reflexes that Reflex auto-handles at 30 ms:

| | Always-frontier | With Reflex (T1) |
|---|---|---|
| Frontier calls | 40 | 16 (+ a few escalations, say 18) |
| Frontier cost | $1.20 | ~$0.54 (+ cheap tool/search costs) |
| Decision latency | 120 s | ~54 s + 0.7 s Reflex overhead |
| Context growth | 40 frontier turns | ~18 frontier turns (less compaction) |

Every number in this table is a hypothesis for ReflexBench to confirm or refute. Real savings depend on workload, integration tier and the success-rate constraint.

### Appendix E — Glossary

- **System 1 / System 2:** fast, automatic decisions vs slow, deliberate reasoning (Kahneman). Reflex is System 1; the frontier LLM is System 2.
- **Calibration:** agreement between predicted confidence and observed accuracy.
- **ECE:** Expected Calibration Error.
- **Selective prediction / conformal prediction:** abstaining when uncertain, with statistical guarantees on error among non-abstained predictions.
- **Contextual bandit:** online learning that picks actions based on context and observed rewards, balancing exploration and exploitation.
- **IPS / Doubly robust:** estimators that evaluate a new policy from logs gathered under an old policy.
- **Iso-quality:** comparison at equal (within tolerance) task success.

### Appendix F — References (to verify and link before publication)

- Laya: model card and agent-routing documentation (System-1/System-2 positioning; T4 latency figures 32.8 ms multilingual / 39.5 ms English).
- LiteLLM: Auto Router documentation; RouterArena result (74.5% cost reduction, 87.3% of frontier quality); production case study (51.1% savings over 272,876 requests).
- Not Diamond: model routing product documentation.
- RouteLLM (LMSYS): learned router research.
- Model Context Protocol specification.
- Claude Code hooks and plugins documentation; Codex documentation.
- SWE-bench, τ-bench, BFCL, WebArena, HotpotQA benchmark papers.
