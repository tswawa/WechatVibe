"""On-demand re-generation of a single message over the analysis API.

The user's right-click path posts ``mode=message`` with one message id. The bridge must
recompute that message even though the bulk pass already saved a fine result for it, and it
must leave every other message alone.
"""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from message_contracts import FINE_LABEL_SCHEMA
from real_backend import Backend
from real_http import make_handler
from result_store import ResultStore


def fine_response(intent_label):
    return {
        "analysisVersion": "synthetic-version",
        "labelSchema": FINE_LABEL_SCHEMA,
        "groundedIntent": None,
        "emotion": [{"label": "\u5e73\u9759", "probability": 0.6}],
        "intent": [{"label": "\u786e\u8ba4", "probability": 0.5}],
        "emotionLabel": "\u5e73\u9759",
        "intentLabel": intent_label,
        "emotionP": 0.6,
        "intentP": 0.5,
        "intentBroad": [],
        "expression": [],
        "playfulIntent": [],
        "styleEvidence": None,
        "personalityEvidence": None,
        "score": 0.1,
    }


class StubSource:
    """Two analysable incoming messages: enough for the fine path and its context."""

    def __init__(self, workdir):
        self.workdir = workdir
        self.account = "wxid_real_a_abcd"

    def verified_identity(self, *, messages=False):
        return self.account, self.workdir

    def messages(self, user, limit, offset=0):
        rows = [
            {"id": "m1", "side": "other", "kind": "text", "text": "\u7b2c\u4e00\u53e5\u8bdd",
             "time": 1000, "type": "text", "senderId": user, "senderName": "\u670b\u53cb",
             "senderAvatar": None, "senderAvatarCandidates": [], "_sort": [1, "0001", 1]},
            {"id": "m2", "side": "other", "kind": "text", "text": "\u7b2c\u4e8c\u53e5\u8bdd",
             "time": 2000, "type": "text", "senderId": user, "senderName": "\u670b\u53cb",
             "senderAvatar": None, "senderAvatarCandidates": [], "_sort": [2, "0002", 2]},
        ]
        return rows[offset:offset + limit] if offset else rows[:limit]


class StubAnalyzer:
    model = {"state": "ready"}

    def __init__(self):
        self.calls = []
        self.label = "\u7b2c\u4e00\u7248"

    def analysis_version(self):
        return "synthetic-version"

    def analyze(self, session, context, target, **_kwargs):
        self.calls.append(target)
        return fine_response(self.label)


class MessageRegenerateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = StubSource(self.root / "snapshot")
        self.analyzer = StubAnalyzer()
        self.backend = Backend(
            self.source, self.analyzer,
            store_factory=lambda account, workdir: ResultStore(self.root / "results.sqlite3"))
        self.addCleanup(self.backend.shutdown)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        # Cleanups run last-registered-first: stop serving, close the socket, then join.
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, body):
        payload = json.dumps(body).encode("utf-8")
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/analyze", body=payload,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def saved(self, message_id):
        store = ResultStore(self.root / "results.sqlite3")
        return store.fine_view(self.source.account, "friend", "synthetic-version", [message_id]).get(message_id)

    def wait_for(self, predicate, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def message(self, message_id):
        for item in self.source.messages("friend", 10):
            if item["id"] == message_id:
                return item
        raise AssertionError(message_id)

    def test_message_mode_recomputes_a_message_that_already_has_a_saved_label(self):
        store = ResultStore(self.root / "results.sqlite3")
        store.save_fine(self.source.account, "friend", "synthetic-version",
                        self.message("m2"), fine_response("\u7b2c\u4e00\u7248"))
        self.assertEqual(self.saved("m2")["intentLabel"], "\u7b2c\u4e00\u7248")
        self.analyzer.label = "\u7b2c\u4e8c\u7248"
        status, data = self.request({"account": self.source.account, "user": "friend",
                                     "mode": "message", "messageId": "m2"})
        self.assertEqual(status, 202)
        self.assertEqual(data["job"]["total"], 1)
        self.assertTrue(self.wait_for(lambda: (self.saved("m2") or {}).get("intentLabel") == "\u7b2c\u4e8c\u7248"),
                        "the on-demand pass must overwrite the saved label")
        self.assertEqual(self.analyzer.calls, ["m2"])

    def test_message_mode_requires_an_id(self):
        status, data = self.request({"account": self.source.account, "user": "friend",
                                     "mode": "message"})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"], "invalid user")

    def test_unknown_message_id_fails_without_calling_the_model(self):
        scope = (str(self.source.account), str(Path(self.source.workdir).resolve()))
        job = {"id": "synthetic", "status": "queued", "total": 1, "processed": 0,
               "requested": {"mode": "message", "limit": 80, "messageId": "missing"}}
        with self.assertRaisesRegex(ValueError, "not in the analyzed window"):
            self.backend._run_fine_message(
                (self.source.account, "synthetic.sqlite3", "friend", "synthetic-version"),
                None, job, scope, "missing")
        self.assertEqual(self.analyzer.calls, [])
        self.assertEqual(job["status"], "queued")


if __name__ == "__main__":
    unittest.main()