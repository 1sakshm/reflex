# @reflex-ai/bench

ReflexBench: agent-level benchmarks for [Reflex](https://github.com/1sakshm/reflex). It compares an always-frontier baseline with Reflex on the same seeded tasks and reports success rate, $ per successful task, frontier calls, wall-clock and learning curves.

```bash
npx @reflex-ai/cli bench --suite sim-coding --tasks 300
```

```ts
import { compare, formatComparison } from "@reflex-ai/bench";
console.log(formatComparison(await compare("sim-coding", 300, 42)));
```

The bundled suites are simulations: they validate mechanics, not real-world savings. See [benchmarks](https://github.com/1sakshm/reflex/blob/main/docs/benchmarks.md).
