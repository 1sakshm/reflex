"""Laya sidecar for Reflex.

Implements the Reflex backend contract over HTTP:

    POST /v1/score        {point, question, state, candidates: [{key, id, kind, description?}], checkpoint?}
                          -> {probs: {key: p}, latencyMs, model}
    POST /v1/score_batch  {requests: [...], checkpoint?} -> {results: [...]}
    GET  /healthz

Requests in a batch that share the same state are answered in ONE Laya
forward pass (one question per decision point), which is how Reflex gets
several decisions for roughly the price of one.

`--mock` runs a dependency-free lexical scorer with the same contract, for
development and CI without Laya or model weights.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

Json = dict[str, Any]


class Scorer(Protocol):
    name: str

    def score_group(self, state: Json, requests: list[Json]) -> list[Json]:
        """Score several decision points that share one state."""


def _labels(candidates: list[Json]) -> tuple[dict[str, str], dict[str, str]]:
    """Map candidate keys to short, model-safe labels and back."""
    label_for: dict[str, str] = {}
    key_for: dict[str, str] = {}
    for index, candidate in enumerate(candidates):
        label = f"a{index}"
        label_for[candidate["key"]] = label
        key_for[label] = candidate["key"]
    return label_for, key_for


def _criteria_text(candidate: Json) -> str:
    text = candidate["id"].replace("_", " ")
    if candidate.get("description"):
        text += f": {candidate['description']}"
    return text


def _normalize(probs: dict[str, float], keys: list[str]) -> dict[str, float]:
    cleaned = {key: max(0.0, float(probs.get(key, 0.0))) for key in keys}
    total = sum(cleaned.values())
    if total <= 0 or not math.isfinite(total):
        return {key: 1.0 / len(keys) for key in keys}
    return {key: value / total for key, value in cleaned.items()}


class LayaScorer:
    """One resident Laya Router; one predict() call per distinct state."""

    def __init__(self, checkpoint: str, device: str) -> None:
        try:
            from laya import Router  # type: ignore[import-not-found]
        except ImportError as error:  # pragma: no cover - depends on optional install
            raise SystemExit(
                "Laya is not installed. Install with `pip install -e python/reflex-laya[laya]`, "
                "or run with --mock."
            ) from error
        self.checkpoint = checkpoint
        self.name = f"laya:{checkpoint}"
        self._router = Router(device=device)
        started = time.perf_counter()
        self._router.preload([checkpoint])
        self.cold_start_ms = (time.perf_counter() - started) * 1000
        self._lock = threading.Lock()

    def score_group(self, state: Json, requests: list[Json]) -> list[Json]:
        questions: Json = {}
        mappings = []
        for index, request in enumerate(requests):
            label_for, key_for = _labels(request["candidates"])
            questions[f"q{index}"] = {
                "type": "choice",
                "instructions": f"{request.get('question') or 'Which action should the agent take next?'} "
                f"(decision point: {request['point']})",
                "criteria": {label_for[c["key"]]: _criteria_text(c) for c in request["candidates"]},
            }
            mappings.append(key_for)
        started = time.perf_counter()
        with self._lock:  # one forward pass at a time on the resident model
            raw = self._router.predict(state, questions, model=self.checkpoint)
        latency = (time.perf_counter() - started) * 1000
        answers = raw.get("answers", {})
        results = []
        for index, request in enumerate(requests):
            answer = answers.get(f"q{index}", {})
            probabilities = answer.get("probabilities", {}) if isinstance(answer, dict) else {}
            key_for = mappings[index]
            keyed = {key_for[label]: p for label, p in probabilities.items() if label in key_for}
            keys = [c["key"] for c in request["candidates"]]
            results.append({"probs": _normalize(keyed, keys), "latencyMs": latency, "model": self.name})
        return results


_WORD = re.compile(r"[a-z0-9_]+")


def _words(value: Any) -> set[str]:
    return set(_WORD.findall(json.dumps(value).lower())) if value is not None else set()


class MockScorer:
    """Lexical-overlap scorer with the Laya contract. Deterministic; for development only."""

    name = "mock"

    def score_group(self, state: Json, requests: list[Json]) -> list[Json]:
        started = time.perf_counter()
        state_words = _words(state)
        results = []
        for request in requests:
            logits = []
            for candidate in request["candidates"]:
                words = _words(_criteria_text(candidate)) | _words(candidate.get("key"))
                overlap = len(words & state_words) / max(1, len(words))
                logits.append(3.0 * overlap)
            peak = max(logits) if logits else 0.0
            exps = [math.exp(logit - peak) for logit in logits]
            total = sum(exps) or 1.0
            probs = {c["key"]: e / total for c, e in zip(request["candidates"], exps)}
            results.append({"probs": probs, "latencyMs": (time.perf_counter() - started) * 1000, "model": self.name})
        return results


def score_batch(scorer: Scorer, requests: list[Json]) -> list[Json]:
    """Group requests by identical state so each group is one forward pass."""
    groups: dict[str, list[int]] = {}
    for index, request in enumerate(requests):
        validate(request)
        groups.setdefault(json.dumps(request.get("state", {}), sort_keys=True), []).append(index)
    results: list[Json | None] = [None] * len(requests)
    for state_key, indexes in groups.items():
        state = json.loads(state_key)
        for index, result in zip(indexes, scorer.score_group(state, [requests[i] for i in indexes])):
            results[index] = result
    return [result for result in results if result is not None]


def validate(request: Json) -> None:
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    if not isinstance(request.get("point"), str):
        raise ValueError("`point` is required")
    candidates = request.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("`candidates` must be a non-empty list")
    for candidate in candidates:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("key"), str) or not isinstance(candidate.get("id"), str):
            raise ValueError("each candidate needs string `key` and `id`")


def make_handler(scorer: Scorer) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - quiet by default
            pass

        def _send(self, status: int, body: Json) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send(200, {"ok": True, "model": scorer.name})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            try:
                length = int(self.headers.get("content-length", "0"))
                if length > 2_000_000:
                    return self._send(413, {"error": "body too large"})
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/v1/score":
                    return self._send(200, score_batch(scorer, [body])[0])
                if self.path == "/v1/score_batch":
                    return self._send(200, {"results": score_batch(scorer, body.get("requests", []))})
                self._send(404, {"error": "not found"})
            except ValueError as error:
                self._send(400, {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - surface as 500; Reflex fails open
                self._send(500, {"error": f"{type(error).__name__}: {error}"})

    return Handler


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="reflex-laya", description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7071)
    parser.add_argument("--checkpoint", default="english", help="Laya checkpoint (e.g. english, multilingual)")
    parser.add_argument("--device", default="cpu", help="cpu, cuda, mps")
    parser.add_argument("--mock", action="store_true", help="run the dependency-free lexical scorer")
    args = parser.parse_args(argv)
    scorer: Scorer = MockScorer() if args.mock else LayaScorer(args.checkpoint, args.device)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(scorer))
    print(f"reflex-laya ({scorer.name}) listening on http://{args.host}:{server.server_address[1]}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
