"""A member portrait must be able to resume after another pass covered its cursor message.

`_member` reuses the saved cursor to finish a partially consumed background span. When another
pass (the reconciliation prefix scan or a recent window) completed that message in the meantime,
the durable cursor still held its partial offset while the message was no longer sent from it.
The commit then rejected the window - first as "batch cursor did not advance", then as
"unfinished message segment was skipped" - so the member portrait retried forever, burning one
model window per attempt, and only 重置画像 could clear it. The whole-group path resets its
cursor the same way and never had this problem.
"""

import hashlib
import json
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

from batch_engine import BatchEngine
from profile_state import empty_state
from result_store import ResultStore

ROOM = "room@chatroom"
ACCOUNT = "synthetic-account"
VERSION = "synthetic-version"
LONG = "".join(chr(ord("a") + index % 26) for index in range(40))


def message(number, sender, text=None):
    return {"id": f"m{number}", "_sort": (number, "message__message_0.db", number),
            "senderId": sender, "side": "other", "kind": "text",
            "text": text if text is not None else f"word {number}"}


class SyntheticSource:
    def __init__(self, rows):
        self.rows = rows

    def history_highwater(self, user):
        return max((row["_sort"] for row in self.rows), default=None)

    def history_revision(self, user):
        return hashlib.sha256(json.dumps([row["id"] for row in self.rows]).encode()).hexdigest()

    def history_prefix_signature(self, user, ceiling):
        ids = sorted(row["id"] for row in self.rows
                     if ceiling is not None and row["_sort"] <= ceiling)
        return hashlib.sha256(json.dumps(ids).encode()).hexdigest()

    def history_page(self, user, ceiling, after=None):
        rows = sorted((row for row in self.rows if row["_sort"] <= ceiling and
                       (after is None or row["_sort"] > after)), key=lambda row: row["_sort"])[:256]
        return rows, rows[-1]["_sort"] if rows else None


def signal(label="happy", score=.5):
    return {"score": score, "emotion": [{"label": label, "rawLabel": label, "probability": 1}],
            "intent": [], "intentBroad": []}


class WindowAnalyzer:
    """One model window of 20 codepoints, exactly like the packed batch window."""

    def __init__(self, window=20):
        self.window = window
        self.calls = []

    def analyze_batch(self, scope, payload, context):
        budget = self.window
        consumed = []
        for row in payload:
            remaining = len(row["text"]) - row["offset"]
            if remaining <= budget:
                consumed.append({"start": row["offset"], "end": len(row["text"]), "complete": True})
                budget -= remaining
            else:
                if budget:
                    consumed.append({"start": row["offset"], "end": row["offset"] + budget,
                                     "complete": False})
                break
            if not budget:
                break
        self.calls.append({"consumed": [(row["id"], piece["start"], piece["end"], piece["complete"])
                                        for row, piece in zip(payload, consumed)],
                           "targets": [row["id"] for row in payload if row["target"]]})
        covered = {row["id"] for row, piece in zip(payload, consumed) if piece["complete"]}
        targets = [row["id"] for row in payload if row["target"] and row["id"] in covered]
        return {"consumed": consumed, "result": signal() if targets else None}


def backend_for(source, analyzer):
    return SimpleNamespace(source=source, analyzer=analyzer,
                           jobs_lock=threading.RLock(), performance={},
                           _assert_scope=lambda scope: None,
                           _take_recent_priority=lambda key: None,
                           _scope_commit=lambda scope: nullcontext(),
                           _legacy_profile_state=lambda *args: empty_state())


class MemberPortraitResumeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="batch member resume ")
        self.addCleanup(self.temporary.cleanup)
        self.store = ResultStore(Path(self.temporary.name) / "synthetic.sqlite3")
        self.rows = [message(1, "one", LONG), message(2, "one", "ghijkl"),
                     message(3, "one", "mnopqr")]
        self.source = SyntheticSource(self.rows)
        self.analyzer = WindowAnalyzer()
        self.engine = BatchEngine(backend_for(self.source, self.analyzer))
        self.scope = (ACCOUNT, ROOM, VERSION)

    def interrupted_turn(self, member):
        """Run one window, then drop the job the way a restart or a cancelled run does."""
        iterator = self.engine.incremental(*self.scope, self.store, {},
                                           (ACCOUNT, "synthetic-workdir"), (), member)
        next(iterator)
        iterator.close()
        return self.engine.snapshot(*self.scope, self.store, member)

    def next_turn(self, member):
        engine = BatchEngine(backend_for(self.source, self.analyzer))
        list(engine.incremental(*self.scope, self.store, {}, (ACCOUNT, "synthetic-workdir"), (),
                                member))
        return engine.snapshot(*self.scope, self.store, member)

    def test_a_covered_cursor_message_no_longer_blocks_a_member_portrait(self):
        saved = self.interrupted_turn("one")
        self.assertEqual(saved["cursor"], (1, "message__message_0.db", 1))
        self.assertEqual(saved["charOffset"], 20)
        self.assertEqual(saved["state"]["count"], 0)

        for attempt in ("first", "second"):
            with self.subTest(attempt=attempt):
                saved = self.next_turn("one")
                self.assertEqual(saved["state"]["count"], 3, attempt)
                self.assertTrue(saved["complete"], attempt)

        # The model still sees exactly the windows it saw before the fix: the repair is bookkeeping.
        self.assertEqual(self.analyzer.calls, [
            {"consumed": [("m1", 0, 20, False)], "targets": ["m1", "m2", "m3"]},
            {"consumed": [("m1", 20, 40, True)], "targets": ["m1"]},
            {"consumed": [("m2", 0, 6, True), ("m3", 0, 6, True)], "targets": ["m2", "m3"]},
        ])

    def test_the_whole_group_path_resumes_the_same_way(self):
        self.interrupted_turn(None)
        saved = self.next_turn(None)
        self.assertEqual(saved["state"]["count"], 3)
        self.assertTrue(saved["complete"])


if __name__ == "__main__":
    unittest.main()
