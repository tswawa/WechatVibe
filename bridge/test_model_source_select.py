"""The assistant may use its own saved profile without moving the analysis line."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from api_pool import ApiAnalyzerPool
from api_tasks import ApiTaskCoordinator
from advisor_service import AdvisorService
from model_source import LOCAL_SOURCE_ID, ModelSourceStore
from real_backend import Backend
from real_http import make_handler


class CountingAnalyzer:
    def __init__(self):
        self.calls = []

    def model_list(self, protocol, base_url, api_key):
        self.calls.append(("list", protocol, base_url))
        return {"models": [{"id": "model-a"}], "supported": True}

    def model_test(self, protocol, base_url, api_key, model):
        self.calls.append(("test", protocol, base_url, model))
        return {"ok": True, "latencyMs": 1.0}


def request(server, method, path, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    encoded = json.dumps(body).encode("utf-8") if body is not None else None
    try:
        connection.request(method, path, body=encoded, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


class ModelSourceSelectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.root = root
        self.path = root / ".local" / "real-client-runtime" / "api-model-source.json"
        self.store = ModelSourceStore(
            self.path, root=root,
            protect=lambda key: b"protected:" + key[::-1].encode("utf-8"),
            unprotect=lambda data: data.removeprefix(b"protected:").decode("utf-8")[::-1],
        )
        self.analyzer = CountingAnalyzer()
        self.backend = object.__new__(Backend)
        self.backend.api_analyzer = self.analyzer
        self.backend.api_portrait_analyzer = self.analyzer
        self.backend.api_probe_analyzer = self.analyzer
        self.backend.api_pool = ApiAnalyzerPool(
            lambda: self.backend.api_analyzer, settings_path=root / "api-workers.json")
        self.backend.api_tasks = ApiTaskCoordinator()
        self.backend.api_lock = self.backend.api_tasks.lock
        self.backend.api_condition = self.backend.api_tasks.condition
        self.backend.model_source_store = self.store
        self.backend.model_source_revision = 0
        self.backend.closing = False
        self.backend.source = SimpleNamespace(lock=threading.RLock())
        self.backend.active_model_source_mode = "local"
        self.backend.active_model_source_id = LOCAL_SOURCE_ID
        self.backend.active_model_profile_id = None
        self.backend.active_api_config = None
        self.backend.request_lease = nullcontext
        self.analysis_profile = self.store.save_profile(
            None, "分析用", "chat_completions", "https://analysis.test/v1", "model-a", "key-a", 8192)
        self.assistant_profile = self.store.save_profile(
            None, "助手用", "chat_completions", "https://assistant.test/v1", "model-b", "key-b", 8192)

    def server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_select_moves_only_the_assistant_and_leaves_analysis_local(self):
        before = self.store.saved_selection()
        self.assertEqual(before["selectedMode"], "local")
        result = self.backend.model_source_select({"profileId": self.assistant_profile})
        self.assertEqual(result["profileId"], self.assistant_profile)
        self.assertEqual(result["sourceId"], self.store.profile_source_id(self.assistant_profile))
        after = self.store.saved_selection()
        self.assertEqual(after["selectedMode"], "local")
        self.assertEqual(after["sourceId"], before["sourceId"])
        self.assertEqual(self.backend.active_model_source_mode, "local")
        self.assertIsNone(self.backend.active_api_config)
        self.assertEqual(self.store.assistant_selection()["api"]["id"], self.assistant_profile)
        self.assertEqual(self.store.assistant_selection()["api"]["model"], "model-b")

    def test_analysis_keeps_its_own_profile_when_the_assistant_has_one(self):
        self.store.select_profile(self.analysis_profile)
        analysis_source = self.store.saved_selection()["sourceId"]
        self.backend.model_source_select({"profileId": self.assistant_profile})
        self.assertEqual(self.store.saved_selection()["profileId"], self.analysis_profile)
        self.assertEqual(self.store.saved_selection()["sourceId"], analysis_source)
        self.assertEqual(self.store.assistant_selection()["profileId"], self.assistant_profile)

    def test_assistant_falls_back_to_the_analysis_selection(self):
        self.store.select_profile(self.analysis_profile)
        self.assertEqual(self.store.assistant_selection()["profileId"], self.analysis_profile)
        self.backend.model_source_select({"profileId": self.assistant_profile})
        self.store.clear_assistant_profile()
        self.assertEqual(self.store.assistant_selection()["profileId"], self.analysis_profile)

    def test_null_profile_drops_the_pin_and_follows_analysis_again(self):
        self.store.select_profile(self.analysis_profile)
        analysis_source = self.store.saved_selection()["sourceId"]
        self.backend.model_source_select({"profileId": self.assistant_profile})
        result = self.backend.model_source_select({"profileId": None})
        self.assertIsNone(result["profileId"])
        self.assertEqual(result["sourceId"], analysis_source)
        self.assertEqual(self.store.assistant_selection()["profileId"], self.analysis_profile)
        self.assertEqual(self.store.saved_selection()["profileId"], self.analysis_profile)

    def test_assistant_engine_reads_its_own_profile(self):
        self.backend.model_source_select({"profileId": self.assistant_profile})
        service = SimpleNamespace(model_source_store=self.store)
        selected = AdvisorService._engine_selection(service)
        self.assertEqual(selected["api"]["id"], self.assistant_profile)
        self.assertEqual(selected["api"]["model"], "model-b")

    def test_selecting_a_profile_never_calls_a_provider(self):
        self.backend.model_source_select({"profileId": self.assistant_profile})
        self.assertEqual(self.analyzer.calls, [])

    def test_public_document_carries_what_the_assistant_picker_reads(self):
        """The picker resolves the followed profile by id: `api` has no name of its own."""
        self.store.select_profile(self.analysis_profile)
        selection = self.store.saved_selection()
        document = self.store.public("api", selection["sourceId"])
        self.assertEqual(document["api"]["id"], self.analysis_profile)
        self.assertNotIn("name", document["api"])
        profiles = {item["id"]: item for item in document["profiles"]}
        self.assertEqual(profiles[self.analysis_profile]["name"], "分析用")
        self.assertEqual(profiles[self.analysis_profile]["model"], "model-a")
        self.assertEqual(profiles[self.analysis_profile]["protocol"], "chat_completions")

    def test_unknown_or_malformed_profile_is_rejected_without_writing(self):
        before = self.path.read_text(encoding="utf-8")
        for payload in ({"profileId": "f" * 32}, {"profileId": "not-a-profile"},
                        {"profileId": ""}, {"profileId": 5},
                        {"profileId": self.assistant_profile, "mode": "api"}, {}):
            with self.assertRaises(ValueError):
                self.backend.model_source_select(payload)
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_http_route_selects_and_reports_400_for_unknown_profiles(self):
        server = self.server()
        status, payload = request(server, "POST", "/api/model-source/select",
                                  {"profileId": self.assistant_profile})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["profileId"], self.assistant_profile)
        self.assertEqual(self.store.assistant_selection()["api"]["id"], self.assistant_profile)
        status, payload = request(server, "POST", "/api/model-source/select", {"profileId": None})
        self.assertEqual(status, 200, payload)
        self.assertIsNone(payload["profileId"])
        self.assertIsNone(self.store.assistant_selection()["api"])
        status, payload = request(server, "POST", "/api/model-source/select", {"profileId": "f" * 32})
        self.assertEqual(status, 400, payload)


if __name__ == "__main__":
    unittest.main()
