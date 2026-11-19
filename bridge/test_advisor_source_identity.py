"""Advisor identity leases over trusted synthetic readers; no WeChat data or keys."""
import threading
import time
import sqlite3
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend_contracts import AccountUnavailableError, MessagesUnavailableError
from wechat_source import WeChatSource


class AdvisorSourceIdentityTests(unittest.TestCase):
    def source(self):
        source = WeChatSource(factory=lambda **_kwargs: None)
        source.live_account = True
        reader = SimpleNamespace(account="synthetic-account", workdir="C:/synthetic-owned-cache", messages_ready=True)
        source.db = reader
        calls = []

        def trusted_db(fresh=False):
            self.assertTrue(fresh)
            calls.append(fresh)
            return source.db

        source._db = trusted_db
        return source, reader, calls

    def test_first_advisor_lookup_uses_the_original_fresh_verification(self):
        source, reader, calls = self.source()
        result = source.advisor_identity()
        self.assertEqual(result, (reader.account, Path(reader.workdir).resolve()))
        self.assertEqual(calls, [True])
        self.assertEqual(source.advisor_identity(), result)
        self.assertEqual(calls, [True])

    def test_verified_chat_identity_refreshes_a_lease_without_holding_source_lock(self):
        source, reader, calls = self.source()
        expected = source.verified_identity(messages=True)
        held, release = threading.Event(), threading.Event()

        def hold_source():
            with source.lock:
                held.set()
                release.wait(2)

        thread = threading.Thread(target=hold_source)
        thread.start()
        try:
            self.assertTrue(held.wait(1))
            source._db = lambda **_kwargs: self.fail("warm Advisor lease called the blocked reader")
            started = time.monotonic()
            self.assertEqual(source.advisor_identity(), expected)
            self.assertLess(time.monotonic() - started, 0.1)
        finally:
            release.set()
            thread.join(2)
        self.assertEqual(calls, [True])

    def test_expired_lease_reverifies_and_observes_account_switch(self):
        source, reader, calls = self.source()
        with patch("wechat_source.time.monotonic", return_value=100.0):
            source.verified_identity(messages=True)
        generation = source.advisor_binding_generation
        reader.account = "synthetic-other-account"
        with patch("wechat_source.time.monotonic", return_value=102.01):
            self.assertEqual(source.advisor_identity()[0], reader.account)
        self.assertEqual(calls, [True, True])
        self.assertGreater(source.advisor_binding_generation, generation)

    def test_reader_replacement_and_explicit_invalidation_cannot_reuse_old_binding(self):
        source, reader, calls = self.source()
        source.verified_identity(messages=True)
        source.db = SimpleNamespace(account="replacement", workdir="C:/synthetic-new-cache", messages_ready=True)
        self.assertEqual(source.advisor_identity()[0], "replacement")
        generation = source.advisor_binding_generation
        source.invalidate_advisor_identity()
        self.assertGreater(source.advisor_binding_generation, generation)
        self.assertEqual(source.advisor_identity()[0], "replacement")
        self.assertEqual(len(calls), 3)

    def test_fresh_failure_and_readiness_change_invalidate_the_warm_lease(self):
        source, reader, calls = self.source()
        source.verified_identity(messages=True)
        reader.messages_ready = False
        with self.assertRaises(MessagesUnavailableError):
            source.advisor_identity()
        self.assertIsNone(source._advisor_binding)
        reader.messages_ready = True
        source.verified_identity(messages=True)
        source._db = lambda **_kwargs: (_ for _ in ()).throw(AccountUnavailableError())
        with self.assertRaises(AccountUnavailableError):
            source.verified_identity(messages=True)
        self.assertIsNone(source._advisor_binding)

    def test_default_verified_identity_is_still_fresh_for_every_call(self):
        source, reader, calls = self.source()
        source.verified_identity()
        source.verified_identity(messages=True)
        source.identity()
        self.assertEqual(calls, [True, True, True])

    def test_request_scope_reuses_one_strong_check_and_never_leaks_across_requests(self):
        source, reader, calls = self.source()
        with source.request_scope():
            first = source.verified_identity(messages=True)
            self.assertEqual(source.verified_identity(), first)
            self.assertEqual(source.identity(), first)
        self.assertEqual(calls, [True])
        # A second request must verify again, never inherit the previous answer.
        with source.request_scope():
            source.verified_identity(messages=True)
        self.assertEqual(calls, [True, True])

    def test_request_scope_drops_the_answer_when_the_binding_is_invalidated(self):
        source, reader, calls = self.source()
        with source.request_scope():
            source.verified_identity(messages=True)
            source.invalidate_binding()
            source.verified_identity(messages=True)
        self.assertEqual(calls, [True, True])

    def test_release_forget_and_close_block_stale_advisor_bindings(self):
        for operation in ("release", "forget", "close"):
            with self.subTest(operation=operation):
                source, reader, calls = self.source()
                source.verified_identity(messages=True)
                generation = source.advisor_binding_generation
                if operation == "release":
                    source._release_db()
                elif operation == "forget":
                    source.forget_account(reader.account)
                else:
                    source.close()
                self.assertIsNone(source._advisor_binding)
                self.assertGreater(source.advisor_binding_generation, generation)
                if operation == "close":
                    with self.assertRaises(AccountUnavailableError):
                        source.advisor_identity()

    def test_parallel_expired_advisor_requests_share_one_fresh_check(self):
        source, reader, calls = self.source()
        source.verified_identity(messages=True)
        source.invalidate_advisor_identity()
        entered, release = threading.Event(), threading.Event()
        original = source._db

        def slow(fresh=False):
            entered.set()
            release.wait(2)
            return original(fresh=fresh)

        source._db = slow
        results = []
        threads = [threading.Thread(target=lambda: results.append(source.advisor_identity())) for _ in range(5)]
        for thread in threads:
            thread.start()
        try:
            self.assertTrue(entered.wait(1))
        finally:
            release.set()
            for thread in threads:
                thread.join(2)
        self.assertEqual(len(results), 5)
        self.assertEqual(len(calls), 2)

    def test_ordinary_reader_opt_in_never_leaks_into_verified_identity(self):
        with patch("live_source.active_account_snapshot") as locator:
            source = WeChatSource()
            source._active_selection(fresh=False)
            locator.assert_called_once_with(fresh=False)
            locator.reset_mock()
            source._active_selection()
            locator.assert_called_once_with(fresh=True)
        reader = SimpleNamespace(account="synthetic-account", workdir="C:/synthetic-cache", messages_ready=True)
        source.db = reader
        with patch.object(source, "_db", return_value=reader) as read:
            source._ordinary_db()
            read.assert_called_once_with(fresh=True, reuse_ownership=True)
            read.reset_mock()
            source.verified_identity(messages=True)
            read.assert_called_once_with(fresh=True)

    def test_expired_advisor_lease_restarts_from_strong_check_not_ownership_cache(self):
        source, reader, calls = self.source()
        import live_source
        with patch("live_source.file_owners", return_value=((42, 10.0),)):
            live_source._owned_processes(["synthetic-account.db"], fresh=False)
        live_source.reset_ownership_cache()
        with patch("wechat_source.time.monotonic", return_value=10):
            source.verified_identity(messages=True)
        with patch("wechat_source.time.monotonic", return_value=12.01):
            source.advisor_identity()
        self.assertEqual(calls, [True, True])


class HistoryRevisionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.table = "Msg_" + "a" * 32
        self.shards = []
        db_files = []
        for index in (0, 1):
            rel = "message/message_%d.db" % index
            source_path = self.root / "db_storage" / rel
            source_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.write_bytes(b"synthetic encrypted sentinel")
            destination = self.cache / ("message__message_%d.db" % index)
            with closing(sqlite3.connect(destination)) as connection, connection:
                connection.execute("CREATE TABLE " + self.table + "(local_id INTEGER,sort_seq INTEGER,message_content TEXT)")
                connection.execute("INSERT INTO " + self.table + " VALUES(?,?,?)", (1, 10, "synthetic unread text"))
            self.shards.append(destination)
            db_files.append((rel.replace("/", os.sep), str(source_path), source_path.stat().st_size))
        db = SimpleNamespace(account="synthetic-account", workdir=str(self.cache), account_dir=str(self.root),
                             _db_files=db_files, _msg_conns=lambda _user: [(sqlite3.connect(path), self.table) for path in self.shards])
        self.source = WeChatSource(factory=lambda: db)
        self.source.db = db

    def test_metadata_revision_is_stable_and_changes_for_source_wal_and_snapshot(self):
        before = self.source.history_revision("friend")
        self.assertEqual(before, self.source.history_revision("friend"))
        source_file = Path(self.source.db._db_files[0][1])
        Path(str(source_file) + "-wal").write_bytes(b"synthetic wal marker")
        with_wal = self.source.history_revision("friend")
        self.assertNotEqual(before, with_wal)
        with self.shards[0].open("ab") as stream:
            stream.write(b"synthetic changed snapshot")
        self.assertNotEqual(with_wal, self.source.history_revision("friend"))
        self.assertNotEqual(before, self.source.history_revision("other-friend"))

    def test_prefix_aggregates_ignore_new_tail_but_detect_older_inserts(self):
        ceiling = (10, "message__message_1.db", 1)
        before = self.source.history_prefix_signature("friend", ceiling)
        with closing(sqlite3.connect(self.shards[1])) as connection, connection:
            connection.execute("INSERT INTO " + self.table + " VALUES(?,?,?)", (2, 11, "new synthetic tail"))
        self.assertEqual(before, self.source.history_prefix_signature("friend", ceiling))
        with closing(sqlite3.connect(self.shards[0])) as connection, connection:
            connection.execute("INSERT INTO " + self.table + " VALUES(?,?,?)", (2, 5, "late synthetic old record"))
        self.assertNotEqual(before, self.source.history_prefix_signature("friend", ceiling))

    def test_equal_sort_seq_uses_same_cross_shard_ceiling_as_history_reader(self):
        ceiling = (10, "message__message_0.db", 1)
        before = self.source.history_prefix_signature("friend", ceiling)
        with closing(sqlite3.connect(self.shards[1])) as connection, connection:
            connection.execute("INSERT INTO " + self.table + " VALUES(?,?,?)", (2, 10, "same seq excluded later shard"))
        self.assertEqual(before, self.source.history_prefix_signature("friend", ceiling))
        with closing(sqlite3.connect(self.shards[1])) as connection, connection:
            connection.execute("INSERT INTO " + self.table + " VALUES(?,?,?)", (3, 9, "lower seq included later shard"))
        self.assertNotEqual(before, self.source.history_prefix_signature("friend", ceiling))

    def test_prefix_signature_reads_only_numeric_columns(self):
        seen = []
        def connections(_user):
            result = []
            for path in self.shards:
                connection = sqlite3.connect(path)
                connection.set_trace_callback(seen.append)
                result.append((connection, self.table))
            return result
        self.source.db._msg_conns = connections
        signature = self.source.history_prefix_signature("friend", (10, "message__message_1.db", 1))
        self.assertEqual(len(signature), 64)
        self.assertTrue(any("COUNT(*)" in query for query in seen))
        self.assertFalse(any("message_content" in query for query in seen))


if __name__ == "__main__":
    unittest.main()
