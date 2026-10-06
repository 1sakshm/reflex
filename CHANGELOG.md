# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Before 1.0, minor versions may contain breaking changes.

## [0.1.0] - 2026-10-06

First public release.

### Added
- `@reflex-ai/core`: the decision runtime. Zero runtime dependencies.
  - Decision ladder: rules → exact cache → pattern table → hashed head (+ difficulty head) → full-model backend → escalate.
  - Risk classes (`safe`, `cheap`, `costly`, `stateful`, `destructive`) with per-class thresholds and floors. `destructive` is never auto-executed.
  - Modes `off` / `shadow` / `assist` / `auto`; `REFLEX_DISABLE` kill switch and `REFLEX_MODE` override.
  - Budgets (steps, $, frontier calls, wall-clock, retries) and loop detection.
  - Online learning from labels, step outcomes and task outcomes; small-sample shrinkage; audit sampling.
  - Hedged escalation (`onHedge`), safe speculation, `decideMany` batching, hard `timeoutMs`, fail-open everywhere.
  - Traces (JSONL, secret redaction, retention), versioned policy registry, offline training with held-out calibration, per-risk thresholds and a promotion gate with a 95% Wilson lower bound.
- `@reflex-ai/server`: local HTTP sidecar with token auth and a live dashboard (`/ui`); dependency-free MCP server (stdio).
- `@reflex-ai/cli`: `init`, `doctor --tune`, `trace`, `stats`, `train`, `eval`, `policies`, `promote`, `rollback`, `serve`, `mcp`, `laya`, `bench`, `version`.
- `@reflex-ai/bench`: ReflexBench harness with simulated coding and support suites.
- Claude Code plugin: unchanged re-read and duplicate-fetch blocking, loop stopping, destructive-command gating for bash/PowerShell/cmd, opt-in auto-approval, `/reflex-status`.
- `reflex-laya` (Python): Laya full-model sidecar; batches decisions that share a state into one forward pass; `--mock` scorer.
- `reflex-agent-client` (Python): fail-open client for the sidecar.
- Codex integration via MCP, examples, and docs.
