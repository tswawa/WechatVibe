import base64
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from payload_crypto import ENVELOPE, KEY_BYTES, PayloadCipher, PayloadUnreadable


class PayloadCipherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.key_path = self.root / "analysis-key.bin"

    def cipher(self, **kwargs):
        return PayloadCipher(self.key_path, **kwargs)

    def test_round_trip_keeps_the_value(self):
        cipher = self.cipher()
        payload = {"text": "周末一起去看电影吗？", "side": "other"}
        self.assertEqual(cipher.loads(cipher.dumps(payload)), payload)

    def test_stored_form_is_an_envelope_and_never_contains_the_text(self):
        cipher = self.cipher()
        secret = "这是一句不该以明文落盘的聊天原文"
        stored = cipher.dumps({"text": secret})
        self.assertTrue(stored.startswith(ENVELOPE))
        self.assertNotIn(secret, stored)
        self.assertGreater(len(base64.b64decode(stored[len(ENVELOPE):])), 12)

    def test_the_same_text_encrypts_differently_every_time(self):
        # A fresh nonce per write, so equal payloads are not recognisable by repetition.
        cipher = self.cipher()
        first = cipher.dumps({"text": "一样的话"})
        second = cipher.dumps({"text": "一样的话"})
        self.assertNotEqual(first, second)
        self.assertEqual(cipher.loads(first), cipher.loads(second))

    def test_legacy_plaintext_rows_still_read(self):
        cipher = self.cipher()
        legacy = json.dumps({"text": "旧版本明文"}, ensure_ascii=False)
        self.assertEqual(cipher.loads(legacy), {"text": "旧版本明文"})
        self.assertEqual(cipher.unprotect(legacy), legacy)

    def test_empty_and_null_read_as_nothing(self):
        cipher = self.cipher()
        self.assertIsNone(cipher.loads(""))
        self.assertIsNone(cipher.loads(None))

    def test_another_key_cannot_read_it(self):
        stored = self.cipher().dumps({"text": "私密"})
        other = PayloadCipher(self.root / "other-key.bin")
        with self.assertRaises(PayloadUnreadable):
            other.unprotect(stored)

    def test_an_edited_payload_is_rejected(self):
        cipher = self.cipher()
        stored = cipher.dumps({"text": "私密"})
        blob = bytearray(base64.b64decode(stored[len(ENVELOPE):]))
        blob[-1] ^= 0x01
        with self.assertRaises(PayloadUnreadable):
            cipher.unprotect(ENVELOPE + base64.b64encode(bytes(blob)).decode("ascii"))

    def test_a_truncated_or_corrupt_envelope_is_rejected(self):
        cipher = self.cipher()
        with self.assertRaises(PayloadUnreadable):
            cipher.unprotect(ENVELOPE + base64.b64encode(b"short").decode("ascii"))
        with self.assertRaises(PayloadUnreadable):
            cipher.unprotect(ENVELOPE + "not base64!!")

    def test_the_key_survives_a_new_instance_and_stays_protected_at_rest(self):
        stored = self.cipher().dumps({"text": "跨进程"})
        blob = self.key_path.read_bytes()
        self.assertNotEqual(base64.b64decode(blob), b"\x00" * KEY_BYTES)
        self.assertEqual(PayloadCipher(self.key_path).loads(stored), {"text": "跨进程"})

    def test_a_corrupt_key_file_is_reported(self):
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        self.key_path.write_bytes(base64.b64encode(b"too short"))
        with self.assertRaises(PayloadUnreadable):
            self.cipher().protect("私密")

    def test_injected_key_protection_avoids_dpapi(self):
        # Tests must not depend on the machine's DPAPI, so the transform takes a key.
        cipher = self.cipher(protect=lambda value: value, unprotect=lambda value: value,
                             key=b"k" * KEY_BYTES)
        self.assertEqual(cipher.loads(cipher.dumps({"a": 1})), {"a": 1})

    def test_rejects_non_string_payloads(self):
        cipher = self.cipher()
        with self.assertRaises(TypeError):
            cipher.protect(b"bytes")
        with self.assertRaises(TypeError):
            cipher.unprotect(None)

class StorePayloadsAreEncryptedTests(unittest.TestCase):
    """The raw-text columns must not hold readable chat text after a write."""

    def setUp(self):
        import payload_crypto

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # A fixed key keeps these assertions independent of the machine's DPAPI.
        cipher = PayloadCipher(key=b"k" * KEY_BYTES)
        payload_crypto._default_cipher = cipher
        self.addCleanup(setattr, payload_crypto, "_default_cipher", None)

        from batch_state import BatchStateStore
        from result_store import ResultStore

        self.store = ResultStore(self.root / "synthetic.sqlite3")
        self.batch = BatchStateStore(self.store)

    def raw(self, sql, args=()):
        with closing(sqlite3.connect(self.root / "synthetic.sqlite3")) as conn:
            return conn.execute(sql, args).fetchone()[0]

    def test_progress_context_is_encrypted(self):
        secret = "这是一句会进上下文窗口的原文"
        self.store.advance("acct", "user", "v1", (1, 0, 0), [{"id": "m1", "text": secret}])
        stored = self.raw("SELECT context_json FROM progress_v1 WHERE account=? AND session=?",
                          ("acct", "user"))
        self.assertTrue(stored.startswith(ENVELOPE))
        self.assertNotIn(secret, stored)
        # It still reads back through the store.
        self.assertEqual(self.store.progress("acct", "user", "v1")["context"][0]["text"], secret)

    def test_batch_context_is_encrypted(self):
        secret = "打包路径写入的上下文原文"
        # seed(account, session, base_version, subject, state, cursor, context)
        self.batch.seed("acct", "user", "v1", "self", None, None, [{"id": "m1", "text": secret}])
        stored = self.raw("SELECT context_json FROM batch_progress_v1 WHERE account=? AND session=?",
                          ("acct", "user"))
        self.assertTrue(stored.startswith(ENVELOPE))
        self.assertNotIn(secret, stored)
        loaded = self.batch.load("acct", "user", "v1", "self")
        self.assertEqual(loaded["context"][0]["text"], secret)

    def test_sql_ordering_still_works_on_a_table_with_an_encrypted_payload(self):
        # The cursor stays a plaintext integer next to the ciphertext, so resume and paging
        # keep working. progress_v1 holds one row per conversation, so order across two.
        for seq, user in ((2, "user-a"), (1, "user-b")):
            self.store.advance("acct", user, "v1", (seq, 0, 0),
                               [{"id": "m1", "text": f"{user} 的原文"}])
        with closing(sqlite3.connect(self.root / "synthetic.sqlite3")) as conn:
            rows = conn.execute(
                "SELECT session,cursor_seq,context_json FROM progress_v1 WHERE account=? "
                "ORDER BY cursor_seq DESC", ("acct",)).fetchall()
        self.assertEqual([(row[0], row[1]) for row in rows], [("user-a", 2), ("user-b", 1)])
        self.assertTrue(all(row[2].startswith(ENVELOPE) for row in rows))
        # The cursor comparison is plain SQL on an unencrypted column.
        self.assertEqual(self.store.progress("acct", "user-b", "v1")["cursor"][0], 1)
        # A scan refuses to move backwards, which is what an interrupted resume relies on.
        self.store.advance("acct", "user-a", "v1", (1, 0, 0), [{"id": "m0", "text": "更早"}])
        self.assertEqual(self.store.progress("acct", "user-a", "v1")["cursor"][0], 2)


if __name__ == "__main__":
    unittest.main()