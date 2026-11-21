"""Reasoning text is sealed in the result store and only decrypted on read."""
import os
import tempfile
import unittest

from payload_crypto import PayloadCipher, PayloadUnreadable
from result_store import MAX_REASONING_CHARS, ResultStore


class ReasoningStorageTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.key = bytes(range(32))
        self.store = ResultStore(os.path.join(self.directory.name, "results.sqlite3"),
                                 cipher=PayloadCipher(key=self.key))

    def test_roundtrip_is_sealed_at_rest(self):
        text = "先看看对方的语气，再判断是不是拒绝。"
        self.store.save_api_reasoning("acct", "session", "source1", text)
        self.assertEqual(self.store.api_reasoning("acct", "session", "source1"), text)
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.directory.name, "results.sqlite3"))
        try:
            raw = conn.execute("SELECT payload FROM api_reasoning_v1 WHERE account=? AND session=? AND source_id=?",
                               ("acct", "session", "source1")).fetchone()[0]
        finally:
            conn.close()
        self.assertTrue(raw.startswith("wv1:"), "reasoning must be sealed before disk")
        self.assertNotIn("拒绝", raw)
        self.assertNotIn(text, raw)

    def test_replacing_batch_replaces_reasoning(self):
        self.store.save_api_reasoning("acct", "session", "source1", "first thinking")
        self.store.save_api_reasoning("acct", "session", "source1", "second thinking")
        self.assertEqual(self.store.api_reasoning("acct", "session", "source1"), "second thinking")

    def test_empty_reasoning_is_not_written(self):
        self.store.save_api_reasoning("acct", "session", "source1", "   ")
        self.assertEqual(self.store.api_reasoning("acct", "session", "source1"), "")

    def test_reasoning_is_capped(self):
        self.store.save_api_reasoning("acct", "session", "source1", "字" * (MAX_REASONING_CHARS + 500))
        self.assertEqual(len(self.store.api_reasoning("acct", "session", "source1")), MAX_REASONING_CHARS)

    def test_damaged_ciphertext_raises_instead_of_returning_plaintext(self):
        self.store.save_api_reasoning("acct", "session", "source1", "secret thinking")
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.directory.name, "results.sqlite3"))
        try:
            conn.execute("UPDATE api_reasoning_v1 SET payload=?", ("wv1:damaged",))
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(PayloadUnreadable):
            self.store.api_reasoning("acct", "session", "source1")


if __name__ == "__main__":
    unittest.main()
