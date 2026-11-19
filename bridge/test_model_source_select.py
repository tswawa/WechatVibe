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
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from api_pool import ApiAnalyzerPool
from api_tasks import ApiTaskCoordinator
from advisor_service import AdvisorService
from model_source import LOCAL_SOURCE_ID, ModelSourceStore
from real_backend import Backend
from real_http import make_handler
from test_advisor_support import FakeRuntime, FakeSource


class CountingAnalyzer:
    def __init__(self):
        self.calls = []

    def model_list(self, protocol, base_url, api_key):
        self.calls.append(("list", protocol, base_url))
        return {"models": [{"id": "model-a"}], "supported": True}

    def model_test(self, protocol, base_url, api_key, model):
        self.calls.append(("test", protocol, base_url, model))
        return {"ok": True, "latencyMs": 1.0}


class SilentRuntime(FakeRuntime):
    """A provider that emits nothing until cancellation; polls cannot hide a stale run."""

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.cancelled = threading.Event()

    def respond(self, config, request, on_event, cancel_event):
        self.respond_calls.append((config, request))
        self.entered.set()
        if cancel_event.wait(5):
            self.cancelled.set()
        return {"text": "late synthetic result", "runtimeSessionId": "synthetic-session"}


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
        status, payload = request(server, "POST", "/api/model-source/select", {"profileId": "f" * 32})
        self.assertEqual(status, 400, payload)

    def activate_analysis_fixture(self):
        self.store.select_profile(self.analysis_profile)
        profile = self.store.profile(self.analysis_profile)
        self.backend.active_model_source_mode = "api"
        self.backend.active_model_profile_id = self.analysis_profile
        self.backend.active_model_source_id = self.store.profile_source_id(self.analysis_profile)
        self.backend.active_api_config = {key: profile[key] for key in
                                         ("protocol", "baseUrl", "model", "contextTokens")}

    def analysis_snapshot(self):
        saved = self.store.saved_selection()
        return {"mode": self.backend.active_model_source_mode,
                "sourceId": self.backend.active_model_source_id,
                "profileId": self.backend.active_model_profile_id,
                "config": dict(self.backend.active_api_config or {}),
                "selectedMode": saved["selectedMode"],
                "savedProfile": saved["profileId"], "savedSource": saved["sourceId"],
                "analysisCiphertext": self.store.profile(self.analysis_profile)["encryptedKey"]}

    def silent_run(self):
        self.activate_analysis_fixture()
        self.backend.model_source_select({"profileId": self.assistant_profile})
        source = FakeSource(account="synthetic-account-select", workdir=str(self.root / "source"))
        source.seed_pages("synthetic-user", 4)
        runtime = SilentRuntime()
        service = AdvisorService(source, self.store, self.root, runtime_factory=lambda: runtime)
        self.addCleanup(service.shutdown)
        self.backend._advisor = service
        result = service.start(source.account, "synthetic-user", "builtin:advisor", None,
                               "合成问题", "synthetic-select-request")
        self.assertTrue(runtime.entered.wait(3), "the provider did not receive the synthetic turn")
        run = service._runs[result["run"]["id"]]
        self.assertFalse(run.cancel.is_set())
        self.assertEqual(runtime.respond_calls[0][0]["apiKey"], "key-b")
        return service, runtime, run, result

    def test_null_restores_analysis_profile_without_activating_or_probing_analysis(self):
        self.activate_analysis_fixture()
        before = self.analysis_snapshot()
        self.backend.model_source_select({"profileId": self.assistant_profile})
        result = self.backend.model_source_select({"profileId": None})
        self.assertIsNone(result["profileId"])
        self.assertEqual(self.store.assistant_selection()["profileId"], self.analysis_profile)
        self.assertEqual(self.analysis_snapshot(), before)
        self.assertEqual(self.analyzer.calls, [])

    def test_dedicated_selection_retains_profile_bytes_and_public_never_contains_credentials(self):
        before = json.loads(self.path.read_text(encoding="utf-8"))
        result = self.backend.model_source_select({"profileId": self.assistant_profile})
        after = json.loads(self.path.read_text(encoding="utf-8"))
        for field in ("sourceId", "selectedMode", "profiles", "sourceIds"):
            self.assertEqual(after[field], before[field], field)
        public = json.dumps([result, self.backend.model_source()])
        for value in ("encryptedKey", "apiKey", "key-a", "key-b"):
            self.assertNotIn(value, public)
        for profile in before["profiles"]:
            self.assertNotIn(profile["encryptedKey"], public)

    def test_delete_dedicated_profile_preserves_analysis_and_removes_saved_selection(self):
        self.activate_analysis_fixture()
        before = self.analysis_snapshot()
        self.backend.model_source_select({"profileId": self.assistant_profile})
        self.backend.model_source_profile_delete({"profileId": self.assistant_profile})
        self.assertEqual(self.analysis_snapshot(), before)
        self.assertIsNone(self.store.assistant_selection().get("assistantProfileId"))
        self.assertEqual(self.store.assistant_selection()["profileId"], self.analysis_profile)
        document = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertNotEqual(document.get("assistantProfileId"), self.assistant_profile)
        self.assertNotIn(self.assistant_profile, [row["id"] for row in document["profiles"]])

    def test_rename_preserves_running_assistant_but_replaced_key_cancels_silent_provider(self):
        service, runtime, run, _result = self.silent_run()
        before = self.analysis_snapshot()
        original_cipher = self.store.profile(self.assistant_profile)["encryptedKey"]
        values = {"profileId": self.assistant_profile, "name": "新名称",
                  "protocol": "chat_completions", "baseUrl": "https://assistant.test/v1",
                  "model": "model-b", "contextTokens": 8192}
        self.backend.model_source_profile_save(values)
        self.assertFalse(run.cancel.is_set(), "changing only a label must not stop a running turn")
        self.assertEqual(self.store.profile(self.assistant_profile)["encryptedKey"], original_cipher)
        self.assertEqual(self.analysis_snapshot(), before)
        self.backend.model_source_profile_save({**values, "apiKey": "replacement-synthetic-key"})
        self.assertTrue(run.cancel.is_set(), "key replacement must cancel without a provider event or UI poll")
        self.assertTrue(runtime.cancelled.wait(2))
        run.worker.join(timeout=2)
        self.assertFalse(run.worker.is_alive())
        self.assertEqual(run.state, "stopped")
        self.assertEqual(self.analysis_snapshot(), before)

    def test_switch_cancels_silent_provider_immediately_and_allows_next_turn(self):
        service, runtime, run, result = self.silent_run()
        before = self.analysis_snapshot()
        self.backend.model_source_select({"profileId": None})
        self.assertTrue(run.cancel.is_set(), "switching must not wait for a provider callback or events()")
        self.assertTrue(runtime.cancelled.wait(2))
        run.worker.join(timeout=2)
        self.assertFalse(run.worker.is_alive())
        self.assertEqual(run.state, "stopped")
        self.assertEqual(self.analysis_snapshot(), before)
        messages = run.database.thread_messages(run.thread_id)
        self.assertNotIn("late synthetic result", [row["text"] for row in messages])
        runtime.entered.clear()
        next_run = service.start("synthetic-account-select", "synthetic-user", "builtin:advisor",
                                 result["threadId"], "下一轮", "synthetic-next-request")
        self.assertNotEqual(next_run["run"]["id"], run.id)
        self.assertTrue(runtime.entered.wait(3))
        self.assertEqual(runtime.respond_calls[-1][0]["model"], "model-a")
        self.assertEqual(runtime.respond_calls[-1][0]["apiKey"], "key-a")

    def test_deleting_or_clearing_dedicated_profile_cancels_silent_provider(self):
        for action in ("delete", "clear-key"):
            with self.subTest(action=action):
                # Each action gets an independent store and live provider turn.
                case = ModelSourceSelectTests()
                case.setUp()
                try:
                    service, runtime, run, _result = case.silent_run()
                    before = case.analysis_snapshot()
                    if action == "delete":
                        case.backend.model_source_profile_delete({"profileId": case.assistant_profile})
                    else:
                        case.backend.model_source_clear_key({"profileId": case.assistant_profile})
                    self.assertTrue(run.cancel.is_set(), "credential removal must proactively stop the turn")
                    self.assertTrue(runtime.cancelled.wait(2))
                    run.worker.join(timeout=2)
                    self.assertFalse(run.worker.is_alive())
                    self.assertEqual(case.analysis_snapshot(), before)
                finally:
                    case.doCleanups()

    def test_malformed_selection_has_no_write_or_advisor_notification(self):
        self.backend._advisor = Mock()
        before = self.path.read_bytes()
        for payload in (None, [], {"profileId": True}, {"profileId": []},
                        {"profileId": "a" * 31}, {"profileId": self.assistant_profile, "apiKey": "extra"}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.backend.model_source_select(payload)
            self.assertEqual(self.path.read_bytes(), before)
        self.backend._advisor.cancel_stale_runs.assert_not_called()

    def test_concurrent_select_and_reads_remain_consistent_and_leave_analysis_untouched(self):
        self.activate_analysis_fixture()
        before = self.analysis_snapshot()
        errors = []

        def change():
            try:
                for _ in range(20):
                    for profile_id in (self.assistant_profile, None):
                        self.backend.model_source_select({"profileId": profile_id})
                        snapshot = self.store.assistant_selection()
                        self.assertIn(snapshot["profileId"], (self.assistant_profile, self.analysis_profile))
                        self.assertEqual(snapshot["sourceId"], self.store.profile_source_id(snapshot["profileId"]))
                        self.assertEqual(snapshot["api"]["id"], snapshot["profileId"])
            except BaseException as error:
                errors.append(error)

        workers = [threading.Thread(target=change) for _ in range(3)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertEqual(self.analysis_snapshot(), before)


if __name__ == "__main__":
    unittest.main()
