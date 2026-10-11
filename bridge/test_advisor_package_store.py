"""Atomic package catalog tests with temporary files and no provider calls."""
import copy
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from advisor_contracts import AdvisorError
from advisor_packages import parse_package
from advisor_store import AdvisorStoreRoot, MAX_IMPORT_REQUESTS, _write_json_atomic


class PackageStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stores = AdvisorStoreRoot(self.root)
        self.addCleanup(self.stores.close)
        self.config = self.stores.config

    def package(self, name="Synthetic adviser", body="Use the supplied conversation evidence."):
        folder = self.root / "fixture"
        references = folder / "references"
        references.mkdir(parents=True, exist_ok=True)
        (folder / "SKILL.md").write_text(
            "---\nname: " + name + "\ndescription: Synthetic communication method\n---\n\n" +
            body + "\n\nSee [method](references/method.md).\n", encoding="utf-8")
        (references / "method.md").write_text("Separate verified facts from assumptions.", encoding="utf-8")
        (folder / "LICENSE").write_text("Synthetic fixture license.", encoding="utf-8")
        return parse_package({"kind": "local", "path": str(folder)})

    def test_package_and_assistant_are_created_by_one_catalog_commit(self):
        package = self.package()
        with patch("advisor_store._write_json_atomic", wraps=_write_json_atomic) as writer:
            result = self.config.import_assistant(package, request_id="import:one")
        self.assertEqual(writer.call_count, 1)
        self.assertTrue(result["created"])
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["agent"]["skillIds"], [result["skill"]["id"]])
        self.assertEqual(result["agent"]["importedSkillId"], result["skill"]["id"])
        self.assertEqual(result["skill"]["package"], package)
        # 4 builtin assistants/skills plus the imported pair.
        self.assertEqual(len(self.config.agents()), 5)
        self.assertEqual(len(self.config.skills()), 5)

    def test_same_package_returns_existing_renamed_assistant_without_overwriting(self):
        package = self.package()
        first = self.config.import_assistant(package, request_id="import:first")
        changed = self.config.save_agent({"id": first["agent"]["id"], "name": "User renamed",
                                          "description": "User description", "prompt": "User prompt",
                                          "welcome": "User welcome", "skillIds": first["agent"]["skillIds"]})
        result = self.config.import_assistant(package, {"name": "Ignored reimport override"}, "import:second")
        self.assertFalse(result["created"])
        self.assertEqual(result["agent"], changed)
        self.assertEqual(result["skill"]["id"], first["skill"]["id"])
        self.assertEqual(len(self.config.agents()), 5)
        self.assertEqual(len(self.config.skills()), 5)

    def test_request_replay_has_no_second_commit_and_conflicting_input_is_rejected(self):
        package = self.package()
        first = self.config.import_assistant(package, request_id="import:retry")
        before = self.config.path.read_bytes()
        with patch("advisor_store._write_json_atomic", wraps=_write_json_atomic) as writer:
            repeated = self.config.import_assistant(package, request_id="import:retry")
        writer.assert_not_called()
        self.assertEqual(repeated["agent"]["id"], first["agent"]["id"])
        with self.assertRaises(AdvisorError) as caught:
            self.config.import_assistant(package, {"prompt": "Different input"}, "import:retry")
        self.assertEqual(caught.exception.code, "request-conflict")
        self.assertEqual(self.config.path.read_bytes(), before)

    def test_request_records_are_bounded_and_survive_restart(self):
        package = self.package()
        self.config.import_assistant(package)
        for number in range(MAX_IMPORT_REQUESTS + 1):
            self.config.import_assistant(package, request_id="import:" + str(number))
        document = json.loads(self.config.path.read_text(encoding="utf-8"))
        self.assertEqual(len(document["importRequests"]), MAX_IMPORT_REQUESTS)
        self.assertEqual(document["importRequests"][0]["requestId"], "import:1")
        restored = AdvisorStoreRoot(self.root).config
        self.assertEqual(restored.agents(), self.config.agents())
        self.assertEqual(len(restored._load()["importRequests"]), MAX_IMPORT_REQUESTS)

    def test_new_package_version_creates_new_ids_and_preserves_old_package(self):
        old_package = self.package(body="Original version.")
        original = self.config.import_assistant(old_package)
        updated_package = self.package(body="Updated version.")
        updated = self.config.import_assistant(updated_package)
        self.assertNotEqual(updated["agent"]["id"], original["agent"]["id"])
        self.assertNotEqual(updated["skill"]["id"], original["skill"]["id"])
        self.assertEqual(updated["agent"]["name"], original["agent"]["name"] + " (2)")
        old_skill = next(item for item in self.config.skills() if item["id"] == original["skill"]["id"])
        self.assertEqual(old_skill["package"], old_package)

    def test_deleted_assistant_reimport_creates_new_id_and_reuses_immutable_skill(self):
        package = self.package()
        first = self.config.import_assistant(package, request_id="import:deleted")
        self.config.delete_agent(first["agent"]["id"])
        result = self.config.import_assistant(package, request_id="import:again")
        self.assertTrue(result["created"])
        self.assertNotEqual(result["agent"]["id"], first["agent"]["id"])
        self.assertEqual(result["skill"]["id"], first["skill"]["id"])
        self.assertIsNone(self.config.agent(first["agent"]["id"]))

    def test_removing_skill_from_one_assistant_does_not_delete_package_or_change_another(self):
        result = self.config.import_assistant(self.package())
        other = self.config.save_agent({"name": "Other assistant", "description": "", "prompt": "Other prompt",
                                        "skillIds": [result["skill"]["id"]]})
        edited = self.config.save_agent({"id": result["agent"]["id"], "name": result["agent"]["name"],
                                         "description": "", "prompt": "Changed prompt", "skillIds": []})
        self.assertEqual(edited["skillIds"], [])
        self.assertEqual(self.config.agent(other["id"]), other)
        self.assertIn(result["skill"]["id"], [item["id"] for item in self.config.skills()])
        self.assertNotIn("importedSkillId", AdvisorStoreRoot(self.root).config.agent(edited["id"]))

    def test_restart_preserves_full_package_and_returns_independent_copies(self):
        package = self.package()
        saved = self.config.import_assistant(package)
        package["resources"][0]["content"] = "Caller mutation"
        saved["skill"]["package"]["resources"][0]["content"] = "Return mutation"
        restored = AdvisorStoreRoot(self.root).config
        actual = next(item for item in restored.skills() if item["id"] == saved["skill"]["id"])
        self.assertEqual(actual["package"]["resources"][0]["content"], "Separate verified facts from assumptions.")
        self.assertTrue(actual["package"]["licenses"])
        self.assertEqual(restored.agent(saved["agent"]["id"])["importedSkillId"], saved["skill"]["id"])

    def test_corrupted_import_package_is_rejected_without_creating_catalog(self):
        package = self.package()
        package["resources"][0]["content"] += "Tampered"
        with self.assertRaises(AdvisorError):
            self.config.import_assistant(package)
        self.assertFalse(self.config.path.exists())
        # Only the builtins exist: 4 assistants and 4 skills since this fork added a pair.
        self.assertEqual(len(self.config.agents()), 4)
        self.assertEqual(len(self.config.skills()), 4)

    def test_corrupted_saved_resource_and_changed_legacy_content_fail_closed(self):
        result = self.config.import_assistant(self.package())
        original = json.loads(self.config.path.read_text(encoding="utf-8"))
        for kind in ("resource", "entry"):
            document = copy.deepcopy(original)
            skill = next(item for item in document["skills"] if item["id"] == result["skill"]["id"])
            if kind == "resource":
                skill["package"]["resources"][0]["content"] = "Changed resource"
            else:
                skill["content"] = "Changed inline content"
            _write_json_atomic(self.config.path, document)
            with self.assertRaises(AdvisorError) as caught:
                AdvisorStoreRoot(self.root).config.skills()
            self.assertEqual(caught.exception.code, "config-invalid")

    def test_disk_failure_has_no_half_import_or_orphan_request_record(self):
        self.config.save_agent({"name": "Existing", "description": "", "prompt": "", "skillIds": []})
        package = self.package()
        before = self.config.path.read_bytes(), self.config.agents(), self.config.skills()
        with patch("advisor_store.os.replace", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.config.import_assistant(package, request_id="import:failed")
        self.assertEqual((self.config.path.read_bytes(), self.config.agents(), self.config.skills()), before)
        self.assertEqual(self.config._load()["importRequests"], [])
        self.assertEqual(list(self.config.directory.glob("*.tmp")), [])

    def test_cancel_before_import_or_at_fsync_leaves_catalog_unchanged(self):
        package = self.package()
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(AdvisorError) as caught:
            self.config.import_assistant(package, cancel_event=cancelled)
        self.assertEqual(caught.exception.code, "stopping")
        self.assertFalse(self.config.path.exists())
        cancelled.clear()
        self.config.save_agent({"name": "Existing", "description": "", "prompt": "", "skillIds": []})
        before = self.config.path.read_bytes()
        real_fsync = os.fsync
        def cancel_after_fsync(descriptor):
            real_fsync(descriptor)
            cancelled.set()
        with patch("advisor_store.os.fsync", side_effect=cancel_after_fsync):
            with self.assertRaises(AdvisorError):
                self.config.import_assistant(package, cancel_event=cancelled)
        self.assertEqual(self.config.path.read_bytes(), before)
        self.assertEqual(len(self.config.skills()), 4)
        self.assertEqual(list(self.config.directory.glob("*.tmp")), [])

    def test_duplicate_long_name_is_not_silently_truncated(self):
        name = "N" * 60
        self.config.save_agent({"name": name, "description": "", "prompt": "", "skillIds": []})
        before = self.config.path.read_bytes()
        with self.assertRaises(AdvisorError) as caught:
            self.config.import_assistant(self.package(name=name))
        self.assertEqual(caught.exception.code, "skill-name-taken")
        self.assertEqual(self.config.path.read_bytes(), before)

    def test_import_failure_and_success_preserve_builtin_deletion_markers(self):
        self.config.delete_agent("builtin:reflection")
        self.config.delete_skill("builtin-skill:empathy")
        before = copy.deepcopy(self.config._load())
        package = self.package()
        with patch("advisor_store.os.replace", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.config.import_assistant(package)
        self.assertEqual(self.config._load(), before)
        self.config.import_assistant(package)
        restored = AdvisorStoreRoot(self.root).config
        self.assertIsNone(restored.agent("builtin:reflection"))
        self.assertNotIn("builtin-skill:empathy", [item["id"] for item in restored.skills()])

    def test_concurrent_same_request_creates_exactly_one_assistant_and_skill(self):
        package = self.package()
        barrier = threading.Barrier(8)
        outcomes, failures = [], []
        def run():
            try:
                barrier.wait(timeout=2)
                outcomes.append(self.config.import_assistant(package, request_id="import:concurrent"))
            except Exception as exc:
                failures.append(exc)
        workers = [threading.Thread(target=run) for _ in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(3)
        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(failures, [])
        self.assertEqual(len(outcomes), 8)
        self.assertEqual(sum(result["created"] for result in outcomes), 1)
        self.assertEqual(len({result["agent"]["id"] for result in outcomes}), 1)
        self.assertEqual(len(self.config.agents()), 4)
        self.assertEqual(len(self.config.skills()), 4)
        self.assertEqual(len(self.config._load()["importRequests"]), 1)

    def test_imported_association_cannot_point_to_a_plain_skill(self):
        imported = self.config.import_assistant(self.package())
        plain = self.config.import_skill("Plain fixture", "", "Plain content")
        document = json.loads(self.config.path.read_text(encoding="utf-8"))
        agent = next(row for row in document["agents"] if row["id"] == imported["agent"]["id"])
        agent["importedSkillId"] = plain["id"]
        _write_json_atomic(self.config.path, document)
        with self.assertRaises(AdvisorError) as caught:
            AdvisorStoreRoot(self.root).config.agents()
        self.assertEqual(caught.exception.code, "config-invalid")


if __name__ == "__main__":
    unittest.main()
