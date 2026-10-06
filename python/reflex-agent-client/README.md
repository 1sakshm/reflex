# reflex-agent-client

Python client for the [Reflex](https://github.com/1sakshm/reflex) sidecar (`npx @reflex-ai/cli serve`). Zero dependencies, and fails open: if the sidecar is unavailable, decisions come back as `escalate`.

```python
from reflex_agent import Reflex, action

reflex = Reflex(workload="my-agent")   # REFLEX_URL defaults to http://127.0.0.1:7070
d = reflex.decide("next_action", {"lastAction": "run_tests", "lastObservation": {"status": "error"}},
                  [action("read_file", "tool", "safe"), action("frontier", "model", "cheap", reasoning=True)], task_id="t1")
if d["type"] == "auto":
    run(d["action"])
else:
    reflex.observe(d["id"], ask_frontier(d["hints"]))
reflex.task_outcome("t1", success=True)
```
