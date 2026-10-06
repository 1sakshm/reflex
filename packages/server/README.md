# @reflex-ai/server

Local HTTP sidecar, live dashboard and MCP server for [Reflex](https://github.com/1sakshm/reflex), the System-1 decision runtime for AI agents.

Most people use it through the CLI:

```bash
npx @reflex-ai/cli serve --port 7070   # HTTP API + dashboard at /ui
npx @reflex-ai/cli mcp                  # MCP server on stdio
```

Programmatic use:

```ts
import { ReflexService, createSidecar, listen, serveMcp } from "@reflex-ai/server";

const service = new ReflexService({ defaultWorkload: "my-agent", overrides: { mode: "shadow" } });
await listen(createSidecar(service, { token: process.env.REFLEX_TOKEN }), 7070);
```

API: see [integrations](https://github.com/1sakshm/reflex/blob/main/docs/integrations.md#sidecar-any-language).
