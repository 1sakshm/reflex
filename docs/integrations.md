# Integrations

How much Reflex can save depends on how much of the agent loop it controls:

| Tier | Surface | What Reflex can do |
|---|---|---|
| T1 | **SDK in your own loop** | Replace frontier calls for routine steps entirely. Biggest savings. |
| T2 | **Framework middleware** (your node/edge/tool-choice code) | Same as T1 at each routing point. |
| T3 | **Host plugin** (Claude Code) | Stop *wasted* work: unchanged re-reads, duplicate fetches, loops, risky commands. The host model still decides each turn. |
| T4 | **MCP tools** (any MCP client) | Advisory: the host model chooses when to ask Reflex. |

## TypeScript SDK (T1)

See [getting started](getting-started.md). A complete Claude coding agent is in [`examples/claude-coding-agent.ts`](../examples/claude-coding-agent.ts).

## Sidecar: any language

```bash
npx @reflex-ai/cli serve --port 7070          # dashboard: http://127.0.0.1:7070/ui
```

| Endpoint | Body |
|---|---|
| `POST /v1/decide` | `{ workload?, point, state, actions, taskId?, mode? }` → `Decision` |
| `POST /v1/decide_many` | `{ workload?, requests: [...] }` → `{ decisions }` |
| `POST /v1/observe` | `{ workload?, decisionId, action, takenBy? }` |
| `POST /v1/outcome` | `{ workload?, decisionId, status, costUsd?, ... }` |
| `POST /v1/task` | `{ workload?, taskId, success, ... }` |
| `POST /v1/policy/reload` | `?workload=` (after `reflex promote`) |
| `GET /v1/metrics` | `?workload=` |
| `GET /healthz`, `GET /ui` | |

The sidecar binds to `127.0.0.1`. Binding any other host requires `--token` (clients send `Authorization: Bearer <token>`).

## Python

```bash
pip install reflex-agent-client
```

```python
from reflex_agent import Reflex, action

reflex = Reflex(workload="my-agent")              # talks to `reflex serve` (REFLEX_URL)
d = reflex.decide("next_action", state, [action("read_file", "tool", "safe"), action("frontier", "model", "cheap", reasoning=True)], task_id=tid)
if d["type"] == "auto":
    run(d["action"])
else:
    choice = ask_frontier(d["hints"])
    reflex.observe(d["id"], choice)
reflex.task_outcome(tid, success=True)
```

The client fails open: if the sidecar is down, `decide()` returns an `escalate` decision.

## MCP: any MCP client

```bash
npx -y @reflex-ai/cli mcp --workload my-agent --data-dir ~/.reflex
```

Tools: `reflex_decide`, `reflex_decide_many`, `reflex_observe_choice`, `reflex_outcome`, `reflex_task_outcome`, `reflex_route_subtask` (pick small/mid/frontier for a subtask), `reflex_metrics`. Resources: `reflex://metrics/<workload>`.

## Claude Code plugin (T3)

```bash
claude plugin marketplace add 1sakshm/reflex
claude plugin install reflex@reflex
```

What it does on every tool call, in a few milliseconds:

- **Blocks re-reads of unchanged files** (mtime-checked, page/range-aware, forgotten after compaction or `/clear`, separate per subagent).
- **Blocks identical repeated WebFetch/WebSearch** in a session.
- **Stops identical tool-call loops** (3 in a row; 6 for shell commands, since re-running tests is normal).
- **Asks before destructive commands** in bash, PowerShell and cmd: broad `rm -r`, force-push / `+refspec`, `reset --hard`, `checkout -- .`, `clean -f`, `branch -D`, SQL `DROP`/`TRUNCATE`/`DELETE` without `WHERE` sent to a database client, `curl | sh`, `iwr | iex`, `mkfs`, `dd of=/dev/…`, `terraform destroy`, `kubectl delete`, package publishing, and more. Text inside quotes (commit messages, grep patterns) is ignored.
- **Optionally auto-approves read-only tools** (`autoApproveSafe`, off by default).

Commands: `/reflex-status` (what it blocked and estimated savings), `/reflex-config`. Settings live in `~/.reflex/claude-code.json`:

```json
{ "dedupeReads": true, "dedupeFetches": true, "loopWindow": 3, "shellLoopWindow": 6, "destructive": "ask", "autoApproveSafe": false, "dedupeWindow": 30, "traces": true }
```

`destructive` can be `"ask"`, `"deny"` or `"off"`. `REFLEX_DISABLE=1` turns every hook into a no-op. Hooks fail open: a Reflex bug never blocks Claude Code.

## Codex (T4)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.reflex]
command = "npx"
args = ["-y", "@reflex-ai/cli", "mcp", "--workload", "codex", "--data-dir", "~/.reflex"]
```

Then append [`integrations/codex/AGENTS.snippet.md`](../integrations/codex/AGENTS.snippet.md) to your `AGENTS.md`.

## Laya: the full-model tier

[Laya](https://huggingface.co/convaiinnovations/laya) is a fast non-autoregressive decision model (Apache-2.0). Reflex runs it in a small Python sidecar:

```bash
pip install "reflex-laya[laya]"        # pulls laya + torch
reflex-laya --checkpoint english --device cpu    # or: npx reflex laya
# no Laya installed? `reflex-laya --mock` runs a lexical scorer with the same API
```

```ts
createReflex({ workload: "x", backend: { type: "laya" }, timeoutMs: 75 });
```

Decisions that share a state are scored in one forward pass. If the sidecar is slow or down, Reflex fails open (escalates) within `timeoutMs`.

**Use the Laya tier with a GPU.** Measured with Reflex v0.1.0 + `laya` 0.3.28 (`english` checkpoint) on a Windows laptop CPU (PyTorch 2.5.1, 2 threads): **0.8–1.0 s** per decision with a short state, and **2.3–2.7 s** with descriptive candidates. Three decisions sharing a state, batched, took 2.8 s total (about the cost of one). Laya reports ~33–40 ms on a T4 GPU. On CPU-only machines, keep the default (no backend) and let the local tiers do the work. `reflex doctor` warns when the backend is too slow for the live path.

**Treat zero-shot Laya scores as a prior, not an answer.** In the same test, Laya's top choice matched the expected action in 2 of 4 generic agent situations. Reflex's risk gating escalated both misses (they were below the `costly` threshold) and auto-executed the one confident correct answer. Laya becomes more useful as Reflex calibrates it on your labels (`reflex train` fits a `model` temperature).

On Windows, if `import torch` fails with `WinError 1114` (`c10.dll`), install `torch==2.5.1` from the CPU index (`pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu`) or update the Visual C++ runtime.
