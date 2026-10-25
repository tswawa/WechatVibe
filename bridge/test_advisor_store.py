"""Owned persistence tests: catalog config, atomic writes, projection and removal."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from advisor_contracts import AdvisorError
from advisor_store import AdvisorPathError, AdvisorStoreRoot, _write_json_atomic


class AgentConfigTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.stores = AdvisorStoreRoot(self.root)
        self.addCleanup(self.stores.close)
        self.config = self.stores.config

    def test_default_catalog_has_presets_and_stays_off_disk_until_mutated(self):
        agents = self.config.agents()
        self.assertEqual(len(agents), 4)
        self.assertTrue(all(agent["builtin"] for agent in agents))
        self.assertTrue(all(agent["welcome"] == "嗨，我是你的" + agent["name"] for agent in agents))
        self.assertFalse(self.config.path.exists())

    def test_save_keeps_stable_id_across_rename_and_bumps_revision(self):
        created = self.config.save_agent({"name": "我的军师", "description": "",
                                          "prompt": "提示", "skillIds": []})
        self.assertFalse(created["builtin"])
        self.assertTrue(created["enabled"])
        self.assertEqual(created["revision"], 1)
        renamed = self.config.save_agent({"id": created["id"], "name": "改名了",
                                          "description": "新说明", "prompt": "新提示",
                                          "skillIds": ["builtin-skill:advisor"]})
        self.assertEqual(renamed["id"], created["id"])
        self.assertEqual(renamed["revision"], 2)
        self.assertEqual(renamed["name"], "改名了")

    def test_enable_counts_as_config_change_and_builtin_delete_survives_restart(self):
        builtin = self.config.agents()[0]
        disabled = self.config.set_enabled(builtin["id"], False)
        self.assertFalse(disabled["enabled"])
        self.assertEqual(disabled["revision"], builtin["revision"] + 1)
        self.assertEqual(self.config.delete_agent(builtin["id"]), {"deleted": builtin["id"]})
        self.assertIsNone(AdvisorStoreRoot(self.root).config.agent(builtin["id"]))
        created = self.config.save_agent({"name": "临时", "description": "", "prompt": "",
                                          "skillIds": []})
        self.assertEqual(self.config.delete_agent(created["id"]), {"deleted": created["id"]})
        self.assertIsNone(self.config.agent(created["id"]))

    def test_all_agents_can_be_deleted_and_new_agent_created_in_empty_repository(self):
        for agent in self.config.agents():
            self.config.delete_agent(agent["id"])
        restored = AdvisorStoreRoot(self.root).config
        self.assertEqual(restored.agents(), [])
        created = restored.save_agent({"name": "新助手", "description": "", "prompt": "", "skillIds": []})
        self.assertEqual([row["id"] for row in AdvisorStoreRoot(self.root).config.agents()], [created["id"]])

    def test_failed_builtin_delete_keeps_card_and_persisted_document(self):
        self.config.set_enabled("builtin:advisor", True)
        before = self.config.path.read_bytes()
        with patch("advisor_store.os.replace", side_effect=OSError("synthetic write failure")):
            with self.assertRaises(OSError):
                self.config.delete_agent("builtin:advisor")
        self.assertIsNotNone(self.config.agent("builtin:advisor"))
        self.assertEqual(self.config.path.read_bytes(), before)

    def test_skill_ids_must_exist_and_imports_reject_secrets(self):
        with self.assertRaises(AdvisorError) as caught:
            self.config.save_agent({"name": "x", "description": "", "prompt": "",
                                    "skillIds": ["skill:missing"]})
        self.assertEqual(caught.exception.code, "skill-unknown")
        skill = self.config.import_skill("听感", "描述", "先听后说。")
        self.assertFalse(skill["builtin"])
        with self.assertRaises(AdvisorError) as caught:
            self.config.import_skill("听感", "描述", "重复")
        self.assertEqual(caught.exception.code, "skill-name-taken")

    def test_failed_write_keeps_previous_document(self):
        first = self.config.save_agent({"name": "一", "description": "", "prompt": "",
                                        "skillIds": []})
        before = self.config.path.read_bytes()
        with patch("advisor_store.os.replace", side_effect=OSError("synthetic disk failure")):
            with self.assertRaises(OSError):
                self.config.save_agent({"id": first["id"], "name": "二", "description": "",
                                        "prompt": "", "skillIds": []})
        self.assertEqual(self.config.path.read_bytes(), before)
        self.assertEqual(self.config.agent(first["id"])["name"], "一")
        self.assertEqual(list(self.config.directory.glob("*.tmp")), [])

    def test_restart_matches_persisted_document(self):
        created = self.config.save_agent({"name": "持久化", "description": "", "prompt": "",
                                          "skillIds": []})
        reloaded = AdvisorStoreRoot(self.root).config
        self.assertEqual(reloaded.agent(created["id"])["name"], "持久化")
        self.assertEqual(len(reloaded.agents()), 5)

    def test_custom_welcome_persists_and_rename_preserves_custom_text(self):
        created = self.config.save_agent({"name": "军师", "description": "", "prompt": "", "skillIds": [],
                                         "welcome": "我们先聊聊你的想法"})
        renamed = self.config.save_agent({"id": created["id"], "name": "改名", "description": "",
                                         "prompt": "", "skillIds": []})
        self.assertEqual(renamed["welcome"], "我们先聊聊你的想法")
        self.assertEqual(AdvisorStoreRoot(self.root).config.agent(created["id"])["welcome"], renamed["welcome"])

    def test_welcome_default_follows_rename_and_enforces_boundaries(self):
        created = self.config.save_agent({"name": "军师", "description": "", "prompt": "", "skillIds": []})
        self.assertEqual(created["welcome"], "嗨，我是你的军师")
        changed = self.config.save_agent({"id": created["id"], "name": "改名", "description": "",
                                         "prompt": "", "skillIds": []})
        self.assertEqual(changed["welcome"], "嗨，我是你的改名")
        for invalid in ("x" * 121, "invalid\nline", None):
            with self.assertRaises(AdvisorError):
                self.config.save_agent({"id": created["id"], "name": "军师", "description": "",
                                        "prompt": "", "skillIds": [], "welcome": invalid})

    def test_old_catalog_without_welcome_migrates_in_memory(self):
        created = self.config.save_agent({"name": "老配置", "description": "", "prompt": "", "skillIds": []})
        import json
        document = json.loads(self.config.path.read_text(encoding="utf-8"))
        for agent in document["agents"]:
            agent.pop("welcome", None)
        # Produce an old-format document through the same atomic writer used by configuration.
        from advisor_store import _write_json_atomic
        _write_json_atomic(self.config.path, document)
        restored = AdvisorStoreRoot(self.root).config.agent(created["id"])
        self.assertEqual(restored["welcome"], "嗨，我是你的老配置")

    def _legacy_catalog(self):
        skill = self.config.import_skill("旧技能", "旧说明", "旧正文")
        agent = self.config.save_agent({"name": "旧助手", "description": "", "prompt": "旧提示", "skillIds": [skill["id"]]})
        self.config.set_enabled(agent["id"], False)
        self.config.delete_agent("builtin:reflection")
        self.config.delete_skill("builtin-skill:empathy")
        document = json.loads(self.config.path.read_text(encoding="utf-8"))
        document["version"] = 1
        document.pop("importRequests")
        _write_json_atomic(self.config.path, document)
        return document, self.config.path.read_bytes(), skill, self.config.agent(agent["id"])

    def test_v1_catalog_migrates_on_write_with_exact_owned_backup_and_stable_ids(self):
        old, saved, skill, agent = self._legacy_catalog()
        restored = AdvisorStoreRoot(self.root).config
        self.assertEqual(restored.agent(agent["id"]), agent)
        self.assertFalse(restored.backup_path.exists())
        self.assertEqual(restored.path.read_bytes(), saved)
        restored.save_agent({"name": "新助手", "description": "", "prompt": "新提示", "skillIds": []})
        current = json.loads(restored.path.read_text(encoding="utf-8"))
        self.assertEqual(current["version"], 2)
        self.assertEqual(restored.backup_path.read_bytes(), saved)
        self.assertEqual(restored.agent(agent["id"]), agent)
        self.assertEqual(next(row for row in restored.skills() if row["id"] == skill["id"]), skill)
        self.assertEqual(current["deletedBuiltinAgentIds"], old["deletedBuiltinAgentIds"])
        self.assertEqual(current["deletedBuiltinSkillIds"], old["deletedBuiltinSkillIds"])
        self.assertIsNone(AdvisorStoreRoot(self.root).config.agent("builtin:reflection"))

    def test_v1_migration_main_write_failure_keeps_legacy_file_and_catalog(self):
        _old, saved, _skill, agent = self._legacy_catalog()
        restored = AdvisorStoreRoot(self.root).config
        before = restored.agents(), restored.skills()
        from advisor_store import os
        real_replace = os.replace
        def fail_main(source, target):
            if Path(target) == restored.path:
                raise OSError("synthetic migration disk failure")
            return real_replace(source, target)
        with patch("advisor_store.os.replace", side_effect=fail_main):
            with self.assertRaises(OSError):
                restored.save_agent({"name": "失败助手", "description": "", "prompt": "", "skillIds": []})
        self.assertEqual(restored.path.read_bytes(), saved)
        self.assertEqual(restored.backup_path.read_bytes(), saved)
        self.assertEqual((restored.agents(), restored.skills()), before)
        self.assertEqual(restored.agent(agent["id"]), agent)
        self.assertEqual(list(restored.directory.glob("*.tmp")), [])

    def test_v1_migration_backup_write_failure_does_not_replace_catalog(self):
        _old, saved, _skill, agent = self._legacy_catalog()
        restored = AdvisorStoreRoot(self.root).config
        with patch("advisor_store.os.replace", side_effect=OSError("synthetic backup disk failure")):
            with self.assertRaises(OSError):
                restored.set_enabled(agent["id"], True)
        self.assertEqual(restored.path.read_bytes(), saved)
        self.assertFalse(restored.backup_path.exists())
        self.assertFalse(restored.agent(agent["id"])["enabled"])
        self.assertEqual(list(restored.directory.glob("*.tmp")), [])

    def test_migration_does_not_overwrite_unrelated_existing_backup(self):
        _old, saved, _skill, agent = self._legacy_catalog()
        restored = AdvisorStoreRoot(self.root).config
        _write_json_atomic(restored.backup_path, {"version": 1, "unrelated": "synthetic"})
        previous_backup = restored.backup_path.read_bytes()
        with self.assertRaises(AdvisorError) as caught:
            restored.set_enabled(agent["id"], True)
        self.assertEqual(caught.exception.code, "config-invalid")
        self.assertEqual(restored.path.read_bytes(), saved)
        self.assertEqual(restored.backup_path.read_bytes(), previous_backup)

    def test_fresh_v2_store_does_not_create_legacy_backup(self):
        self.config.save_agent({"name": "新配置", "description": "", "prompt": "", "skillIds": []})
        self.assertEqual(json.loads(self.config.path.read_text(encoding="utf-8"))["version"], 2)
        self.assertFalse(self.config.backup_path.exists())

    def test_v1_changed_after_load_is_not_overwritten_or_backed_up_as_current(self):
        old, _saved, _skill, agent = self._legacy_catalog()
        restored = AdvisorStoreRoot(self.root).config
        restored.agents()
        old["agents"][0]["name"] = "Externally changed synthetic name"
        _write_json_atomic(restored.path, old)
        changed = restored.path.read_bytes()
        with self.assertRaises(AdvisorError) as caught:
            restored.set_enabled(agent["id"], True)
        self.assertEqual(caught.exception.code, "config-invalid")
        self.assertEqual(restored.path.read_bytes(), changed)
        self.assertFalse(restored.backup_path.exists())


class AccountDatabaseTests(unittest.TestCase):
    def test_latest_thread_keeps_new_reset_when_timestamps_tie_or_old_projection_changes(self):
        database = self.stores.account("synthetic-tie-account")
        with patch("advisor_store._now_ms", return_value=100):
            previous = database.create_thread("user", "builtin:advisor", "source")
            current = database.create_thread("user", "builtin:advisor", "source")
        self.assertEqual(database.latest_thread("user", "builtin:advisor")["id"], current["id"])
        database._connect().execute("UPDATE threads SET updated_at_ms=999 WHERE id=?", (previous["id"],))
        self.assertEqual(database.latest_thread("user", "builtin:advisor")["id"], current["id"])

    def setUp(self):
        temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.stores = AdvisorStoreRoot(self.root)
        self.addCleanup(self.stores.close)

    def test_thread_projection_and_request_id_idempotency(self):
        database = self.stores.account("acct-a")
        thread = database.create_thread("user-a", "builtin:advisor", "source-1")
        run, message = database.create_run(thread, "你好", "req-1", 3, 0, "source-1")
        self.assertEqual(run["state"], "running")
        self.assertEqual(message["role"], "user")
        again, duplicated = database.create_run(thread, "你好", "req-1", 3, 0, "source-1")
        self.assertEqual(again["id"], run["id"])
        self.assertIsNone(duplicated)
        self.assertIsNotNone(database.active_run(thread["id"]))
        database.finish_run(run["id"], thread["id"], "done", assistant_text="建议",
                            runtime_session_id="sess-9")
        self.assertIsNone(database.active_run(thread["id"]))
        roles = [(item["role"], item["status"]) for item in database.thread_messages(thread["id"])]
        self.assertEqual(roles, [("user", None), ("assistant", None)])
        self.assertEqual(database.thread(thread["id"])["runtime_session_id"], "sess-9")

    def test_restart_marks_running_runs_interrupted_with_status_row(self):
        database = self.stores.account("acct-restart")
        thread = database.create_thread("user-a", "builtin:advisor", "source-1")
        run, _message = database.create_run(thread, "生成中", "req-2", 1, 0, "source-1")
        self.stores.release_account("acct-restart")
        reopened = self.stores.account("acct-restart")
        row = reopened.run(run["id"])
        self.assertEqual(row["state"], "error")
        self.assertIn("中断", row["error"])
        last = reopened.thread_messages(thread["id"])[-1]
        self.assertEqual((last["role"], last["status"]), ("status", "error"))
        self.assertIn("中断", last["text"])

    def test_context_append_is_transactional_and_ignores_duplicate_sequences(self):
        database = self.stores.account("acct-context")
        database.context_begin("user-a", "[5, \"message__message_1.db\", 1]")
        rows = [self._context_row(1, "第一条"), self._context_row(2, "第二条")]
        inserted = database.context_append_page("user-a", rows, "[2, \"message__message_1.db\", 2]",
                                                "[2, \"message__message_1.db\", 2]")
        self.assertEqual(inserted, 2)
        row = database.context("user-a")
        self.assertEqual((row["state"], row["revision"], row["read_count"]), ("reading", 1, 2))
        inserted = database.context_append_page("user-a", rows, None, None)
        self.assertEqual(inserted, 0)
        self.assertEqual(database.context("user-a")["revision"], 1)
        database.context_finish("user-a", 2)
        finished = database.context("user-a")
        self.assertEqual((finished["state"], finished["total_count"], finished["revision"]),
                         ("ready", 2, 1))
        messages = database.context_messages("user-a", None)
        self.assertEqual([item["text"] for item in messages], ["第一条", "第二条"])

    def test_summaries_are_keyed_and_idempotent(self):
        database = self.stores.account("acct-summary")
        self.assertIsNone(database.summary("user-a", "key-1", "v1", "fp", 1))
        database.save_summary("user-a", "key-1", "v1", "fp", 1, "摘要")
        self.assertEqual(database.summary("user-a", "key-1", "v1", "fp", 1), "摘要")
        self.assertIsNone(database.summary("user-a", "key-1", "v1", "other-fp", 1))
        self.assertIsNone(database.summary("user-a", "key-1", "v1", "fp", 2))

    def test_remove_account_deletes_only_its_owned_directory(self):
        database = self.stores.account("acct-remove")
        other = self.stores.account("acct-keep")
        database.create_thread("user", "builtin:advisor", "source")
        other.create_thread("user", "builtin:advisor", "source")
        self.assertTrue(database.directory.is_dir())
        result = self.stores.remove_account("acct-remove")
        self.assertTrue(result["deleted"])
        self.assertFalse(database.directory.exists())
        self.assertTrue(other.directory.is_dir())

    def test_account_rejects_reparse_components(self):
        attacker = self.root / "outside"
        attacker.mkdir()
        linked = self.root / ".local" / "advisor-data"
        linked.parent.mkdir(parents=True)
        try:
            linked.symlink_to(attacker, target_is_directory=True)
        except (OSError, NotImplementedError):
            import subprocess
            created = subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(attacker)],
                                     capture_output=True)
            if created.returncode != 0:
                self.skipTest("symlinks and junctions unavailable")
        # Restricted sandboxes treat junctions as untrusted mount points and refuse to
        # traverse them (Windows 448), which would test the machine rather than the store.
        try:
            with self.assertRaises(AdvisorPathError):
                self.stores.account("acct-evil").create_thread("user", "agent", "source")
        except OSError as error:
            if getattr(error, "winerror", None) != 448:
                raise
            self.skipTest("reparse alias cannot be traversed on this volume")

    @staticmethod
    def _context_row(seq, text):
        import json
        return {"seq": seq, "msg_id": "m-%d" % seq, "sort_key": "[%d, \"s\", %d]" % (seq, seq),
                "group_chat": 0, "side": "other", "sender_id": "wxid", "sender_name": "朋友",
                "kind": "text", "text": text, "time_ms": 1_700_000_000_000 + seq,
                "raw": json.dumps({"_sort": [seq, "s", seq]})}


if __name__ == "__main__":
    unittest.main()
