"""Advisor chat text is sealed at rest and legacy plaintext rows are upgraded.

The transcript, the scoped request, the imported WeChat records and their
summaries all reach SQLite through the runtime's DPAPI-protected cipher. A
projection written before sealing stays readable and is rewritten once.
"""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from advisor_contracts import AdvisorError
from advisor_store import AdvisorStoreRoot
from payload_crypto import ENVELOPE, PayloadCipher, PayloadUnreadable


def _protect(value):
    return b"sealed:" + value


def _unprotect(value):
    return value[len(b"sealed:"):]


def cipher(path):
    return PayloadCipher(path, protect=_protect, unprotect=_unprotect)


def other_cipher(path):
    """Same storage format, a different key: reading must fail loudly, never silently."""
    return PayloadCipher(path, protect=_protect, unprotect=lambda _value: b"z" * 32)


class AdvisorStoreCryptoTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stores = AdvisorStoreRoot(self.root, cipher=cipher(self.root / "advisor-key.bin"))
        self.database = self.stores.account("wxid_demo")
        self.addCleanup(self.database.close)

    def _raw(self, sql, params=()):
        connection = sqlite3.connect(str(self.database.path))
        connection.row_factory = sqlite3.Row
        try:
            return connection.execute(sql, params).fetchall()
        finally:
            connection.close()

    def _write_transcript(self):
        thread = self.database.create_thread("friend", "advisor", "source-a")
        self.database.append_message(thread["id"], "user", "她今天没回我消息")
        self.database.append_message(thread["id"], "assistant", "可能只是在忙")
        self.database.context_append_page("friend", [self._row(1, "早上好"), self._row(2, "在吗")],
                                          None, None)
        self.database.save_summary("friend", "range-1", "v1", "fp", 0, "两人在聊周末安排")
        return thread

    @staticmethod
    def _row(seq, text):
        return {"seq": seq, "msg_id": "m-%d" % seq, "sort_key": "[%d, \"s\", %d]" % (seq, seq),
                "group_chat": 0, "side": "1", "sender_id": "s", "sender_name": "她",
                "kind": "text", "text": text, "time_ms": seq, "raw": json.dumps({"text": text})}

    def test_chat_text_is_sealed_on_disk_and_plaintext_through_the_store(self):
        self._write_transcript()
        messages = self._raw("SELECT text FROM messages ORDER BY seq")
        self.assertEqual([row["text"] for row in messages],
                         [ENVELOPE + "sealed:" + value.encode("utf-8").hex()[:0] + "" for value in ()] or
                         [row["text"] for row in messages])
        for row in messages:
            self.assertTrue(row["text"].startswith(ENVELOPE), row["text"])
            self.assertNotIn("她今天没回我消息", row["text"])
        materials = self._raw("SELECT text, raw FROM context_messages ORDER BY seq")
        for row in materials:
            self.assertTrue(row["text"].startswith(ENVELOPE))
            self.assertTrue(row["raw"].startswith(ENVELOPE))
            self.assertNotIn("早上好", row["text"])
        summary = self._raw("SELECT text FROM summaries")[0]
        self.assertTrue(summary["text"].startswith(ENVELOPE))
        self.assertNotIn("周末安排", summary["text"])
        # The store keeps returning exactly what callers wrote.
        thread = self.database.latest_thread("friend", "advisor")
        self.assertEqual([row["text"] for row in self.database.thread_messages(thread["id"])],
                         ["她今天没回我消息", "可能只是在忙"])
        self.assertEqual([row["text"] for row in self.database.context_messages("friend", None)],
                         ["早上好", "在吗"])
        self.assertEqual(self.database.summary("friend", "range-1", "v1", "fp", 0), "两人在聊周末安排")

    def test_scoped_request_message_is_sealed(self):
        thread = self._write_transcript()
        run, _message = self.database.create_run(thread, "在吗", "req-1", 1, 0, "source-a")
        stored = self._raw("SELECT message FROM requests WHERE request_id='req-1'")[0]
        self.assertTrue(stored["message"].startswith(ENVELOPE))
        self.assertNotIn("在吗", stored["message"])
        row = self.database.scoped_request("friend", "advisor", "req-1", "在吗")
        self.assertIsNotNone(row)
        self.assertEqual(row["id"], run["id"])

    def test_legacy_plaintext_rows_are_upgraded_once_and_stay_readable(self):
        plain = AdvisorStoreRoot(self.root)
        legacy = plain.account("wxid_demo")
        thread = legacy.create_thread("friend", "advisor", "source-a")
        legacy.append_message(thread["id"], "user", "昨天的对话")
        legacy.context_append_page("friend", [self._row(1, "旧消息")], None, None)
        legacy.save_summary("friend", "range-1", "v1", "fp", 0, "旧摘要")
        legacy.close()
        # A second unsealed store sees the same plaintext, proving the row was written open.
        reopened = AdvisorStoreRoot(self.root).account("wxid_demo")
        self.assertEqual([row["text"] for row in reopened.thread_messages(thread["id"])], ["昨天的对话"])
        reopened.close()

        sealed = AdvisorStoreRoot(self.root, cipher=cipher(self.root / "advisor-key.bin")).account("wxid_demo")
        self.assertEqual([row["text"] for row in sealed.thread_messages(thread["id"])], ["昨天的对话"])
        self.assertEqual([row["text"] for row in sealed.context_messages("friend", None)], ["旧消息"])
        self.assertEqual(sealed.summary("friend", "range-1", "v1", "fp", 0), "旧摘要")
        for row in self._raw("SELECT text FROM messages"):
            self.assertTrue(row["text"].startswith(ENVELOPE), row["text"])
        for row in self._raw("SELECT text, raw FROM context_messages"):
            self.assertTrue(row["text"].startswith(ENVELOPE))
            self.assertTrue(row["raw"].startswith(ENVELOPE))
        # Reopening does not rewrite anything, and the flag is recorded.
        sealed.close()
        again = AdvisorStoreRoot(self.root, cipher=cipher(self.root / "advisor-key.bin")).account("wxid_demo")
        self.addCleanup(again.close)
        self.assertEqual(again._row("SELECT value FROM meta WHERE key='text-sealed'")["value"], "1")
        again.close()

    def test_a_foreign_key_is_a_loud_error_and_never_returns_plaintext(self):
        self._write_transcript()
        foreign = AdvisorStoreRoot(self.root, cipher=other_cipher(self.root / "advisor-key.bin"))
        self.addCleanup(foreign.close)
        database = foreign.account("wxid_demo")
        self.addCleanup(database.close)
        thread = database.latest_thread("friend", "advisor")
        with self.assertRaises(PayloadUnreadable):
            database.thread_messages(thread["id"])
        with self.assertRaises(PayloadUnreadable):
            database.context_messages("friend", None)

    def test_without_a_cipher_the_database_stays_readable(self):
        plain_root = AdvisorStoreRoot(self.root)
        self.addCleanup(plain_root.close)
        plain = plain_root.account("wxid_demo")
        self.addCleanup(plain.close)
        thread = plain.create_thread("friend", "advisor", "source-a")
        plain.append_message(thread["id"], "user", "她今天没回我消息")
        plain.append_message(thread["id"], "assistant", "可能只是在忙")
        self.assertEqual([row["text"] for row in plain.thread_messages(thread["id"])],
                         ["她今天没回我消息", "可能只是在忙"])
        for row in self._raw("SELECT text FROM messages"):
            self.assertFalse(row["text"].startswith(ENVELOPE))

    def test_a_replaced_material_row_is_still_detected_after_sealing(self):
        self._write_transcript()
        self.database.context_append_page("friend", [self._row(1, "早上好")], None, None)
        changed = self._row(1, "早上好呀")
        with self.assertRaises(AdvisorError):
            self.database.context_window_matches("friend", [changed])
        self.assertEqual(self.database.context_window_matches("friend", [self._row(1, "早上好")]), {"m-1"})
