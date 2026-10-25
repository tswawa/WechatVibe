"""Actual loopback HTTP tests with synthetic source and injected runtime."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from advisor_service import AdvisorService
from advisor_imports import issue_local_grant
from real_http import make_handler
from test_advisor_support import FakeModelStore, FakeRuntime, FakeSource, wait_until


class AdvisorHttpTests(unittest.TestCase):
    def test_import_http_requires_picker_token_and_commits_a_complete_catalog(self):
        folder = Path(self.temporary.name) / "synthetic-skill"
        folder.mkdir()
        (folder / "SKILL.md").write_text("---\nname: HTTP assistant\ndescription: Synthetic\n---\nUse only supplied context.", encoding="utf-8")
        status, _ = self.request("/api/advisor/import/preview", {"source": {"kind": "local", "path": str(folder)}})
        self.assertEqual(status, 400)
        grant = issue_local_grant(self.advisor.root, folder)
        status, response = self.request("/api/advisor/import/preview", {"source": {"kind": "local", "token": grant["token"]}})
        self.assertEqual(status, 200)
        payload = {"previewId": response["preview"]["id"], "requestId": "req:http-import", "agent": {}}
        status, first = self.request("/api/advisor/import/commit", payload)
        self.assertEqual(status, 200)
        status, second = self.request("/api/advisor/import/commit", payload)
        self.assertEqual(first["importedAgentId"], second["importedAgentId"])
        # 4 builtin assistants plus the imported one.
        self.assertEqual(len(first["agents"]), 5)
        self.assertFalse(self.runtime.respond_calls)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = FakeSource()
        self.source.seed_pages("synthetic-chat", 600)
        self.runtime = FakeRuntime()
        self.advisor = AdvisorService(self.source, FakeModelStore(), Path(self.temporary.name),
                                      runtime_factory=lambda: self.runtime)
        self.addCleanup(self.advisor.shutdown)
        class Backend:
            def __init__(self, service):
                self.service = service
            def advisor_service(self):
                return self.service
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Backend(self.advisor)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_port
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def request(self, path, body=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_first_http_run_waits_for_full_managed_history(self):
        status, catalog = self.request("/api/advisor/catalog")
        self.assertEqual(status, 200)
        self.assertTrue(catalog["permissions"]["readOnly"])
        account = self.source.account
        status, payload = self.request("/api/advisor/run", {
            "account": account, "user": "synthetic-chat", "agentId": "builtin:advisor",
            "threadId": None, "message": "请给我一条建议", "requestId": "http-first-request",
        })
        self.assertEqual(status, 200, payload)
        run = payload["run"]
        path = "/api/advisor/events?account=%s&user=synthetic-chat&runId=%s&after=0" % (account, run["id"])
        terminal = wait_until(lambda: (value if value[1]["run"]["state"] in {"done", "error"} else None)
                              if (value := self.request(path)) else None)
        self.assertIsNotNone(terminal)
        self.assertEqual(terminal[1]["run"]["state"], "done", terminal)
        self.assertEqual(len(self.runtime.respond_calls), 1)
        request = self.runtime.respond_calls[0][1]
        self.assertIn("消息内容 1 ", request["contextFileText"])
        self.assertIn("消息内容 600 ", request["contextFileText"])
        self.assertNotIn("context", request)
        self.assertNotIn("contextMessageCount", request)
        self.assertNotIn("apiKey", json.dumps(terminal[1]))

    def test_cross_origin_and_unregistered_actions_are_rejected(self):
        self.assertEqual(self.request("/api/advisor/catalog", origin="https://foreign.example")[0], 403)
        self.assertEqual(self.request("/api/advisor/execute", {})[0], 404)
        self.assertEqual(self.request("/api/advisor/templates", {
            "action": "save", "agent": {"name": "Invalid", "prompt": "hi"},
            "permission": "allow", "apiKey": "synthetic-not-a-real-key",
        })[0], 400)

    def test_initial_thread_has_a_stable_identity_without_model_work(self):
        url = "/api/advisor/thread?account=%s&user=synthetic-chat&agentId=builtin:advisor" % self.source.account
        first_status, first = self.request(url)
        second_status, second = self.request(url)
        self.assertEqual((first_status, second_status), (200, 200))
        self.assertTrue(first["thread"]["id"])
        self.assertEqual(first["thread"]["id"], second["thread"]["id"])
        self.assertEqual(first["thread"]["messages"], [])
        self.assertFalse(self.runtime.respond_calls)
        self.assertFalse(self.runtime.compact_calls)

    def test_foreign_account_and_extra_full_history_are_rejected(self):
        status, _ = self.request("/api/advisor/context", {"account": "foreign", "user": "synthetic-chat"})
        self.assertNotEqual(status, 200)
        status, _ = self.request("/api/advisor/run", {
            "account": self.source.account, "user": "synthetic-chat", "agentId": "builtin:advisor",
            "message": "hi", "requestId": "x", "messages": [{"text": "untrusted replacement"}],
        })
        self.assertEqual(status, 400)
        self.assertFalse(self.runtime.respond_calls)

    def test_only_known_owned_live_run_can_be_stopped_after_account_switch(self):
        self.runtime.pause_after_first_chunk = True
        account = self.source.account
        status, started = self.request("/api/advisor/run", {
            "account": account, "user": "synthetic-chat", "agentId": "builtin:advisor",
            "message": "first", "requestId": "switch-stop-request",
        })
        self.assertEqual(status, 200)
        self.assertTrue(wait_until(self.runtime.paused.is_set))
        self.source.account = "another-synthetic-account"
        status, _ = self.request("/api/advisor/stop", {
            "account": account, "user": "foreign-chat", "runId": started["run"]["id"],
        })
        self.assertEqual(status, 404)
        status, stopped = self.request("/api/advisor/stop", {
            "account": account, "user": "synthetic-chat", "runId": started["run"]["id"],
        })
        self.assertEqual(status, 200)
        self.assertEqual(stopped["run"]["state"], "stopped")


if __name__ == "__main__":
    unittest.main()
