"""Minimal Python client for the Reflex sidecar (`npx reflex serve`).

    from reflex_agent import Reflex, action

    reflex = Reflex(workload="my-agent")
    d = reflex.decide("next_action", state, [action("read_file", "tool", "safe"), action("frontier", "model", "cheap", reasoning=True)])
    if d["type"] == "auto":
        run(d["action"])
    else:
        choice = ask_frontier(d["hints"])
        reflex.observe(d["id"], choice)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

__all__ = ["Reflex", "action"]
__version__ = "0.1.0"


def action(id: str, kind: str, risk: str, **extra: Any) -> dict[str, Any]:  # noqa: A002
    """Build an action spec: kind in tool|model|retrieval|cache|search|retry|stop|ask_user|escalate|custom."""
    return {"id": id, "kind": kind, "risk": risk, **extra}


class Reflex:
    """Thin HTTP client. Fails open: any transport error returns an escalate decision."""

    def __init__(self, url: str | None = None, workload: str | None = None, token: str | None = None, timeout: float = 0.25):
        self.url = (url or os.environ.get("REFLEX_URL", "http://127.0.0.1:7070")).rstrip("/")
        self.workload = workload
        self.token = token or os.environ.get("REFLEX_TOKEN")
        self.timeout = timeout

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        if self.workload and "workload" not in body:
            body = {**body, "workload": self.workload}
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read())

    def decide(self, point: str, state: dict[str, Any], actions: list[dict[str, Any]], task_id: str | None = None, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"point": point, "state": state, "actions": actions, **extra}
        if task_id:
            body["taskId"] = task_id
        try:
            return self._post("/v1/decide", body)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            return {"type": "escalate", "id": "", "reason": "internal_error", "detail": f"sidecar unavailable: {error}", "hints": []}

    def observe(self, decision_id: str, action_id: str | dict[str, Any], taken_by: str = "frontier") -> bool:
        if not decision_id:
            return False
        try:
            return bool(self._post("/v1/observe", {"decisionId": decision_id, "action": action_id, "takenBy": taken_by}).get("ok"))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return False

    def outcome(self, decision_id: str, status: str, **extra: Any) -> None:
        try:
            self._post("/v1/outcome", {"decisionId": decision_id, "status": status, **extra})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass

    def task_outcome(self, task_id: str, success: bool, **extra: Any) -> None:
        try:
            self._post("/v1/task", {"taskId": task_id, "success": success, **extra})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
