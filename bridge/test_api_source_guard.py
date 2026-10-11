"""No provider call may happen unless the user chose an API source.

Every inference entry point must refuse while the active source is local, and it must refuse
*before* an analyzer is touched, so a stray network turn is impossible rather than merely
unlikely. The two discovery endpoints are the documented exception: an endpoint has to be
probed before it can be activated, so they run while the source is still local and only on an
explicit click.
"""
import tempfile
import unittest
from pathlib import Path

from model_source import ModelSourceStore, ModelSourceUnavailable
from real_backend import Backend, ResultStore

from test_api_insights import Analyzer, Source


class ApiSourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = Source(root)
        self.analyzer = Analyzer()
        self.store = ModelSourceStore(
            root / ".local" / "model-source.json", root=root,
            protect=lambda key: b"wrapped:" + key.encode(),
            unprotect=lambda data: data.removeprefix(b"wrapped:").decode(),
        )
        self.backend = Backend(
            self.source, analyzer=self.analyzer, model_source_store=self.store,
            store_factory=lambda account, _workdir: ResultStore(root / f"{account}.sqlite3"),
        )
        self.addCleanup(self.backend.shutdown)
        self.account = self.source.account

    def provider_counters(self):
        """Every list counter the analyzer stub keeps, so a leak cannot hide in an
        attribute this test does not know about."""
        return {name: len(value) for name, value in vars(self.analyzer).items()
                if isinstance(value, list)}

    def assert_provider_untouched(self, before, entry):
        grew = {name: (before.get(name, 0), count)
                for name, count in self.provider_counters().items()
                if count != before.get(name, 0)}
        self.assertEqual(grew, {}, f"{entry} reached the provider while the source was local")

    def entries(self):
        """The inference entry points that must all pass the same gate."""
        return (
            ("insights", lambda: self.backend.start_model_insights(self.account, "friend", 5)),
            ("guidance", lambda: self.backend.start_guidance(self.account, "friend")),
            ("portrait", lambda: self.backend.start_model_portrait(self.account, "friend")),
        )

    def activate_api(self):
        return self.backend.model_source_activate({
            "mode": "api", "protocol": "responses", "baseUrl": "https://example.test/v1",
            "model": "test-model", "apiKey": "test-key", "contextTokens": 32768,
        })

    def test_local_source_refuses_every_entry_point_without_touching_an_analyzer(self):
        for name, call in self.entries():
            with self.subTest(entry=name):
                before = self.provider_counters()
                with self.assertRaises(ModelSourceUnavailable):
                    call()
                self.assert_provider_untouched(before, name)

    def test_a_chosen_api_source_lets_the_same_entry_points_through(self):
        self.activate_api()
        before = self.provider_counters()
        for name, call in self.entries():
            with self.subTest(entry=name):
                try:
                    call()
                except ModelSourceUnavailable as exc:  # pragma: no cover - the point of the test
                    self.fail(f"{name} stayed closed after the user chose an API source: {exc}")
        grew = {name: count for name, count in self.provider_counters().items()
                if count != before.get(name, 0)}
        self.assertTrue(grew, "an accepted entry point should have reached the provider")

    def test_the_gate_reports_the_live_source_only_in_api_mode(self):
        with self.assertRaises(ModelSourceUnavailable):
            self.backend._api_source_snapshot()
        self.activate_api()
        source_id, config, key = self.backend._api_source_snapshot()
        self.assertEqual(source_id, self.backend.active_model_source_id)
        self.assertEqual(config["model"], "test-model")
        self.assertTrue(key)

    def test_switching_back_to_local_closes_the_gate_again(self):
        self.activate_api()
        self.backend.model_source_activate({"mode": "local"})
        with self.assertRaises(ModelSourceUnavailable):
            self.backend._api_source_snapshot()


if __name__ == "__main__":
    unittest.main()