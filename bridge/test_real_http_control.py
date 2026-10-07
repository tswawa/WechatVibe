"""Control endpoint checks using only a synthetic backend and loopback server."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import real_http
from real_http import CONTROL_TOKEN_HEADER, ROOT, app_version, make_handler


class StubBackend:
    def health(self):
        return {"version": "real-ui-1", "ok": True}


class ControlTests(unittest.TestCase):
    def server(self, token):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(StubBackend(), control_token=token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, thread

    @staticmethod
    def request(server, method, path, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        try:
            connection.request(method, path, body=b"" if method == "POST" else None,
                               headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_control_requires_exact_token_and_trusted_loopback_request(self):
        token = "a" * 64
        server, thread = self.server(token)
        with patch.object(real_http, "app_version", side_effect=AssertionError("disk version reread")):
            status, health = self.request(server, "GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["appVersion"], app_version())
        self.assertEqual(health["appVersion"], json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])
        self.assertNotIn("control_token", health)
        self.assertNotIn("controlToken", health)
        self.assertNotIn(token, json.dumps(health))
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown")[0], 403)
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown",
                                      {CONTROL_TOKEN_HEADER: "b" * 64})[0], 403)
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown",
                                      {CONTROL_TOKEN_HEADER: token, "Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown",
                                      {CONTROL_TOKEN_HEADER: token, "Host": "evil.example"})[0], 403)
        self.assertTrue(thread.is_alive())
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown",
                                      {CONTROL_TOKEN_HEADER: token}), (202, {"stopping": True}))
        thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_control_is_disabled_without_child_environment_token(self):
        server, thread = self.server(None)
        self.assertEqual(self.request(server, "POST", "/api/control/shutdown",
                                      {CONTROL_TOKEN_HEADER: "a" * 64})[0], 403)
        self.assertTrue(thread.is_alive())

    def test_javascript_static_resources_ignore_windows_registry_mime(self):
        token = "a" * 64
        server, thread = self.server(token)
        self.addCleanup(server.shutdown)
        self.assertEqual(real_http.static_content_type("app.js"), real_http.JAVASCRIPT_MIME)
        self.assertEqual(real_http.static_content_type("module.mjs"), real_http.JAVASCRIPT_MIME)
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        try:
            with patch.object(real_http.mimetypes, "guess_type", return_value=("text/plain", None)):
                connection.request("GET", "/app.js")
                response = connection.getresponse()
                body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), real_http.JAVASCRIPT_MIME)
            self.assertIn(b"function", body)
        finally:
            connection.close()
            server.shutdown()
            thread.join(2)


class ProfileModelSourceTests(unittest.TestCase):
    """One shared model-selection file means whichever instance saves last reverts the other."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="model source fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.shared = self.root / ".local" / "real-client-runtime" / "api-model-source.json"

    def test_the_default_profile_keeps_the_shared_store(self):
        self.assertIsNone(real_http.profile_model_source(None, self.root))

    def test_a_profile_gets_its_own_store_seeded_from_the_shared_one(self):
        self.shared.parent.mkdir(parents=True)
        self.shared.write_text('{"version":1,"selectedMode":"api"}', encoding="utf-8")
        store = real_http.profile_model_source("beta", self.root)
        self.assertEqual(store.path, self.root / ".local" / "real-client-runtime" / "beta"
                         / "api-model-source.json")
        self.assertEqual(store.path.read_text(encoding="utf-8"),
                         self.shared.read_text(encoding="utf-8"))
        # An instance that already chose for itself must never be overwritten by seeding.
        store.path.write_text('{"version":1,"selectedMode":"local"}', encoding="utf-8")
        again = real_http.profile_model_source("beta", self.root)
        self.assertEqual(again.path.read_text(encoding="utf-8"),
                         '{"version":1,"selectedMode":"local"}')

    def test_a_profile_without_a_shared_file_still_gets_a_store(self):
        store = real_http.profile_model_source("beta", self.root)
        self.assertEqual(store.path.name, "api-model-source.json")
        self.assertFalse(store.path.exists())


if __name__ == "__main__":
    unittest.main()
