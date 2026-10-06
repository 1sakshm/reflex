"""Tests for the Laya sidecar (mock scorer) and the Python client's fail-open behavior."""

import json
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "reflex-laya"), str(ROOT / "reflex-agent-client")]

from reflex_agent import Reflex, action  # noqa: E402
from reflex_laya.server import MockScorer, make_handler, score_batch  # noqa: E402

CANDIDATES = [
    {"key": "read_file#1", "id": "read_file", "kind": "tool", "description": '{"path":"src/date.ts"}'},
    {"key": "web_search", "id": "web_search", "kind": "search", "description": "search the web"},
    {"key": "frontier", "id": "frontier", "kind": "model"},
]
STATE = {"goal": "fix the failing test", "last_observation": {"status": "error", "text": "ImportError in src/date.ts"}}


class SidecarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(MockScorer()))
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def post(self, path, body):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read())

    def test_score_returns_normalized_probabilities(self):
        result = self.post("/v1/score", {"point": "next", "question": "what next?", "state": STATE, "candidates": CANDIDATES})
        probs = result["probs"]
        self.assertEqual(set(probs), {c["key"] for c in CANDIDATES})
        self.assertAlmostEqual(sum(probs.values()), 1.0, places=6)
        self.assertEqual(max(probs, key=probs.get), "read_file#1")

    def test_batch_groups_by_state(self):
        calls = []

        class Counting(MockScorer):
            def score_group(self, state, requests):
                calls.append(len(requests))
                return super().score_group(state, requests)

        requests = [
            {"point": "a", "state": STATE, "candidates": CANDIDATES},
            {"point": "b", "state": STATE, "candidates": CANDIDATES},
            {"point": "c", "state": {"goal": "other"}, "candidates": CANDIDATES},
        ]
        results = score_batch(Counting(), requests)
        self.assertEqual(len(results), 3)
        self.assertEqual(sorted(calls), [1, 2])  # two forward passes for three decisions

    def test_bad_request_is_400(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/v1/score", {"point": "x", "candidates": []})
        self.assertEqual(caught.exception.code, 400)


class ClientTests(unittest.TestCase):
    def test_client_fails_open_when_sidecar_is_down(self):
        reflex = Reflex(url="http://127.0.0.1:9", timeout=0.2)
        decision = reflex.decide("next", {"goal": "x"}, [action("read_file", "tool", "safe")])
        self.assertEqual(decision["type"], "escalate")
        self.assertEqual(decision["reason"], "internal_error")
        self.assertFalse(reflex.observe("", "read_file"))


if __name__ == "__main__":
    unittest.main()
