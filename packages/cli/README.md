# @reflex-ai/cli

The `reflex` command for [Reflex](https://github.com/1sakshm/reflex), the System-1 decision runtime for AI agents.

```bash
npm install -D @reflex-ai/cli    # or use npx @reflex-ai/cli <command>

reflex init                 # reflex.config.ts in shadow mode
reflex doctor --tune        # check setup, measure latency
reflex stats                # what Reflex did / would have done
reflex train --promote      # learn a policy from traces (held-out calibration + precision gate)
reflex eval | policies | promote <v> | rollback
reflex serve                # HTTP sidecar + dashboard (/ui)
reflex mcp                  # MCP server on stdio
reflex laya                 # start the Laya full-model sidecar (Python)
reflex bench                # ReflexBench: agent-level cost/quality benchmark
```

Run `reflex --help` for all options. Docs: https://github.com/1sakshm/reflex/tree/main/docs
