"""Read-only whole-account progress and timing endpoints behind the sidebar progress bar."""

import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from conversation_selection import ConversationSelectionStore
from real_backend import Backend
from real_http import make_handler


class StubSource:
    def __init__(self, workdir):
        self.workdir = workdir
        self.account = "wxid_real_a_abcd"

    def verified_identity(self, *, messages=False):
        return self.account, self.workdir

    def sessions(self):
        return {"account": self.account, "messagesReady": True,
                "sessions": [{"username": "wxid_a"}, {"username": "wxid_b"}]}

    def target_text_totals(self, users):
        return {user: 10 for user in users}


class StubAnalyzer:
    model = {"state": "ready"}

    def analysis_version(self):
        return "test-version"


class StubStore:
    def analysis_progress_rows(self, account, version):
        return [("wxid_a", "wxid_a", True, json.dumps({"count": 7})),
                ("wxid_b", "wxid_b", False, json.dumps({"count": 3})),
                ("wxid_group@chatroom", "", True, json.dumps({"count": 5}))]


class AnalysisOverviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.selection = ConversationSelectionStore(root / "results")
        self.backend = Backend(StubSource(root / "snapshot"), StubAnalyzer(),
                               store_factory=lambda account, workdir: StubStore(),
                               selection_store=self.selection)
        self.addCleanup(self.backend.shutdown)
        self.selection.set_selected("wxid_real_a_abcd", "wxid_a", True)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_overview_counts_only_selected_conversations(self):
        status, data = self.get("/api/analysis-overview")
        self.assertEqual(status, 200)
        # wxid_a is selected, wxid_b is not, and the group row is not this conversation.
        self.assertEqual(data["conversations"], 1)
        self.assertEqual(data["scanned"], 1)
        self.assertEqual(data["complete"], 1)
        self.assertEqual(data["analyzed"], 7)
        self.assertEqual(data["textTotal"], 10)
        self.assertEqual(data["version"], "test-version")
        self.assertNotIn("workers", data)

    def test_performance_reports_collected_timings(self):
        self.backend.performance[("wxid_real_a_abcd", "wxid_a", "test-version")] = {
            "analyzeMs": 5.0, "count": 2.0, "note": "not-a-number"}
        status, data = self.get("/api/analysis-performance")
        self.assertEqual(status, 200)
        self.assertEqual(data["totals"]["analyzeMs"], 5.0)
        self.assertEqual(data["totals"]["count"], 2.0)
        self.assertEqual(data["totals"]["conversations"], 1)
        self.assertNotIn("note", data["totals"])


if __name__ == "__main__":
    unittest.main()
