"""Synthetic backfill, durable recovery, and narrowly scoped reset checks."""
import hashlib
import json
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend_contracts import LOCAL_SOURCE_ID
from batch_engine import BatchEngine
from batch_state import BatchStateStore
from profile_state import empty_state
from result_store import ResultStore


def signal(label="happy", score=.5):
    return {"score": score, "emotion": [{"label": label, "rawLabel": label, "probability": 1}],
            "intent": [], "intentBroad": []}


def message(number, user="friend", sender=None):
    return {"id": f"{user}-{number}", "_sort": (number, "message__message_0.db", number),
            "senderId": sender or user, "side": "other", "kind": "text", "text": f"word {number}"}


class SyntheticHistory:
    def __init__(self):
        self.rows = []
        self.pages = 0

    def history_highwater(self, user):
        return max((row["_sort"] for row in self.rows), default=None)

    def history_revision(self, user):
        return hashlib.sha256(json.dumps([row["id"] for row in self.rows]).encode()).hexdigest()

    def history_prefix_signature(self, user, ceiling):
        ids = sorted(row["id"] for row in self.rows if ceiling is not None and row["_sort"] <= ceiling)
        return hashlib.sha256(json.dumps(ids).encode()).hexdigest()

    def history_page(self, user, ceiling, after=None):
        self.pages += 1
        rows = sorted((row for row in self.rows if row["_sort"] <= ceiling and
                       (after is None or row["_sort"] > after)), key=lambda row: row["_sort"])[:256]
        return rows, rows[-1]["_sort"] if rows else None


class SyntheticBatchAnalyzer:
    def __init__(self):
        self.targets = []

    def analyze_batch(self, scope, payload, context):
        targets = [row["id"] for row in payload if row["target"]]
        self.targets.extend(targets)
        return {"consumed": [{"start": row["offset"], "end": len(row["text"]), "complete": True}
                             for row in payload], "result": signal() if targets else None}


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wechatvibe-synthetic-core-")
        self.addCleanup(self.temporary.cleanup)
        self.store = ResultStore(Path(self.temporary.name) / "synthetic.sqlite3")
        self.source = SyntheticHistory()
        self.analyzer = SyntheticBatchAnalyzer()
        self.backend = SimpleNamespace(source=self.source, analyzer=self.analyzer,
                                       jobs_lock=threading.RLock(), performance={},
                                       _assert_scope=lambda scope: None, _take_recent_priority=lambda key: None,
                                       _scope_commit=lambda scope: nullcontext(),
                                       _legacy_profile_state=lambda *args: empty_state())
        self.engine = BatchEngine(self.backend)
        self.scope = ("synthetic-account", "friend", "synthetic-version")

    def assert_state_close(self, left, right):
        if isinstance(left, dict):
            self.assertEqual(set(left), set(right))
            for key in left:
                self.assert_state_close(left[key], right[key])
        elif isinstance(left, list):
            self.assertEqual(len(left), len(right))
            for first, second in zip(left, right):
                self.assert_state_close(first, second)
        elif isinstance(left, float):
            self.assertAlmostEqual(left, right, places=12)
        else:
            self.assertEqual(left, right)

    def run_incremental(self):
        with patch("batch_engine.keyword_counts", return_value={"word": 1}):
            list(self.engine.incremental(*self.scope, self.store, {}, (self.scope[0], "synthetic-workdir"), ()))
        return self.engine.snapshot(*self.scope, self.store)

    def test_old_insert_and_tail_insert_infer_only_missing_and_reopen_deduplicates(self):
        self.source.rows = [message(number) for number in (1, 3, 5)]
        self.assertEqual(self.run_incremental()["state"]["count"], 3)
        old_pages = self.source.pages
        self.run_incremental()
        self.assertEqual(self.source.pages, old_pages)
        self.source.rows.append(message(7))
        self.run_incremental()
        self.assertEqual(self.source.pages-old_pages, 1)
        self.source.rows.extend([message(2), message(9)])
        state = self.run_incremental()
        self.assertEqual(state["state"]["count"], 6)
        self.assertEqual(state["state"]["moodCount"], 6)
        self.assertEqual(state["state"]["scoreWeighted"], 7.5)
        self.assertEqual(len(self.analyzer.targets), 6)
        self.assertEqual(len(set(self.analyzer.targets)), 6)
        self.engine = BatchEngine(self.backend)
        before = self.source.pages
        self.assertEqual(self.run_incremental()["state"], state["state"])
        self.assertEqual(self.source.pages, before)

    def test_missing_batch_progress_reconstructs_all_statistics_without_model_calls(self):
        self.source.rows = [message(number) for number in (1, 3, 5)]
        expected = self.run_incremental()["state"]
        with self.store.connect() as conn:
            conn.execute("DELETE FROM batch_progress_v1")
        self.engine = BatchEngine(self.backend)
        restored = self.run_incremental()
        self.assert_state_close(restored["state"], expected)
        self.assertEqual(len(self.analyzer.targets), 3)
        self.source.rows.append(message(2))
        restored = self.run_incremental()
        self.assertEqual(restored["state"]["count"], 4)
        self.assertEqual(restored["state"]["mood"]["happy"], {"label": "happy", "sum": 4.0, "weighted": 6.0})
        self.assertEqual(len(self.analyzer.targets), 4)

    def test_incomplete_saved_mood_statistics_recover_before_old_insert(self):
        self.source.rows = [message(number) for number in (3, 5)]
        self.run_incremental()
        with self.store.connect() as conn:
            row = conn.execute("SELECT state_json FROM batch_progress_v1").fetchone()
            state = json.loads(row[0])
            state["mood"] = {}
            state["moodCount"] = 0
            conn.execute("UPDATE batch_progress_v1 SET state_json=?", (json.dumps(state),))
        self.source.rows.append(message(1))
        recovered = self.run_incremental()["state"]
        self.assertEqual(recovered["count"], 3)
        self.assertEqual(recovered["moodCount"], 3)
        self.assertEqual(recovered["mood"]["happy"]["weighted"], 3.0)
        self.assertEqual(recovered["scoreWeighted"], 1.5)
        self.assertEqual(len(self.analyzer.targets), 3)

    def test_old_insert_during_reconciliation_stays_pending_for_next_pass(self):
        self.source.rows = [message(number) for number in (3, 5)]
        self.run_incremental()
        self.source.rows.append(message(2))
        original = self.analyzer.analyze_batch

        def insert_during_inference(*args):
            response = original(*args)
            self.source.rows.append(message(1))
            self.analyzer.analyze_batch = original
            return response

        self.analyzer.analyze_batch = insert_during_inference
        self.assertEqual(self.run_incremental()["state"]["count"], 3)
        self.assertTrue(self.engine.reconcile_pending(*self.scope, self.store))
        self.assertEqual(self.run_incremental()["state"]["count"], 4)
        self.assertEqual(len(self.analyzer.targets), 4)
        self.assertEqual(len(set(self.analyzer.targets)), 4)

    def test_multi_page_prefix_scan_runs_once_per_old_insert(self):
        self.source.rows = [message(2*number) for number in range(1, 601)]
        self.assertEqual(self.run_incremental()["state"]["count"], 600)
        before = self.source.pages
        self.source.rows.extend([message(1), message(1202)])
        self.assertEqual(self.run_incremental()["state"]["count"], 602)
        self.assertEqual(self.source.pages-before, 5)
        before = self.source.pages
        self.run_incremental()
        self.assertEqual(self.source.pages, before)
        self.assertEqual(len(set(self.analyzer.targets)), 602)
        self.assertEqual(len(self.analyzer.targets), 602)

    def test_recovery_reports_missing_old_lexical_evidence_without_seeding_partial_state(self):
        self.source.rows = [message(1)]
        self.run_incremental()
        with self.store.connect() as conn:
            conn.execute("DELETE FROM batch_progress_v1")
            conn.execute("DELETE FROM profile_tokens_v1")
        batches = BatchStateStore(self.store)
        with self.assertRaisesRegex(RuntimeError, "evidence is incomplete"):
            batches.seed(*self.scope, "friend", empty_state())
        self.assertIsNone(batches.load(*self.scope, "friend"))
        refs = batches.recovery_refs(*self.scope, "friend")
        self.assertEqual(refs, [("message__message_0.db", 1, "friend-1")])
        with patch("batch_state.keyword_counts", return_value={"word": 1}):
            batches.restore_words(*self.scope, refs, {"friend-1": "word 1"})
        self.assertEqual(batches.seed(*self.scope, "friend", empty_state())["state"]["count"], 1)

    def test_partial_fragments_survive_progress_loss_and_count_once(self):
        batches = BatchStateStore(self.store)
        identity = (*self.scope, "friend")
        batches.seed(*identity, empty_state())
        record = {"id": "split", "position": [1, "message__message_0.db", 1], "senderId": "friend",
                  "side": "other", "target": True, "startOffset": 0, "endOffset": 2,
                  "textLength": 4, "complete": False}
        batches.commit(*identity, batch_id="first", consumed=[record], cursor=tuple(record["position"]),
                       char_offset=2, context=[], result=signal("happy", .2))
        with self.store.connect() as conn:
            conn.execute("DELETE FROM batch_progress_v1")
        restored = batches.seed(*identity, empty_state())
        self.assertEqual(restored["state"]["count"], 0)
        batches.move_cursor(*identity, tuple(record["position"]), [], char_offset=2)
        record.update(startOffset=2, endOffset=4, complete=True)
        complete = batches.commit(*identity, batch_id="second", consumed=[record], cursor=tuple(record["position"]),
                                  char_offset=0, context=[], result=signal("neutral", .8), word_counts={"split": {"word": 1}})
        with self.store.connect() as conn:
            conn.execute("DELETE FROM batch_progress_v1")
        self.assertEqual(batches.seed(*identity, empty_state())["state"], complete["state"])
        self.assertEqual(complete["state"]["count"], 1)
        self.assertAlmostEqual(complete["state"]["scoreSum"], .5)
        with self.store.connect() as conn:
            conn.execute("DELETE FROM batch_progress_v1")
            conn.execute("DELETE FROM batch_fragments_v1 WHERE start_offset=0")
        with self.assertRaisesRegex(RuntimeError, "fragments are incomplete"):
            batches.seed(*identity, empty_state())
        self.assertIsNone(batches.load(*identity))

    def test_summary_and_profile_rebuild_out_of_order_emotions_independent_of_scores(self):
        with patch("result_store.keyword_counts", return_value={}):
            self.store.save(*self.scope, message(3), signal("neutral", None))
            self.store.save(*self.scope, message(5), signal("happy", .5))
            self.store.profile_state(*self.scope, "friend", lambda refs: {})
            with self.store.connect() as conn:
                conn.execute("DELETE FROM summary_v1")
                conn.execute("UPDATE profile_state_v1 SET state=?", (json.dumps(empty_state()),))
            self.store.save(*self.scope, message(1), signal("sad", None))
        summary = self.store.summary(*self.scope)
        profile = self.store.profile_state(*self.scope, "friend", lambda refs: {})
        self.assertEqual(summary["moodCount"], 3)
        self.assertEqual(profile["moodCount"], 3)
        self.assertEqual({key: entry["weighted"] for key, entry in summary["mood"].items()},
                         {"sad": 0.0, "neutral": 1.0, "happy": 2.0})
        self.assertEqual(profile["mood"], summary["mood"])
        with self.store.connect() as conn:
            conn.execute("DELETE FROM summary_v1")
            conn.execute("DELETE FROM profile_state_v1")
        reopened = ResultStore(self.store.path)
        self.assertEqual(reopened.summary(*self.scope), summary)
        self.assertEqual(reopened.profile_state(*self.scope, "friend", lambda refs: {}), profile)

    def test_pr31_original_tail_labels_rebuild_summary_and_profile_completely(self):
        # PR #31 used happy/开心/.8 + a newer sad/难过/.6 whose label had
        # disappeared. Restore the durable tail's sum as well as its weighted term.
        happy = {**signal(), "emotion": [{"rawLabel": "happy", "label": "开心", "probability": .8}]}
        sad = {**signal(), "emotion": [{"rawLabel": "sad", "label": "难过", "probability": .6}]}
        with patch("result_store.keyword_counts", return_value={}):
            self.store.save(*self.scope, message(5), sad)
            self.store.profile_state(*self.scope, "friend", lambda refs: {})
            with self.store.connect() as conn:
                summary = self.store.summary(*self.scope)
                summary["mood"] = {}
                conn.execute("UPDATE summary_v1 SET mood_json=?", (json.dumps(summary["mood"]),))
                row = conn.execute("SELECT state FROM profile_state_v1").fetchone()
                state = json.loads(row[0])
                state["mood"] = {}
                conn.execute("UPDATE profile_state_v1 SET state=?", (json.dumps(state),))
            self.store.save(*self.scope, message(3), happy)
        summary = self.store.summary(*self.scope)
        profile = self.store.profile_state(*self.scope, "friend", lambda refs: {})
        self.assertEqual(summary["mood"]["sad"], {"label": "难过", "sum": .6, "weighted": .6})
        self.assertEqual(profile["mood"], summary["mood"])
        self.assertEqual((summary["moodCount"], profile["count"]), (2, 2))

    def test_pr31_original_tail_labels_rebuild_batch_statistics_completely(self):
        batches = BatchStateStore(self.store)
        identity = (*self.scope, "friend")
        batches.seed(*identity, empty_state())
        def commit(number, raw, label, probability):
            record = {"id": f"row-{number}", "position": [number, "message__message_0.db", number],
                      "senderId": "friend", "side": "other", "target": True,
                      "startOffset": 0, "endOffset": 1, "textLength": 1, "complete": True}
            return batches.commit(*identity, batch_id=f"batch-{number}", consumed=[record],
                                  cursor=None, char_offset=0, context=[], advance=False,
                                  word_counts={record["id"]: {}}, result={**signal(), "emotion": [
                                      {"rawLabel": raw, "label": label, "probability": probability}]})
        saved = commit(5, "sad", "难过", .6)
        saved["state"]["mood"] = {}
        with self.store.connect() as conn:
            conn.execute("UPDATE batch_progress_v1 SET state_json=?", (json.dumps(saved["state"]),))
        recovered = commit(3, "happy", "开心", .8)["state"]
        self.assertEqual(recovered["mood"]["sad"], {"label": "难过", "sum": .6, "weighted": .6})
        self.assertEqual((recovered["moodCount"], recovered["count"]), (2, 2))

    def test_scoped_portrait_reset_preserves_messages_other_members_and_accounts(self):
        self.source.rows = [message(1)]
        self.run_incremental()
        with patch("result_store.keyword_counts", return_value={}):
            self.store.save(*self.scope, message(1), signal())
            self.store.save("other-account", "friend", self.scope[2], message(4), signal())
            self.store.save(self.scope[0], "other-chat", self.scope[2], message(4, "other-chat"), signal())
        self.store.save_fine(*self.scope, message(1), signal())
        self.store.advance(*self.scope, message(1)["_sort"], [], complete=True)
        counts = self.store.clear_scope(self.scope[0], "friend", LOCAL_SOURCE_ID, subject="friend")
        self.assertGreater(counts["portraitRows"], 0)
        self.assertEqual(len(self.store.items(*self.scope)), 1)
        self.assertIn("friend-1", self.store.fine_view(*self.scope))
        self.engine = BatchEngine(self.backend)
        self.assertEqual(self.run_incremental()["state"]["count"], 1)
        self.assertEqual(len(self.analyzer.targets), 2)
        for subject in ("", "one", "two"):
            self.engine.store(self.store).seed(self.scope[0], "room@chatroom", self.scope[2], subject, empty_state())
        self.store.clear_scope(self.scope[0], "room@chatroom", LOCAL_SOURCE_ID, subject="")
        self.assertIsNone(self.engine.store(self.store).load(self.scope[0], "room@chatroom", self.scope[2], ""))
        self.assertIsNotNone(self.engine.store(self.store).load(self.scope[0], "room@chatroom", self.scope[2], "one"))
        self.store.clear_scope(self.scope[0], "friend", LOCAL_SOURCE_ID)
        self.assertEqual(self.store.items(*self.scope), [])
        self.assertEqual(len(self.store.items("other-account", "friend", self.scope[2])), 1)
        self.assertEqual(len(self.store.items(self.scope[0], "other-chat", self.scope[2])), 1)
        with self.assertRaises(ValueError):
            self.store.clear_scope(self.scope[0], "friend", LOCAL_SOURCE_ID, subject="other")

    def test_group_overall_and_member_reset_ignore_old_progress_and_preserve_other_portraits(self):
        room = "room@chatroom"
        identity = (self.scope[0], room, self.scope[2])
        self.source.rows = [message(1, room, "one"), message(3, room, "two")]
        with patch("result_store.keyword_counts", return_value={}):
            for item in self.source.rows:
                self.store.save(*identity, item, signal())
        self.store.advance(*identity, self.source.rows[-1]["_sort"], [], complete=True)
        batches = self.engine.store(self.store)
        for subject, count in (("", 2), ("one", 1), ("two", 1)):
            state = empty_state()
            state["count"] = count
            batches.seed(*identity, subject, state, self.source.rows[-1]["_sort"])
        self.store.clear_scope(identity[0], room, LOCAL_SOURCE_ID, subject="")
        reset = self.engine.ensure(*identity, self.store, (identity[0], "synthetic-workdir"))
        self.assertEqual(reset["state"]["count"], 0)
        self.assertIsNone(reset["cursor"])
        with patch("batch_engine.keyword_counts", return_value={}):
            list(self.engine.incremental(*identity, self.store, {}, (identity[0], "synthetic-workdir"), ()))
        self.assertEqual(batches.load(*identity, "")["state"]["count"], 2)
        self.assertEqual(batches.load(*identity, "one")["state"]["count"], 1)
        self.assertEqual(batches.load(*identity, "two")["state"]["count"], 1)
        self.store.clear_scope(identity[0], room, LOCAL_SOURCE_ID, subject="one")
        reset = self.engine.ensure(*identity, self.store, (identity[0], "synthetic-workdir"), "one")
        self.assertIsNone(reset["cursor"])
        self.assertEqual(reset["state"]["count"], 0)
        with patch("batch_engine.keyword_counts", return_value={}):
            list(self.engine.incremental(*identity, self.store, {}, (identity[0], "synthetic-workdir"), (), "one"))
        self.assertEqual(batches.load(*identity, "one")["state"]["count"], 1)
        self.assertEqual(batches.load(*identity, "two")["state"]["count"], 1)
        self.assertEqual(batches.load(*identity, "")["state"]["count"], 2)
        self.assertEqual(len(self.store.items(*identity)), 2)

    def test_api_portrait_reset_is_subject_and_source_scoped(self):
        room = "room@chatroom"
        source = "a" * 32 + ":portrait-v3"
        other_source = "b" * 32 + ":portrait-v3"
        highwater = (3, "message__message_0.db", 3)
        for account, user, source_id, subject in (
                (self.scope[0], room, source, room), (self.scope[0], room, source, "one"),
                (self.scope[0], room, other_source, room), ("other-account", room, source, room)):
            self.store.api_portrait_begin(account, user, source_id, subject, highwater, None,
                                          "fingerprint", {}, [])
        self.store.clear_scope(self.scope[0], room, source, subject=room)
        self.assertIsNone(self.store.api_portrait_get(self.scope[0], room, source, room))
        for account, source_id, subject in ((self.scope[0], source, "one"),
                                            (self.scope[0], other_source, room),
                                            ("other-account", source, room)):
            self.assertIsNotNone(self.store.api_portrait_get(account, room, source_id, subject))
        self.assertFalse(self.store.portrait_reset(self.scope[0], room, ""))
        with self.assertRaises(ValueError):
            self.store.clear_scope(self.scope[0], room, source, subject="")
        with self.assertRaises(ValueError):
            self.store.clear_scope(self.scope[0], room, LOCAL_SOURCE_ID, subject=room)

    def test_api_portrait_same_highwater_accepts_changed_missing_message_plan(self):
        source = "a" * 32 + ":portrait-v3"
        highwater = (3, "message__message_0.db", 3)
        self.store.api_portrait_begin(self.scope[0], "friend", source, "friend", highwater, None,
                                      "before", {}, [], local_rules=True)
        with self.store.connect() as conn:
            conn.execute("UPDATE api_portrait_v1 SET complete=1")
        changed = self.store.api_portrait_begin(self.scope[0], "friend", source, "friend", highwater, None,
                                                "after", {}, [1], local_rules=True)
        self.assertEqual(changed["fingerprint"], "after")
        self.assertEqual(changed["plan"], [1])
        self.assertFalse(changed["complete"])

    def test_empty_history_does_not_query_prefix_for_none_cursor(self):
        self.source.history_prefix_signature = lambda *_args: self.fail("empty cursor prefix requested")
        self.assertEqual(self.run_incremental()["state"]["count"], 0)


if __name__ == "__main__":
    unittest.main()
