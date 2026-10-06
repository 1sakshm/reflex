# Contributing to Reflex

Thanks for helping! Reflex is judged at the **agent level**: does a change lower $ and seconds per *successful* task without costing success rate? Please keep that lens.

## Setup

```bash
npm install
npm test && npm run test:python && npm run typecheck
```

Node ≥ 22.18 runs TypeScript sources directly via `--conditions=reflex-source`; no build step is needed for development.

## Ground rules

- **Fail open.** Nothing in the decision path may throw into the caller or block past `timeoutMs`.
- **Never auto-execute `destructive` actions.** Changes that loosen risk gating need an RFC issue first.
- **Zero runtime dependencies in `@reflex-ai/core`.** Heavy backends live behind the `DecisionBackend` interface.
- **Traces are a public format.** Changes to `trace.ts` event shapes must stay backward compatible (`buildExamples` must read old traces).
- **Benchmarks back claims.** If a change affects decisions, include `npx reflex bench` before/after output (same seeds) in the PR.
- **Simulations are labeled as simulations.** Don't present simulated results as real-world savings.

## Layout

`packages/core` runtime · `packages/server` sidecar + MCP · `packages/cli` CLI · `packages/bench` ReflexBench · `plugins/claude-code` hooks plugin · `python/` Laya sidecar + client · `examples/`.
