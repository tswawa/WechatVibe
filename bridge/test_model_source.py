"""Model-source security and HTTP contract checks without provider or chat access."""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from model_source import LOCAL_SOURCE_ID, ModelSourceStore, connection_values
from real_backend import Backend
from real_http import make_handler


class FakeAnalyzer:
    def __init__(self):
        self.calls = []

    def model_list(self, protocol, base_url, api_key):
        self.calls.append(("list", protocol, base_url, api_key))
        return {"models": [{"id": "test-model", "name": "Test Model"}], "supported": True}

    def model_test(self, protocol, base_url, api_key, model):
        self.calls.append(("test", protocol, base_url, api_key, model))
        return {"ok": True, "latencyMs": 12.5}


class ModelSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.path = root / ".local" / "real-client-runtime" / "model-source.json"
        self.store = ModelSourceStore(
            self.path, root=root,
            protect=lambda key: b"protected:" + key[::-1].encode("utf-8"),
            unprotect=lambda data: data.removeprefix(b"protected:").decode("utf-8")[::-1],
        )
        self.backend = object.__new__(Backend)
        self.backend.analyzer = FakeAnalyzer()
        self.backend.api_analyzer = self.backend.analyzer
        self.backend.api_probe_analyzer = self.backend.analyzer
        self.backend.api_portrait_jobs = {}
        self.backend.api_lock = threading.RLock()
        self.backend.api_jobs = {}
        self.backend.model_source_revision = 0
        self.backend.closing = False
        self.backend.model_source_store = self.store
        self.backend.active_model_source_mode = "local"
        self.backend.active_model_source_id = LOCAL_SOURCE_ID
        self.backend.active_api_config = None
        self.backend.request_lease = nullcontext

    def server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    @staticmethod
    def request(server, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        encoded = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            connection.request(method, path, body=encoded,
                               headers={"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_encrypted_profile_masks_key_and_reuse_is_endpoint_scoped(self):
        source_id = self.store.save_api("responses", "https://example.test/v1", "test-model",
                                        "test-only-key", context_tokens=128000)
        self.assertEqual(len(source_id), 32)
        self.assertNotIn("test-only-key", self.path.read_text(encoding="utf-8"))
        self.assertEqual(self.store.saved_selection()["selectedMode"], "api")
        self.assertEqual(self.store.public()["api"], {
            "protocol": "responses", "baseUrl": "https://example.test/v1",
            "model": "test-model", "contextTokens": 128000, "hasKey": True})
        self.assertEqual(self.store.public()["mode"], "local")
        self.assertEqual(self.store.resolve_key("responses", "https://example.test/v1", None), "test-only-key")
        self.assertIsNone(self.store.resolve_key("responses", "https://other.test/v1", None))
        self.assertIsNone(self.store.resolve_key("anthropic", "https://example.test/v1", None))
        self.store.save_local()
        self.assertEqual(self.store.saved_selection()["selectedMode"], "local")
        self.assertTrue(self.store.public()["api"]["hasKey"])
        self.store.clear_key()
        self.assertFalse(self.store.public()["api"]["hasKey"])

    def test_url_and_input_validation(self):
        good = connection_values({"protocol": "ollama", "baseUrl": "http://127.0.0.1:11434/"})
        self.assertEqual(good["baseUrl"], "http://127.0.0.1:11434")
        for bad in ("file:///tmp/model", "https://key@example.test/v1", "https://example.test/v1?key=x",
                    "https://example.test/v1#fragment", "https://example.test/../v1",
                    "https://example.test\\@evil.test", "https://example.test\n.evil.test"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                connection_values({"protocol": "responses", "baseUrl": bad})
        with self.assertRaises(ValueError):
            connection_values({"protocol": ["responses"], "baseUrl": "https://example.test/v1"})

    def test_context_size_validation_and_legacy_saved_profile(self):
        request = {"protocol": "responses", "baseUrl": "https://example.test/v1",
                   "model": "test-model"}
        for value in (4096, 1000000):
            with self.subTest(value=value):
                self.assertEqual(connection_values({**request, "contextTokens": value},
                                                   require_model=True)["contextTokens"], value)
        for value in (4095, 1000001, True, 8192.5, "8192"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                connection_values({**request, "contextTokens": value}, require_model=True)
        self.store.save_api("responses", "https://example.test/v1", "test-model",
                            "test-only-key")
        self.assertIsNone(self.store.public()["api"]["contextTokens"])

    def test_http_contract_probes_and_activation(self):
        server = self.server()
        status, initial = self.request(server, "GET", "/api/model-source")
        self.assertEqual(status, 200)
        self.assertEqual(initial, {"mode": "local", "api": None,
                                   "sourceId": LOCAL_SOURCE_ID, "status": "active"})
        settings = {"protocol": "responses", "baseUrl": "https://example.test/v1",
                    "apiKey": "test-only-key"}
        status, models = self.request(server, "POST", "/api/model-source/list", settings)
        self.assertEqual((status, models), (200, {"models": [{"id": "test-model", "name": "Test Model"}],
                                                  "supported": True}))
        status, tested = self.request(server, "POST", "/api/model-source/test",
                                      {**settings, "model": "test-model"})
        self.assertEqual((status, tested), (200, {"ok": True, "latencyMs": 12.5}))
        self.assertEqual(self.backend.analyzer.calls[0][-1], "test-only-key")
        status, missing = self.request(server, "POST", "/api/model-source/activate",
                                       {"mode": "api", **settings, "model": "test-model"})
        self.assertEqual(status, 400)
        self.assertEqual(self.backend.active_model_source_mode, "local")
        status, active = self.request(server, "POST", "/api/model-source/activate",
                                      {"mode": "api", **settings, "model": "test-model",
                                       "contextTokens": 128000})
        self.assertEqual(status, 200)
        self.assertEqual(active["mode"], "api")
        self.assertEqual(active["api"]["contextTokens"], 128000)
        self.assertEqual(len(active["sourceId"]), 32)
        self.assertNotIn("test-only-key", self.path.read_text(encoding="utf-8"))
        self.assertEqual(self.request(server, "POST", "/api/model-source/clear-key", {})[0], 200)
        self.assertEqual(self.backend.active_model_source_mode, "local")
        self.assertEqual(self.request(server, "POST", "/api/model-source/list",
                                      {**settings, "protocol": "unknown"})[0], 400)
        self.assertEqual(self.request(server, "POST", "/api/model-source/list", settings,
                                      {"Origin": "https://evil.test"})[0], 403)

    def test_connector_auth_error_is_reported_without_provider_body(self):
        server = self.server()
        def denied(*_args):
            raise RuntimeError("auth")
        self.backend.analyzer.model_test = denied
        status, body = self.request(server, "POST", "/api/model-source/test", {
            "protocol": "responses", "baseUrl": "https://example.test/v1",
            "model": "test-model", "apiKey": "test-only-key"})
        self.assertEqual((status, body), (503, {"error": "auth"}))
        self.assertEqual(self.backend.active_model_source_mode, "local")


if __name__ == "__main__":
    unittest.main()
