"""Reading an upgraded configuration must not depend on how the old one was written.

Version 1 stored a single profile and appended a fingerprint entry per model change, so a
file many upgrades still carry has two fingerprints pointing at one profile id. That map is
discarded and rebuilt on read, so it must not decide whether the file is readable at all:
when it did, `model_source`, the profile save and activation all failed together, the UI lost
the current model and the profile it was editing, and every retry re-probed the endpoint until
the provider answered "请求过于频繁".
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from model_source import ModelSourceStore, ModelSourceUnavailable, _source_fingerprint
from real_backend import Backend, ResultStore
from test_api_insights import Analyzer, Source

OLD_ID = "b" * 32
PROTOCOL = "responses"
BASE_URL = "https://api.example.com/v1"
MODEL = "inclusionai/ling-3.1-flash"
OTHER_MODEL = "inclusionai/ling-3.1-flash-v2"


def fingerprint(model):
    return _source_fingerprint(PROTOCOL, BASE_URL, model)


def legacy_document():
    """A version 1 file as the single-profile implementation left it."""
    return {
        "version": 1,
        "sourceId": OLD_ID,
        "selectedMode": "api",
        "api": {"name": "ling", "protocol": PROTOCOL, "baseUrl": BASE_URL,
                "model": MODEL, "encryptedKey": "dzpw", "contextTokens": 32768},
        "sourceIds": {fingerprint(MODEL): OLD_ID, fingerprint(OTHER_MODEL): OLD_ID},
    }


class LegacyProfileRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / ".local" / "api-model-source.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(legacy_document()), encoding="utf-8")
        self.store = ModelSourceStore(
            self.path, root=self.root, protect=lambda key: b"w:" + key.encode(),
            unprotect=lambda data: data[2:].decode())

    def test_duplicate_fingerprints_in_a_legacy_file_do_not_condemn_it(self):
        saved = self.store.saved_selection()
        self.assertEqual(len(saved["profiles"]), 1)
        self.assertEqual(saved["api"]["model"], MODEL)
        self.assertEqual(saved["api"]["id"], OLD_ID)

    def test_the_legacy_map_is_rebuilt_without_duplicates(self):
        self.store.save_profile(OLD_ID, "ling", PROTOCOL, BASE_URL, OTHER_MODEL, "", 32768)
        document = json.loads(self.path.read_text(encoding="utf-8"))
        source_ids = document["sourceIds"]
        self.assertEqual(len(set(source_ids.values())), len(source_ids),
                         "a profile must never keep a second identity")
        profile_for_new_model = self.store.profile_for_endpoint(PROTOCOL, BASE_URL, OTHER_MODEL)
        self.assertIsNotNone(profile_for_new_model, "the edited profile must stay reachable")

    def test_current_schema_still_rejects_two_fingerprints_for_one_profile(self):
        document = legacy_document()
        document["version"] = 2
        document["profiles"] = [{"id": OLD_ID, **document["api"]}]
        self.path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(ModelSourceUnavailable):
            self.store.saved_selection()

    def test_current_schema_still_rejects_a_malformed_fingerprint(self):
        document = legacy_document()
        document["version"] = 2
        document["profiles"] = [{"id": OLD_ID, **document["api"]}]
        document["sourceIds"] = {"not-hex": OLD_ID}
        self.path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(ModelSourceUnavailable):
            self.store.saved_selection()


class LegacyActivationTests(unittest.TestCase):
    """The three user-visible symptoms, driven through the real service methods."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        path = self.root / ".local" / "api-model-source.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(legacy_document()), encoding="utf-8")
        store = ModelSourceStore(
            path, root=self.root, protect=lambda key: b"w:" + key.encode(),
            unprotect=lambda data: data[2:].decode())
        self.backend = Backend(Source(self.root), analyzer=Analyzer(),
                               model_source_store=store,
                               store_factory=lambda a, _w: ResultStore(self.root / f"{a}.sqlite3"))
        self.addCleanup(self.backend.shutdown)
        self.account = self.backend.source.account

    def test_the_current_model_is_readable(self):
        snapshot = self.backend.model_source()
        self.assertEqual(snapshot["mode"], "api")
        self.assertEqual(snapshot["api"]["model"], MODEL)

    def test_saving_a_profile_returns_the_id_the_form_needs(self):
        result = self.backend.model_source_profile_save({
            "profileId": OLD_ID, "name": "ling", "protocol": PROTOCOL, "baseUrl": BASE_URL,
            "model": MODEL, "apiKey": "", "contextTokens": 32768})
        # Without this the UI cannot keep editing the profile it just saved.
        self.assertEqual(result["profile"], OLD_ID)

    def test_activation_succeeds_without_reprovisioning_the_profile(self):
        snapshot = self.backend.model_source_activate({
            "mode": "api", "protocol": PROTOCOL, "baseUrl": BASE_URL, "model": MODEL,
            "apiKey": "", "contextTokens": 32768})
        self.assertEqual(snapshot["api"]["id"], OLD_ID)
        self.assertEqual(len(snapshot["profiles"]), 1, "a retry must not pile up duplicates")


if __name__ == "__main__":
    unittest.main()