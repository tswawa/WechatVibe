"""Snapshot-scoped read caches: contacts, Name2Id, and incremental portrait metadata.

Every fixture here is a synthetic SQLite file; no WeChat data or keys are involved.
"""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from wechat_source import WeChatSource

TABLE = "Msg_" + "a" * 32


class FakeDB:
    """Minimal reader surface used by `WeChatSource`'s read paths."""

    account = "synthetic-account"
    anchor_rels = {"contact": "contact.db"}
    messages_ready = True

    def __init__(self, root, message_path, contact_path):
        self.workdir = str(root)
        self.message_path = message_path
        self.contact_path = contact_path
        self.opens = 0

    @property
    def _db_files(self):
        return [("contact.db", str(self.contact_path), self.contact_path.stat().st_size),
                (os.path.join("message", "message_0.db"), str(self.message_path),
                 self.message_path.stat().st_size)]

    def _open(self, rel):
        self.opens += 1
        return sqlite3.connect(self.contact_path if Path(rel).name == "contact.db"
                               else self.message_path)

    def _msg_conns(self, _user):
        return [(sqlite3.connect(self.message_path), TABLE)]

    def _msg_type_name(self, local_type):
        return {1: "文本", 49: "引用"}.get(local_type, "其它")

    @staticmethod
    def _friendly_content(raw, _kind):
        return raw.decode("utf-8") if isinstance(raw, bytes) else raw


def build_source(root):
    message_path, contact_path = root / "message__message_0.db", root / "contact.db"
    conn = sqlite3.connect(message_path)
    conn.execute("CREATE TABLE Name2Id(rowid INTEGER PRIMARY KEY, user_name TEXT)")
    conn.execute("INSERT INTO Name2Id VALUES (2,'wxid_me'),(3,'wxid_friend')")
    conn.execute(f"CREATE TABLE {TABLE}(local_id INTEGER PRIMARY KEY, local_type INTEGER,"
                 " real_sender_id INTEGER, create_time INTEGER, message_content BLOB,"
                 " compress_content BLOB, server_id INTEGER, sort_seq INTEGER)")
    conn.execute(f"INSERT INTO {TABLE} VALUES (1,1,2,0,?,NULL,1,10)", ("你好".encode(),))
    conn.execute(f"INSERT INTO {TABLE} VALUES (2,1,3,0,?,NULL,2,20)", ("在吗".encode(),))
    conn.commit()
    conn.close()

    conn = sqlite3.connect(contact_path)
    conn.execute("CREATE TABLE contact(username TEXT, nick_name TEXT, remark TEXT,"
                 " small_head_url TEXT, big_head_url TEXT)")
    conn.execute("INSERT INTO contact VALUES('wxid_friend','朋友','','','')")
    conn.commit()
    conn.close()

    source = WeChatSource(factory=lambda **_kwargs: None)
    source.classifier = lambda _kind, content: ("text", content)
    return source, message_path


class ReadCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.message_path = build_source(self.root)
        self.db = FakeDB(self.root, self.message_path, self.root / "contact.db")
        self.source.db = self.db

    def test_contacts_are_read_once_per_snapshot(self):
        first = self.source._contacts(self.db)
        second = self.source._contacts(self.db)
        self.assertIs(first, second)
        self.assertEqual(self.db.opens, 1)

        # Replacing the snapshot (new mtime/size) must invalidate the cached table.
        self.root.joinpath("contact.db").write_bytes(self.root.joinpath("contact.db").read_bytes())
        os.utime(self.root / "contact.db", None)
        self.source._contacts(self.db)
        self.assertEqual(self.db.opens, 2)

    def test_sender_index_is_read_once_per_shard_snapshot(self):
        conn = sqlite3.connect(self.message_path)
        try:
            first = self.source._sender_index(self.db, conn, str(self.message_path))
            second = self.source._sender_index(self.db, conn, str(self.message_path))
        finally:
            conn.close()
        self.assertEqual(first, second)
        self.assertEqual(first[3], "wxid_friend")

    def test_new_message_updates_metadata_without_rescanning_history(self):
        full_scans = []
        original = self.source._metadata_counts_full

        def counting_full(db, found):
            full_scans.append(1)
            return original(db, found)

        self.source._metadata_counts_full = counting_full
        first = self.source.profile_metadata("wxid_friend")
        second = self.source.profile_metadata("wxid_friend")
        self.assertEqual((first["count"], second["count"]), (1, 1))

        conn = sqlite3.connect(self.message_path)
        conn.execute(f"INSERT INTO {TABLE} VALUES (3,1,3,0,?,NULL,3,30)", ("晚安".encode(),))
        conn.commit()
        conn.close()
        os.utime(self.message_path, None)

        third = self.source.profile_metadata("wxid_friend")
        self.assertEqual(third["count"], 2)
        self.assertEqual(third["textCount"], 2)
        self.assertEqual(len(full_scans), 1, "an append must be counted incrementally")

    def test_a_shrinking_shard_falls_back_to_a_full_scan(self):
        self.source.profile_metadata("wxid_friend")
        conn = sqlite3.connect(self.message_path)
        conn.execute(f"DELETE FROM {TABLE} WHERE local_id=2")
        conn.commit()
        conn.close()
        os.utime(self.message_path, None)
        after = self.source.profile_metadata("wxid_friend")
        self.assertEqual(after["count"], 0)


if __name__ == "__main__":
    unittest.main()
