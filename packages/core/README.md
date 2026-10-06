# @reflex-ai/core

The Reflex runtime: a local, ultra-fast System-1 decision layer for AI agents. Zero runtime dependencies.

```ts
import { action, createReflex } from "@reflex-ai/core";

const reflex = createReflex({ workload: "my-agent", mode: "shadow" });
const d = await reflex.decide({ point: "next_action", state, actions, taskId });
if (d.type === "auto") run(d.action, d.params);
else reflex.observeChoice(d.id, await askFrontier(d.hints));
reflex.taskOutcome({ taskId, success });
```

See the [repository README](../../README.md) and [PRD](../../PRD.md).
