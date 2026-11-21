"""Build a fixture message shard and record SqliteShard's answers — the golden set.

The Rust port (`rust/wr-query-rs`) replays the same ops against the same image and its output is
compared line by line with `expected.json`.

Usage:  python tools/build-golden.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(CRATE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

import zstandard  # noqa: E402
from wr import database as db  # noqa: E402

DATA = os.path.join(CRATE, "testdata")
ACCOUNT = "wxid_self_account"
SHARD_ID = "shard-1"
SELF = "wxid_me"
IMAGE_PATH = os.path.join(DATA, "msg.db")

CONTACTS = ["wxid_a", "wxid_b", "wxid_c"]
ZSTD = zstandard.ZstdCompressor()


def build_image() -> bytes:
    """A realistic message shard: Name2Id + one Msg_<md5> table."""
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, "build.db")
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE Name2Id (id INTEGER PRIMARY KEY, user_name TEXT)")
    rows = [(1, SELF), (2, "wxid_a"), (3, "wxid_b"), (4, "wxid_c"), (5, None)]
    conn.executemany("INSERT INTO Name2Id VALUES (?, ?)", rows)

    for username, base in (("wxid_a", 100), ("wxid_b", 200)):
        table = f"Msg_{db.md5_username(username)}"
        conn.execute(
            f'CREATE TABLE "{table}" (local_id INTEGER, server_id INTEGER, sort_seq INTEGER, '
            "local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, "
            "message_content TEXT, compress_content BLOB)"
        )
        records = []
        for i in range(12):
            local_id = i + 1
            sender = (1, 2, 3, 99)[i % 4]  # 99 is deliberately not in Name2Id
            kind = (1, 1, 3, 49, 10000, 1)[i % 6]
            # 奇数行用秒级时间戳，偶数行用毫秒，覆盖 _time_ms_sql 的两条分支
            when = 1_700_000_000 + base + i if i % 2 else (1_700_000_000 + base + i) * 1000
            if kind == 1 and i % 3 == 0:
                body, compress = None, ZSTD.compress(f"压缩内容 {username} #{i}".encode("utf-8"))
            elif kind == 1:
                body, compress = f"普通消息 {username} #{i}", None
            else:
                body, compress = None, None
            records.append((local_id, 9000 + i, base + i, kind, sender, when, body, compress))
        conn.executemany(f'INSERT INTO "{table}" VALUES (?,?,?,?,?,?,?,?)', records)

    # 一张与消息无关的会话元数据表，供 contact_metadata 读取
    conn.execute("CREATE TABLE Contact (username TEXT, remark TEXT, nick_name TEXT)")
    conn.executemany(
        "INSERT INTO Contact VALUES (?,?,?)",
        [("wxid_a", "阿甲", "甲"), ("wxid_b", None, "乙"), (None, "垃圾", None)],
    )
    conn.commit()
    conn.close()
    with open(path, "rb") as handle:
        image = handle.read()
    os.remove(path)
    with open(IMAGE_PATH, "wb") as handle:
        handle.write(image)
    return image


def build_ops() -> list[dict]:
    ops: list[dict] = [
        {"op": "usernames"},
        {"op": "known_usernames"},
        {"op": "contact_metadata"},
        {"op": "has_table", "username": "wxid_a"},
        {"op": "has_table", "username": "wxid_missing"},
    ]
    cutoffs = [0, 1_700_000_100, 1_700_000_100_000, 1_700_000_200_000, 4_000_000_000_000]
    for username in ("wxid_a", "wxid_b", "wxid_c"):
        for cutoff in cutoffs:
            ops.append({"op": "count", "username": username, "cutoff_ms": cutoff})
            ops.append({"op": "last_key", "username": username, "cutoff_ms": cutoff})
        ops.append({"op": "latest", "username": username, "contact_id": "c1", "limit": 5})
        ops.append({"op": "latest", "username": username, "contact_id": "c1", "limit": 0})
        for cutoff in (1_700_000_100_000, 1_700_000_105_000):
            ops.append({
                "op": "iter_keyset", "username": username, "contact_id": "c1",
                "cutoff_ms": cutoff, "cursor": None, "limit": 4,
            })
            for cursor in ([201, SHARD_ID, 3], [201, "shard-0", 3], [201, "shard-9", 3]):
                ops.append({
                    "op": "iter_keyset", "username": username, "contact_id": "c1",
                    "cutoff_ms": cutoff, "cursor": cursor, "limit": 4,
                })
            for inclusive in (True, False):
                for cursor in ([204, SHARD_ID, 5], [204, "shard-0", 5], [204, "shard-9", 5]):
                    ops.append({
                        "op": "iter_before", "username": username, "contact_id": "c1",
                        "cutoff_ms": cutoff, "cursor": cursor, "limit": 3,
                        "inclusive": inclusive,
                    })
        ops.append({
            "op": "iter_before", "username": username, "contact_id": "c1",
            "cutoff_ms": 4_000_000_000_000, "cursor": [999, SHARD_ID, 999],
            "limit": 0, "inclusive": True,
        })
    # 放在最后：set_self_username 会改变后续 row 的 side 判定，先跑完取数类操作
    ops.extend([
        {"op": "set_self_username", "username": "wxid_ghost"},
        {"op": "set_self_username", "username": None},
        {"op": "set_self_username", "username": SELF},
        {"op": "latest", "username": "wxid_a", "contact_id": "c2", "limit": 3},
    ])
    return ops


def run_ops(image: bytes, ops: list[dict]) -> list[dict]:
    shard = db.SqliteShard(SHARD_ID, image, ACCOUNT, SELF)
    out: list[dict] = []
    try:
        for op in ops:
            name = op["op"]
            if name == "usernames":
                out.append({"ok": shard.usernames()})
            elif name == "known_usernames":
                out.append({"ok": shard.known_usernames()})
            elif name == "contact_metadata":
                out.append({"ok": shard.contact_metadata()})
            elif name == "has_table":
                out.append({"ok": shard.has_table(op["username"])})
            elif name == "set_self_username":
                out.append({"ok": shard.set_self_username(op["username"])})
            elif name == "count":
                out.append({"ok": shard.count(op["username"], op["cutoff_ms"])})
            elif name == "last_key":
                key = shard.last_key(op["username"], op["cutoff_ms"])
                out.append({"ok": list(key) if key is not None else None})
            elif name == "latest":
                out.append({"ok": shard.latest(op["username"], op["contact_id"], op["limit"])})
            elif name == "iter_keyset":
                cursor = tuple(op["cursor"]) if op["cursor"] else None
                out.append({"ok": list(shard.iter_keyset(
                    op["username"], op["contact_id"], op["cutoff_ms"], cursor, op["limit"]))})
            elif name == "iter_before":
                out.append({"ok": list(shard.iter_before(
                    op["username"], op["contact_id"], op["cutoff_ms"],
                    tuple(op["cursor"]), op["limit"], op["inclusive"]))})
            else:
                raise SystemExit(f"unknown op {name}")
    finally:
        shard.close()
    return out


def main() -> int:
    image = build_image()
    ops = build_ops()
    expected = run_ops(image, ops)
    with open(os.path.join(CRATE, "testdata", "ops.json"), "w", encoding="utf-8") as handle:
        for op in ops:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    with open(os.path.join(CRATE, "testdata", "expected.json"), "w", encoding="utf-8") as handle:
        json.dump(expected, handle, ensure_ascii=False, indent=1)
    print(f"{len(ops)} ops, image {len(image)} bytes -> testdata/ops.json + expected.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
