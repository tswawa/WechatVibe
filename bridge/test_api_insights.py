"""API insight isolation checks with synthetic messages and a fake provider."""

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from model_source import LOCAL_SOURCE_ID, ModelSourceStore
from model_source import ModelSourceUnavailable
from real_backend import Backend, ResultStore, api_portrait_scope, api_portrait_wire_chars


class Source:
    def __init__(self, workdir):
        self.account = "account-a"
        self.workdir = str(workdir)
        self.db = object()
        self.history_pages = 0
        self.rows = [
            {"id": "s1", "side": "self", "kind": "text", "text": "周六看展吗？",
             "senderId": "me", "_sort": [1, "shard", 1]},
            {"id": "o1", "side": "other", "kind": "text", "text": "可以呀，我来找你。",
             "senderId": "friend", "_sort": [2, "shard", 2]},
            {"id": "o2", "side": "other", "kind": "text", "text": "我们下午见。",
             "senderId": "friend", "_sort": [3, "shard", 3]},
        ]

    def identity(self):
        return self.account, self.workdir

    def messages(self, user, limit):
        return self.rows[-limit:]

    def history_highwater(self, _user):
        return tuple(self.rows[-1]["_sort"]) if self.rows else None

    def history_page(self, _user, highwater, after=None, page_size=256):
        self.history_pages += 1
        rows = [item for item in self.rows if tuple(item["_sort"]) <= highwater and
                (after is None or tuple(item["_sort"]) > after)][:page_size]
        return rows, tuple(rows[-1]["_sort"]) if rows else None


class Analyzer:
    def __init__(self):
        self.calls = []
        self.insight_payloads = []
        self.portrait_calls = []
        self.fail_portrait_once = False
        self.fail_portrait_at = None
        self.entered = None
        self.release = None
        self.test_entered = None
        self.test_release = None

    def model_test(self, protocol, base_url, api_key, model):
        if self.test_entered:
            self.test_entered.set()
            self.test_release.wait(timeout=3)
        return {"ok": True, "latencyMs": 7}

    def model_insights(self, protocol, base_url, api_key, model, messages, target_ids):
        self.calls.append((protocol, base_url, model, tuple(target_ids)))
        self.insight_payloads.append(messages)
        if self.entered:
            self.entered.set()
            self.release.wait(timeout=3)
        return {"insights": [
            {"id": target_id, "status": "ok", "emotion": "期待", "intent": "邀约"}
            for target_id in target_ids]}

    def model_portrait(self, protocol, base_url, api_key, model, previous, messages):
        self.portrait_calls.append((model, previous, messages))
        if self.fail_portrait_once or len(self.portrait_calls) == self.fail_portrait_at:
            self.fail_portrait_once = False
            self.fail_portrait_at = None
            raise RuntimeError("synthetic failure")
        return {"summary": "已观察历史消息", "communication": "交流简洁",
                "emotionExpression": "", "interactionPreferences": "",
                "topics": ["见面"], "patterns": [], "boundaries": [], "uncertain": []}


class ApiInsightTests(unittest.TestCase):
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

    def activate(self, model="test-model", key="test-key", context_tokens=8192):
        return self.backend.model_source_activate({
            "mode": "api", "protocol": "responses", "baseUrl": "https://example.test/v1",
            "model": model, "apiKey": key, "contextTokens": context_tokens,
        })

    def wait_done(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.backend.model_insights("friend")
            if result["job"]["status"] in ("done", "error"):
                return result
            time.sleep(.01)
        self.fail("API insight job did not finish")

    def wait_portrait(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.backend.model_portrait("friend")
            if result["job"]["status"] in ("done", "error"):
                return result
            time.sleep(.01)
        self.fail("API portrait job did not finish")

    def wait_portrait_inventory(self, user="friend"):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.backend.model_portrait(user)
            if result["inventoryReady"]:
                return result
            self.assertNotEqual(result["inventoryStatus"], "error")
            time.sleep(.01)
        self.fail("API portrait inventory did not finish")

    def test_cached_insights_are_scoped_to_account_and_source(self):
        first = self.activate()
        self.assertEqual(first["mode"], "api")
        self.backend.start_model_insights("account-a", "friend", 3)
        done = self.wait_done()
        self.assertEqual(done["job"]["status"], "done")
        self.assertEqual(set(done["results"]), {"o1", "o2"})
        self.assertEqual(done["results"]["o1"],
                         {"id": "o1", "status": "ok", "emotion": "期待", "intent": "邀约"})
        self.assertEqual(len(self.analyzer.calls), 1)
        self.backend.model_source_activate({"mode": "local"})
        self.assertEqual(self.backend.model_insights("friend")["results"], {})
        second = self.activate()
        self.assertEqual(second["sourceId"], first["sourceId"])
        self.assertEqual(set(self.backend.model_insights("friend")["results"]), {"o1", "o2"})
        self.backend.start_model_insights("account-a", "friend", 3)
        self.assertEqual(len(self.analyzer.calls), 1, "same source should reuse saved results")
        third = self.activate(model="different-model")
        self.assertNotEqual(third["sourceId"], first["sourceId"])
        self.assertEqual(self.backend.model_insights("friend")["results"], {})
        self.source.account = "account-b"
        self.assertEqual(self.backend.model_insights("friend")["results"], {})

    def test_recent_other_is_not_skipped_by_newer_self_messages(self):
        self.source.rows.append({"id": "s2", "side": "self", "kind": "text",
                                 "text": "我到了。", "senderId": "me", "_sort": [4, "shard", 4]})
        self.activate()
        self.backend.start_model_insights("account-a", "friend", 1)
        done = self.wait_done()
        self.assertEqual(done["job"]["status"], "done")
        self.assertEqual(set(done["results"]), {"o2"})
        self.assertEqual(self.analyzer.calls[0][3], ("o2",))

    def test_client_targets_are_resolved_against_the_current_conversation(self):
        self.activate()
        self.backend.start_model_insights("account-a", "friend", 1, ["o1"])
        done = self.wait_done()
        self.assertEqual(set(done["results"]), {"o1"})
        self.assertEqual(self.analyzer.calls[0][3], ("o1",))
        with self.assertRaises(ValueError):
            self.backend.start_model_insights("account-a", "friend", 1, ["s1"])
        with self.assertRaises(ValueError):
            self.backend.start_model_insights("account-a", "friend", 1, ["other-chat-id"])

    def test_history_targets_are_resolved_from_the_selected_page(self):
        self.activate()
        older = {"id": "old", "side": "other", "kind": "text", "text": "上周见面吗？",
                 "senderId": "friend", "_sort": [0, "shard", 0]}
        with patch("real_backend.browse_history", return_value={"messages": [older, *self.source.rows]}) as browse:
            self.backend.start_model_insights("account-a", "friend", 1, ["old"], "history-anchor")
            done = self.wait_done()
        self.assertEqual(done["job"]["status"], "done")
        self.assertEqual(self.analyzer.calls[-1][3], ("old",))
        self.assertIn("old", self.backend.model_insights("friend", ids=["old"])["results"])
        browse.assert_called_once()
        self.assertEqual(browse.call_args.kwargs["limit"], 80)
        with patch("real_backend.browse_history", return_value={"messages": self.source.rows}):
            with self.assertRaises(ValueError):
                self.backend.start_model_insights("account-a", "friend", 1, ["outside"], "history-anchor")

    def test_source_switch_does_not_block_polling_or_save_stale_results(self):
        first = self.activate()
        self.analyzer.entered = threading.Event()
        self.analyzer.release = threading.Event()
        self.backend.start_model_insights("account-a", "friend", 3)
        self.assertTrue(self.analyzer.entered.wait(timeout=2))
        started = time.monotonic()
        running = self.backend.model_insights("friend")
        self.assertEqual(running["job"]["status"], "running")
        self.assertLess(time.monotonic() - started, .5)
        switched = []
        thread = threading.Thread(target=lambda: switched.append(
            self.backend.model_source_activate({"mode": "local"})))
        thread.start()
        thread.join(timeout=.5)
        self.assertFalse(thread.is_alive(), "source switching should not wait for the provider")
        self.assertEqual(switched[0]["mode"], "local")
        self.analyzer.release.set()
        deadline = time.monotonic() + 3
        while self.backend.api_inflight and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.backend.model_insights("friend")["results"], {})
        self.backend.model_source_activate({"mode": "api", "protocol": "responses",
                                            "baseUrl": "https://example.test/v1",
                                            "model": "test-model", "apiKey": "test-key",
                                            "contextTokens": 8192})
        self.assertEqual(self.backend.active_model_source_id, first["sourceId"])
        self.assertEqual(self.backend.model_insights("friend")["results"], {})

    def test_current_account_clear_drains_api_worker(self):
        self.activate()
        self.analyzer.entered = threading.Event()
        self.analyzer.release = threading.Event()
        self.backend.start_model_insights("account-a", "friend", 3)
        self.assertTrue(self.analyzer.entered.wait(timeout=2))
        finished = threading.Event()
        thread = threading.Thread(target=lambda: (self.backend.pause_for_account_clear("account-a"),
                                                  finished.set()))
        thread.start()
        self.assertFalse(finished.wait(timeout=.1))
        self.analyzer.release.set()
        self.assertTrue(finished.wait(timeout=3))
        thread.join(timeout=1)

    def test_late_api_activation_cannot_override_a_new_local_selection(self):
        self.analyzer.test_entered = threading.Event()
        self.analyzer.test_release = threading.Event()
        errors = []
        thread = threading.Thread(target=lambda: self._activate_later(errors))
        thread.start()
        self.assertTrue(self.analyzer.test_entered.wait(timeout=2))
        self.assertEqual(self.backend.model_source_activate({"mode": "local"})["mode"], "local")
        self.analyzer.test_release.set()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ModelSourceUnavailable)
        self.assertEqual(self.backend.model_source()["mode"], "local")

    def test_full_history_portrait_is_batched_resumable_and_source_scoped(self):
        for index in range(4, 38):
            self.source.rows.append({"id": f"o{index}", "side": "other", "kind": "text",
                                     "text": f"第{index}条历史消息", "senderId": "friend",
                                     "_sort": [index, "shard", index]})
        first = self.activate()
        self.analyzer.fail_portrait_once = True
        self.backend.start_model_portrait("account-a", "friend")
        failed = self.wait_portrait()
        self.assertEqual(failed["job"]["status"], "error")
        self.assertFalse(failed["progress"]["complete"])
        self.assertEqual(failed["progress"]["processed"], 0)
        self.backend.start_model_portrait("account-a", "friend")
        done = self.wait_portrait()
        self.assertEqual(done["job"]["status"], "done")
        self.assertTrue(done["progress"]["complete"])
        self.assertEqual(done["progress"]["processed"], 37)
        self.assertLess(len(self.analyzer.portrait_calls), 36)
        self.assertEqual({row["id"].split(":")[0] for _, _, batch in self.analyzer.portrait_calls[1:]
                          for row in batch}, {item["id"] for item in self.source.rows})
        self.assertTrue(all(not row["target"] for _, _, batch in self.analyzer.portrait_calls[1:]
                            for row in batch if row["sender"] == "SELF"))
        self.source.rows.append({"id": "new", "side": "other", "kind": "text", "text": "新消息",
                                 "senderId": "friend", "_sort": [38, "shard", 38]})
        pages_before_update = self.source.history_pages
        self.backend.start_model_portrait("account-a", "friend")
        updated = self.wait_portrait()
        self.assertEqual(updated["progress"]["processed"], 38)
        self.assertEqual(self.analyzer.portrait_calls[-1][2][0]["id"], "new:0")
        self.assertEqual(self.source.history_pages, pages_before_update + 2,
                         "new-message portrait should take one full history traversal")
        self.backend.start_model_insights("account-a", "friend", 1)
        self.wait_done()
        self.assertEqual(self.analyzer.insight_payloads[-1][-1]["portraitContext"],
                         "已观察历史消息")
        second = self.activate(model="other-model")
        self.assertNotEqual(second["sourceId"], first["sourceId"])
        self.backend.start_model_insights("account-a", "friend", 1)
        self.wait_done()
        self.assertNotIn("portraitContext", self.analyzer.insight_payloads[-1][-1])

    def test_context_budget_auto_splits_all_text_and_resumes_after_second_batch_failure(self):
        self.source.rows = [
            {"id": f"m{index}", "side": "self" if index % 2 else "other",
             "kind": "text", "text": f"消息{index}" * 4,
             "senderId": "me" if index % 2 else "friend",
             "_sort": [index, "shard", index]}
            for index in range(1, 71)
        ]
        self.activate(context_tokens=4096)
        first_read = self.backend.model_portrait("friend")
        self.assertIsNone(first_read["available"])
        self.assertFalse(first_read["inventoryReady"])
        available = self.wait_portrait_inventory()["available"]
        self.assertEqual((available["textCount"], available["targetTextCount"]), (70, 35))
        counted_pages = self.source.history_pages
        self.backend.model_portrait("friend")
        self.assertEqual(self.source.history_pages, counted_pages,
                         "polling should reuse the inventory for an unchanged highwater")
        self.analyzer.fail_portrait_at = 2
        self.backend.start_model_portrait("account-a", "friend")
        failed = self.wait_portrait()
        first_batch = self.analyzer.portrait_calls[0][2]
        second_batch = self.analyzer.portrait_calls[1][2]
        self.assertEqual((failed["progress"]["processed"], failed["progress"]["batchIndex"],
                          failed["progress"]["complete"]),
                         (len(first_batch), 1, False))
        self.assertGreater(failed["progress"]["batchTotal"], 1)
        self.assertEqual(second_batch[0]["id"], f"m{len(first_batch) + 1}:0")
        self.backend.start_model_portrait("account-a", "friend")
        done = self.wait_portrait()
        self.assertEqual((done["progress"]["processed"], done["progress"]["total"],
                          done["progress"]["complete"]), (70, 70, True))
        self.assertEqual(self.analyzer.portrait_calls[2][2], second_batch,
                         "retry must replay only the uncommitted batch")
        successful = [self.analyzer.portrait_calls[0], *self.analyzer.portrait_calls[2:]]
        self.assertEqual([row["id"] for _, _, batch in successful for row in batch],
                         [f"m{index}:0" for index in range(1, 71)])
        budget = api_portrait_wire_chars(4096)
        self.assertTrue(all(sum(len(json.dumps(
            {key: row[key] for key in ("id", "sender", "target", "text")},
            ensure_ascii=False, separators=(",", ":"))) + 1 for row in batch) <= budget
                            for _, _, batch in successful))
        self.assertEqual(done["progress"]["batchTotal"], len(successful))

    def test_larger_context_uses_fewer_automatic_portrait_batches(self):
        self.source.rows = [
            {"id": f"m{index}", "side": "other", "kind": "text",
             "text": "合成历史消息" * 10, "senderId": "friend",
             "_sort": [index, "shard", index]}
            for index in range(1, 71)
        ]
        self.activate(model="small-context", context_tokens=4096)
        self.backend.start_model_portrait("account-a", "friend")
        small = self.wait_portrait()
        self.activate(model="large-context", context_tokens=16384)
        self.backend.start_model_portrait("account-a", "friend")
        large = self.wait_portrait()
        self.assertEqual(small["progress"]["processed"], 70)
        self.assertEqual(large["progress"]["processed"], 70)
        self.assertGreater(small["progress"]["batchTotal"],
                           large["progress"]["batchTotal"])

    def test_context_change_replans_only_unfinished_portrait_batches(self):
        self.source.rows = [
            {"id": f"m{index}", "side": "other", "kind": "text",
             "text": "合成消息" * 8, "senderId": "friend",
             "_sort": [index, "shard", index]}
            for index in range(1, 71)
        ]
        first = self.activate(context_tokens=4096)
        self.analyzer.fail_portrait_at = 2
        self.backend.start_model_portrait("account-a", "friend")
        failed = self.wait_portrait()
        self.assertEqual(failed["job"]["status"], "error")
        saved = self.backend.store_factory("account-a", self.source.workdir).api_portrait_get(
            "account-a", "friend", api_portrait_scope(first["sourceId"]), "friend")
        old_plan = saved["plan"]
        self.assertEqual(saved["batchIndex"], 1)
        second = self.activate(context_tokens=16384)
        self.assertEqual(second["sourceId"], first["sourceId"])
        self.assertEqual(self.backend.model_portrait("friend")["job"]["status"], "idle")
        self.backend.start_model_portrait("account-a", "friend")
        done = self.wait_portrait()
        self.assertTrue(done["progress"]["complete"])
        self.assertEqual(done["progress"]["processed"], 70)
        self.assertLess(done["progress"]["batchTotal"], len(old_plan))
        self.assertEqual(self.analyzer.portrait_calls[2][2][0]["id"],
                         f"m{old_plan[0] + 1}:0")

    def test_context_change_stops_running_old_budget_before_checkpoint(self):
        self.source.rows = [
            {"id": f"m{index}", "side": "other", "kind": "text",
             "text": "合成消息" * 8, "senderId": "friend",
             "_sort": [index, "shard", index]}
            for index in range(1, 41)
        ]
        first = self.activate(context_tokens=4096)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.analyzer.model_portrait
        def delayed(*args):
            entered.set()
            release.wait(timeout=3)
            return original(*args)
        self.analyzer.model_portrait = delayed
        self.backend.start_model_portrait("account-a", "friend")
        self.assertTrue(entered.wait(timeout=1))
        second = self.activate(context_tokens=16384)
        self.assertEqual(second["sourceId"], first["sourceId"])
        release.set()
        deadline = time.monotonic() + 3
        while self.backend.api_inflight and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.backend.api_inflight, 0)
        view = self.backend.model_portrait("friend")
        self.assertEqual(view["job"]["status"], "idle")
        self.assertEqual(view["progress"]["processed"], 0)
        self.analyzer.model_portrait = original
        self.backend.start_model_portrait("account-a", "friend")
        self.assertTrue(self.wait_portrait()["progress"]["complete"])

    def test_inventory_distinguishes_all_text_from_target_text(self):
        self.source.rows = [
            {"id": f"m{index}", "side": "other" if index == 10 else "self",
             "kind": "text" if index < 11 else "other", "text": f"合成消息{index}",
             "senderId": "friend" if index == 10 else "me",
             "_sort": [index, "shard", index]}
            for index in range(17)
        ]
        self.activate()
        first = self.backend.model_portrait("friend")
        self.assertEqual(first["inventoryStatus"], "running")
        available = self.wait_portrait_inventory()["available"]
        self.assertEqual((available["messageCount"], available["textCount"],
                          available["targetTextCount"]), (17, 11, 1))
        counted_pages = self.source.history_pages
        self.backend.start_model_portrait("account-a", "friend")
        done = self.wait_portrait()
        self.assertEqual(done["progress"]["processed"], 11)
        self.assertEqual(self.source.history_pages, counted_pages,
                         "small inventory should hand off its bounded pieces to POST")
        wire = [item for _, _, batch in self.analyzer.portrait_calls for item in batch]
        self.assertEqual((len(wire), sum(item["target"] for item in wire)), (11, 1))

    def test_saved_portrait_returns_while_new_inventory_is_still_reading(self):
        self.activate()
        self.backend.start_model_portrait("account-a", "friend")
        self.assertEqual(self.wait_portrait()["job"]["status"], "done")
        self.source.rows.append({"id": "later", "side": "other", "kind": "text",
                                 "text": "合成新增消息", "senderId": "friend",
                                 "_sort": [4, "shard", 4]})
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_page = self.source.history_page
        def slow_page(*args, **kwargs):
            entered.set()
            release.wait(timeout=2)
            return original_page(*args, **kwargs)
        self.source.history_page = slow_page
        result = self.backend.model_portrait("friend")
        self.assertEqual(result["inventoryStatus"], "running")
        self.assertIsNone(result["available"])
        self.assertEqual(result["portrait"]["summary"], "已观察历史消息")
        self.assertTrue(entered.wait(timeout=1))
        release.set()
        self.assertEqual(self.wait_portrait_inventory()["available"]["textCount"], 4)

    def test_clear_one_api_source_waits_then_remains_suspended(self):
        first = self.activate()
        self.backend.start_model_insights("account-a", "friend", 1)
        self.wait_done()
        self.backend.start_model_portrait("account-a", "friend")
        self.assertEqual(self.wait_portrait()["job"]["status"], "done")
        second = self.activate(model="other-model")
        self.backend.start_model_insights("account-a", "friend", 1)
        self.wait_done()
        before = {row["sourceId"]: row for row in self.backend.analysis_cache_status()["sources"]}
        self.assertGreater(before[first["sourceId"]]["messageCount"], 0)
        self.assertGreater(before[first["sourceId"]]["portraitCount"], 0)
        self.assertGreater(before[second["sourceId"]]["messageCount"], 0)
        self.assertEqual(self.backend.analysis_cache_clear("account-a", second["sourceId"])["resumeRequired"], True)
        after = {row["sourceId"]: row for row in self.backend.analysis_cache_status()["sources"]}
        self.assertEqual((after[second["sourceId"]]["messageCount"],
                          after[second["sourceId"]]["portraitCount"]), (0, 0))
        self.assertTrue(after[second["sourceId"]]["suspended"])
        self.assertGreater(after[first["sourceId"]]["messageCount"], 0)
        self.assertEqual(self.backend.start_model_insights("account-a", "friend", 1)["job"]["status"],
                         "suspended")
        self.assertEqual(self.backend.start_model_portrait("account-a", "friend")["job"]["status"],
                         "suspended")
        self.backend.analysis_cache_resume("account-a", second["sourceId"])
        self.backend.start_model_portrait("account-a", "friend")
        self.assertEqual(self.wait_portrait()["job"]["status"], "done")

    def test_local_clear_removes_only_current_account_local_rows_and_pauses_rebuild(self):
        api = self.activate()
        self.backend.start_model_insights("account-a", "friend", 1)
        self.wait_done()
        self.backend.model_source_activate({"mode": "local"})
        account, _workdir, store = self.backend._scoped_identity()
        with store.connect() as conn:
            conn.execute("INSERT INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (account, "friend", "local-id", 1, "shard", 1, "friend", "other",
                          "{}", 0.1, "synthetic"))
            conn.execute("INSERT INTO summary_v1 VALUES (?,?,?,?,?,?,?,?)",
                         (account, "friend", "synthetic", 1, 0.1, 0.0, 0, "{}"))
            conn.execute("INSERT INTO results_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         ("account-b", "friend", "other-account-id", 1, "shard", 1,
                          "friend", "other", "{}", 0.1, "synthetic"))
        self.assertEqual(self.backend.analysis_cache_clear(account, LOCAL_SOURCE_ID)["cleared"], True)
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM results_v2 WHERE account=?",
                                          (account,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM summary_v1 WHERE account=?",
                                          (account,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM results_v2 WHERE account='account-b'").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM api_insights_v1 WHERE account=?",
                                          (account,)).fetchone()[0], 1)
        self.assertEqual(self.backend.start("friend", "recent", 1)["status"], "suspended")
        self.assertTrue(next(row for row in self.backend.analysis_cache_status()["sources"]
                             if row["sourceId"] == LOCAL_SOURCE_ID)["suspended"])
        self.assertEqual(self.backend.analysis_cache_resume(account, LOCAL_SOURCE_ID)["resumed"], True)

    def _activate_later(self, errors):
        try:
            self.activate()
        except Exception as exc:
            errors.append(exc)


if __name__ == "__main__":
    unittest.main()
