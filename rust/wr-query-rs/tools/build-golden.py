"""Build fixture shards and record the original's answers — the golden set.

Covers `SqliteShard` (one shard) and `ContactStore` (two shards, overlapping server ids so the
cross-shard re-sync de-duplication actually fires).

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
SELF = "wxid_me"
ZSTD = zstandard.ZstdCompressor()

MESSAGE_COLUMNS = (
    "local_id INTEGER, server_id INTEGER, sort_seq INTEGER, local_type INTEGER, "
    "real_sender_id INTEGER, create_time INTEGER, message_content TEXT, compress_content BLOB"
)


def _shard_image(name: str, tables: dict[str, list[tuple]]) -> bytes:
    path = os.path.join(DATA, f"build-{name}.db")
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE Name2Id (id INTEGER PRIMARY KEY, user_name TEXT)")
    conn.executemany(
        "INSERT INTO Name2Id VALUES (?, ?)",
        [(1, SELF), (2, "wxid_a"), (3, "wxid_b"), (4, "wxid_c"), (5, None)],
    )
    for username, records in tables.items():
        table = f"Msg_{db.md5_username(username)}"
        conn.execute(f'CREATE TABLE "{table}" ({MESSAGE_COLUMNS})')
        conn.executemany(f'INSERT INTO "{table}" VALUES (?,?,?,?,?,?,?,?)', records)
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
    with open(os.path.join(DATA, f"{name}.db"), "wb") as handle:
        handle.write(image)
    return image


def _records(base: int, count: int = 12, server_base: int = 9000) -> list[tuple]:
    records = []
    for i in range(count):
        local_id = i + 1
        sender = (1, 2, 3, 99)[i % 4]
        kind = (1, 1, 3, 49, 10000, 1)[i % 6]
        when = 1_700_000_000 + base + i if i % 2 else (1_700_000_000 + base + i) * 1000
        if kind == 1 and i % 3 == 0:
            body, compress = None, ZSTD.compress(f"压缩 {base} #{i}".encode("utf-8"))
        elif kind == 1:
            body, compress = f"普通 {base} #{i}", None
        else:
            body, compress = None, None
        records.append((local_id, server_base + i, base + i, kind, sender, when, body, compress))
    return records


def build_images() -> tuple[bytes, bytes]:
    os.makedirs(DATA, exist_ok=True)
    first = _shard_image("msg-1", {"wxid_a": _records(100), "wxid_b": _records(200)})
    # 第二个分片重复 wxid_a，且 server_id 与第一个分片重叠 —— 触发跨分片去重
    second = _shard_image("msg-2", {"wxid_a": _records(100, count=6), "wxid_c": _records(300)})
    return first, second


def shard_ops() -> list[dict]:
    ops: list[dict] = [
        {"target": "shard", "op": "usernames"},
        {"target": "shard", "op": "known_usernames"},
        {"target": "shard", "op": "contact_metadata"},
        {"target": "shard", "op": "has_table", "username": "wxid_a"},
        {"target": "shard", "op": "has_table", "username": "wxid_c"},
    ]
    cutoffs = [0, 1_700_000_100, 1_700_000_100_000, 1_700_000_200_000, 4_000_000_000_000]
    for username in ("wxid_a", "wxid_b", "wxid_c"):
        for cutoff in cutoffs:
            ops.append({"target": "shard", "op": "count", "username": username, "cutoff_ms": cutoff})
            ops.append({"target": "shard", "op": "last_key", "username": username, "cutoff_ms": cutoff})
        ops.append({"target": "shard", "op": "latest", "username": username, "contact_id": "c1", "limit": 5})
        ops.append({"target": "shard", "op": "latest", "username": username, "contact_id": "c1", "limit": 0})
        for cutoff in (1_700_000_100_000, 1_700_000_105_000):
            ops.append({"target": "shard", "op": "iter_keyset", "username": username,
                        "contact_id": "c1", "cutoff_ms": cutoff, "cursor": None, "limit": 4})
            for cursor in ([201, "shard-1", 3], [201, "shard-0", 3], [201, "shard-9", 3]):
                ops.append({"target": "shard", "op": "iter_keyset", "username": username,
                            "contact_id": "c1", "cutoff_ms": cutoff, "cursor": cursor, "limit": 4})
            for inclusive in (True, False):
                for cursor in ([204, "shard-1", 5], [204, "shard-0", 5], [204, "shard-9", 5]):
                    ops.append({"target": "shard", "op": "iter_before", "username": username,
                                "contact_id": "c1", "cutoff_ms": cutoff, "cursor": cursor,
                                "limit": 3, "inclusive": inclusive})
    # set_self_username 会改变后续 side 判定，放在取数操作之后
    ops.extend([
        {"target": "shard", "op": "set_self_username", "username": "wxid_ghost"},
        {"target": "shard", "op": "set_self_username", "username": None},
        {"target": "shard", "op": "set_self_username", "username": SELF},
        {"target": "shard", "op": "latest", "username": "wxid_a", "contact_id": "c2", "limit": 3},
    ])
    return ops


def store_ops() -> list[dict]:
    ops: list[dict] = [
        {"target": "store", "op": "contact_id_for", "username": "wxid_a"},
        {"target": "store", "op": "username_for", "contact_id": db.contact_id_for(ACCOUNT, "wxid_a")},
        {"target": "store", "op": "username_for", "contact_id": "nope"},
        {"target": "store", "op": "contacts"},
    ]
    for username in ("wxid_a", "wxid_b", "wxid_c", "wxid_missing"):
        for cutoff in (0, 1_700_000_105_000, 1_700_000_200_000, 4_000_000_000_000):
            ops.append({"target": "store", "op": "total", "username": username, "cutoff_ms": cutoff})
            ops.append({"target": "store", "op": "store_last_key", "username": username,
                        "cutoff_ms": cutoff})
        for limit in (0, 1, 3, 5, 20):
            ops.append({"target": "store", "op": "store_latest", "username": username, "limit": limit})
        for limit in (1, 2, 4):
            ops.append({"target": "store", "op": "page", "username": username,
                        "cutoff_ms": 4_000_000_000_000, "limit": limit})
        for inclusive in (True, False):
            for cursor in ([201, "shard-1", 3], [204, "shard-2", 5], [999, "shard-9", 999]):
                ops.append({"target": "store", "op": "context_before", "username": username,
                            "cutoff_ms": 4_000_000_000_000, "cursor": cursor,
                            "limit": 3, "inclusive": inclusive})
        ops.append({"target": "store", "op": "rows", "username": username, "limit": 40})
    return ops


def run_shard_ops(image: bytes, ops: list[dict]) -> list[dict]:
    shard = db.SqliteShard("shard-1", image, ACCOUNT, SELF)
    out = []
    try:
        for op in ops:
            out.append({"ok": _shard_call(shard, op)})
    finally:
        shard.close()
    return out


def _shard_call(shard: "db.SqliteShard", op: dict):
    name = op["op"]
    if name == "usernames":
        return shard.usernames()
    if name == "known_usernames":
        return shard.known_usernames()
    if name == "contact_metadata":
        return shard.contact_metadata()
    if name == "has_table":
        return shard.has_table(op["username"])
    if name == "set_self_username":
        return shard.set_self_username(op["username"])
    if name == "count":
        return shard.count(op["username"], op["cutoff_ms"])
    if name == "last_key":
        key = shard.last_key(op["username"], op["cutoff_ms"])
        return list(key) if key is not None else None
    if name == "latest":
        return shard.latest(op["username"], op["contact_id"], op["limit"])
    if name == "iter_keyset":
        cursor = tuple(op["cursor"]) if op["cursor"] else None
        return list(shard.iter_keyset(op["username"], op["contact_id"], op["cutoff_ms"],
                                     cursor, op["limit"]))
    if name == "iter_before":
        return list(shard.iter_before(op["username"], op["contact_id"], op["cutoff_ms"],
                                      tuple(op["cursor"]), op["limit"], op["inclusive"]))
    raise SystemExit(f"unknown shard op {name}")


def run_store_ops(images: tuple[bytes, bytes], ops: list[dict]) -> list[dict]:
    first = db.SqliteShard("shard-1", images[0], ACCOUNT, SELF)
    second = db.SqliteShard("shard-2", images[1], ACCOUNT, SELF)
    store = db.ContactStore(ACCOUNT, [first, second])
    out = []
    for op in ops:
        name = op["op"]
        if name == "contact_id_for":
            value = store.contact_id_for(op["username"])
        elif name == "username_for":
            value = store.username_for(op["contact_id"])
        elif name == "contacts":
            value = store.contacts()
        elif name == "total":
            value = store.total(op["username"], op["cutoff_ms"])
        elif name == "store_last_key":
            key = store.last_key(op["username"], op["cutoff_ms"])
            value = list(key) if key is not None else None
        elif name == "store_latest":
            value = store.latest(op["username"], op["limit"])
        elif name == "page":
            rows, cursor, done = store.page(op["username"], op["cutoff_ms"], None, op["limit"])
            value = {"rows": rows, "cursor": list(cursor) if cursor else None, "done": done}
        elif name == "context_before":
            value = store.context_before(op["username"], op["cutoff_ms"],
                                         tuple(op["cursor"]), op["limit"], op["inclusive"])
        elif name == "rows":
            collected = []
            for row in store.rows(op["username"]):
                collected.append(row)
                if len(collected) >= op["limit"]:
                    break
            value = collected
        else:
            raise SystemExit(f"unknown store op {name}")
        out.append({"ok": value})
    first.close()
    second.close()
    return out


def main() -> int:
    images = build_images()
    shard = shard_ops()
    store = store_ops()
    all_ops = shard + store
    expected = run_shard_ops(images[0], shard) + run_store_ops(images, store)

    with open(os.path.join(DATA, "ops.json"), "w", encoding="utf-8") as handle:
        for op in all_ops:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    with open(os.path.join(DATA, "expected.json"), "w", encoding="utf-8") as handle:
        json.dump(expected, handle, ensure_ascii=False, indent=1)
    print(f"{len(all_ops)} ops ({len(shard)} shard + {len(store)} store) -> testdata/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
