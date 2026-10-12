"""A cursor whose message vanished from the history must say what to do.

`commit` rejects a window that skips an unfinished segment, which is right while that text is still
readable. When the cursor message was withdrawn (or its shard moved) between two passes, the rest of
its text can never be read again, so every later pass failed the same way with an opaque message and
the portrait stayed stuck until the user reset it by hand. The rejection now names the cause and the
recovery. The repair itself (moving that cursor past a message that is provably gone) needs a
maintainer decision, because it touches the guard that protects unfinished segments.
"""

import hashlib
import json
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import batch_state
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
        self.calls.append([row["id"] for row in payload])
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


class VanishedCursorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="batch vanished cursor ")
        self.addCleanup(temporary.cleanup)
        self.store = ResultStore(Path(temporary.name) / "synthetic.sqlite3")
        self.rows = [message(1, "one", LONG), message(2, "one", "ghijkl"),
                     message(3, "one", "mnopqr")]
        self.source = SyntheticSource(self.rows)
        self.analyzer = WindowAnalyzer()
        self.scope = (ACCOUNT, ROOM, VERSION)
        self.engine = BatchEngine(backend_for(self.source, self.analyzer))

    def turn(self, member=None):
        engine = BatchEngine(backend_for(self.source, self.analyzer))
        return engine.incremental(*self.scope, self.store, {}, (ACCOUNT, "synthetic-workdir"), (),
                                  member)

    def interrupted_turn(self):
        iterator = self.turn()
        next(iterator)
        iterator.close()
        return self.engine.snapshot(*self.scope, self.store, None)

    def test_a_vanished_cursor_names_the_cause_and_the_recovery(self):
        saved = self.interrupted_turn()
        self.assertEqual(saved["charOffset"], 20)
        # The half-read message disappears (withdrawn in WeChat) and a newer one arrives.
        self.source.rows = [message(2, "one", "ghijkl"), message(3, "one", "mnopqr"),
                            message(4, "one", "stuvwx")]
        for attempt in ("first", "second"):
            with self.subTest(attempt=attempt):
                with self.assertRaises(ValueError) as caught:
                    list(self.turn())
                self.assertIn("not in this window", str(caught.exception))
                self.assertIn("reset this portrait", str(caught.exception))

    def test_a_still_readable_cursor_never_reports_a_vanished_one(self):
        """The extra wording only applies when the cursor message is missing from the window."""
        self.interrupted_turn()
        try:
            list(self.turn(member="one"))
        except ValueError as error:
            self.assertNotIn("not in this window", str(error))


if __name__ == "__main__":
    unittest.main()
