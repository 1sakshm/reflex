# FAQ

**Is it free?**
Yes. Apache-2.0, runs locally, no service, no telemetry. The optional Laya model is also Apache-2.0. You still pay your frontier provider for the steps Reflex escalates.

**Will it make my agent worse?**
It is designed not to. It starts in shadow mode (it never acts). It never auto-executes `destructive` actions, and `stateful` ones only if you allow it. It escalates whenever it is unsure, times out to escalation, and fails open on any internal error. `reflex train` only promotes policies that clear a precision gate, and `REFLEX_DISABLE=1` turns it off instantly. Check `npx reflex stats` before switching to auto mode.

**Does it need a GPU?**
No. Tiers 0–4 are pure TypeScript and take microseconds on a CPU, and they do the work by default. The optional Laya full-model tier needs a GPU to fit the live decision path: on a laptop CPU it measured 0.8–2.7 s per decision (see [integrations](integrations.md#laya-the-full-model-tier)).

**Does it send my data anywhere?**
No. Traces stay in `.reflex/` on your machine, with secrets redacted before storage.

**How is this different from a model router (LiteLLM Auto Router, Not Diamond)?**
Routers pick *which model* answers a prompt. Reflex decides *whether a model is needed at all* for each agent step (tool choice, search or not, retry, stop, which model tier) and learns the cheapest successful path from your agent's outcomes. It complements a gateway rather than replacing one.

**Why does Claude Code save less than my own agent?**
In Claude Code the host model makes every turn's decision itself. Reflex can only remove wasted work around it (re-reads, duplicate fetches, loops) and gate risky commands. In your own loop, Reflex can replace the frontier call for routine steps.

**My first decisions all escalate. Is it broken?**
No. Reflex needs labels first. Run in shadow mode and call `observeChoice()` after your frontier model decides. The head tier activates after `learning.minExamples` (20) labels per decision point, and earlier tiers need ≥ 3 consistent observations.

**Some confident decisions escalate with `reason: "audit"`.**
That is audit sampling: 1 in 50 confident decisions still goes to your frontier model, so Reflex keeps measuring its live precision. Set `learning.auditRate: 0` to disable it (not recommended).

**Can I use my own model instead of Laya?**
Yes. Implement `DecisionBackend` (one `score()` function) or serve the HTTP contract in [api.md](api.md#backends).

**Where are the trained policies?**
`.reflex/policies/<workload>/` as versioned JSON (`v1.json`, …) plus `manifest.json`. They are safe to commit if you want reproducible deployments.
