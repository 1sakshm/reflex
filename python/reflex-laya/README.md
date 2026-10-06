# reflex-laya

[Laya](https://huggingface.co/convaiinnovations/laya) full-model sidecar for [Reflex](https://github.com/1sakshm/reflex). It scores an agent's candidate actions in one non-autoregressive forward pass, and batches decisions that share a state into a single pass.

```bash
pip install "reflex-laya[laya]"                 # installs laya + torch
reflex-laya --checkpoint english --device cpu   # http://127.0.0.1:7071
reflex-laya --mock                              # no Laya needed: lexical scorer, same API
```

Then in Reflex: `createReflex({ workload, backend: { type: "laya" } })`.

API: `POST /v1/score`, `POST /v1/score_batch`, `GET /healthz`. See the [backend contract](https://github.com/1sakshm/reflex/blob/main/docs/api.md#backends).
