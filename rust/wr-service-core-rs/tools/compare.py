"""Differential check for `wr/service.py`'s deterministic helpers and shard decryption.

Builds synthetic SQLCipher-shaped pages with the original crypto/wal modules, then runs the same
ops through the original `service.py` functions and the Rust binary.

    python tools/compare.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
ROOT_REPO = os.path.dirname(os.path.dirname(CRATE))
sys.path.insert(0, os.path.join(ROOT_REPO, "native-reader"))

from wr import crypto, errors, service, wal  # noqa: E402

DATA = os.path.join(CRATE, "testdata")
BINARY = os.path.join(CRATE, "target", "release", "wr-service-core.exe")

KEY = bytes(range(32))
SALT = bytes((i * 29 + 5) & 0xFF for i in range(16))
PAGE_KEY = crypto.make_page_key(KEY, SALT)
PAGE_SIZE = 4096
USABLE = PAGE_SIZE - 80


def enc(value):
    if isinstance(value, bool) or isinstance(value, int) or isinstance(value, str):
        return value
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": list(value)}
    if isinstance(value, tuple):
        return {"$tuple": [enc(v) for v in value]}
    if isinstance(value, list):
        return [enc(v) for v in value]
    if isinstance(value, dict):
        if all(isinstance(k, str) for k in value):
            return {k: enc(v) for k, v in value.items()}
        return {"$dict": [[enc(k), enc(v)] for k, v in value.items()]}
    raise TypeError(type(value))


def usable_page(number: int) -> bytes:
    page = bytearray((number * 17 + i) & 0xFF for i in range(USABLE))
    if number == 1:
        page[0:16] = b"SQLite format 3\x00"
        page[16:18] = PAGE_SIZE.to_bytes(2, "big")
        page[18] = 1
        page[19] = 1
        page[20] = 80
    return bytes(page)


def build_inputs():
    db = b"".join(
        crypto.encrypt_page(usable_page(n), PAGE_KEY, n, n == 1) for n in (1, 2, 3)
    )
    # WAL header/frame salts are 4 bytes each — distinct from SQLCipher's 16-byte page salt.
    wal_salt1, wal_salt2 = bytes([1, 2, 3, 4]), bytes([5, 6, 7, 8])
    header = wal.build_wal_header(PAGE_SIZE, wal_salt1, wal_salt2, True)
    s0 = int.from_bytes(header[24:28], "big")
    s1 = int.from_bytes(header[28:32], "big")
    replacement = crypto.encrypt_page(usable_page(9), PAGE_KEY, 2, False)
    frame, _, _ = wal.build_frame(2, replacement, wal_salt1, wal_salt2, s0, s1, True, 2, True)
    return {
        "db": db,
        "wal": header + frame,
        "bad_wal": header + bytes(len(frame)),
        "key": KEY,
        "salt": SALT,
        "short_key": bytes(31),
    }


def build_ops(inp):
    base = {
        "db": enc(inp["db"]), "wal": enc(inp["wal"]),
        "key": enc(inp["key"]), "salt": enc(inp["salt"]),
    }
    ops: list[dict] = [
        {"op": "map_kind", "kind": "friend"},
        {"op": "map_kind", "kind": "private"},
        {"op": "map_kind", "kind": "chatroom"},
        {"op": "map_kind", "kind": "service"},
        {"op": "map_kind", "kind": "bogus"},
        {"op": "int_param", "value": None, "default": 5, "low": 1, "high": 10},
        {"op": "int_param", "value": "7", "default": 5, "low": 1, "high": 10},
        {"op": "int_param", "value": 11, "default": 5, "low": 1, "high": 10},
        {"op": "int_param", "value": "x", "default": 5, "low": 1, "high": 10},
        {"op": "classify_shard", "path": "D:/data/Message/msg-0.db"},
        {"op": "classify_shard", "path": "D:/x/contact.db"},
        {"op": "classify_shard", "path": "D:/x/session_1.db"},
        {"op": "classify_shard", "path": "D:/x/misc.db"},
        {"op": "account_username_candidates", "path": "D:/xwechat_files/wxid_ab12/db_storage"},
        {"op": "account_username_candidates", "path": "D:/xwechat_files/abc/db_storage"},
        {"op": "decrypt_shard_pages", **base},
        {"op": "decrypt_shard_image", **base},
        {"op": "decrypt_shard_pages", **base, "wal": enc(inp["bad_wal"])},
        {"op": "decrypt_shard_image", **base, "wal": enc(inp["bad_wal"])},
        {"op": "decrypt_shard_image", **base, "db": enc(inp["db"][:-1])},
        {"op": "decrypt_shard_image", **base, "key": enc(inp["short_key"])},
        {"op": "decrypt_shard_pages", **base, "wal": None},
    ]
    return ops


def run_python(ops):
    out = []
    for op in ops:
        name = op["op"]
        try:
            if name == "map_kind":
                value = service._map_kind(op["kind"])
            elif name == "int_param":
                value = service._int_param(op["value"], op["default"], op["low"], op["high"], "value")
            elif name == "classify_shard":
                value = service._classify_shard(op["path"])
            elif name == "account_username_candidates":
                value = service._account_username_candidates(op["path"])
            elif name in ("decrypt_shard_pages", "decrypt_shard_image"):
                data = op["db"]["$bytes"]
                db = bytes(data)
                wal_data = bytes(op["wal"]["$bytes"]) if op["wal"] and "$bytes" in op["wal"] else None
                key = crypto.make_page_key(bytes(op["key"]["$bytes"]), bytes(op["salt"]["$bytes"]))
                if name == "decrypt_shard_pages":
                    pages, commit, salt, frames = service._decrypt_shard_pages(db, wal_data, key)
                    value = (pages, commit, salt, frames)
                else:
                    value = service._decrypt_shard_image(db, wal_data, key)
            else:
                raise SystemExit(f"unknown op {name}")
            out.append({"ok": enc(value)})
        except errors.ProtocolError as exc:
            out.append({"error": f"ProtocolError: {exc}"})
    return out


def run_rust(ops):
    if not os.path.exists(BINARY):
        print(f"missing {BINARY}; run: cargo build --release", file=sys.stderr)
        raise SystemExit(2)
    path = os.path.join(DATA, "ops.json")
    with open(path, "w", encoding="utf-8") as handle:
        for op in ops:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    proc = subprocess.run([BINARY, "--ops", path], check=True, capture_output=True)
    return json.loads(proc.stdout)


def normalise(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key == "error" and isinstance(item, str):
                import re
                item = re.sub(r"^ProtocolError\([^)]*\): ", "ProtocolError: ", item)
            out[key] = normalise(item)
        return out
    if isinstance(value, list):
        return [normalise(v) for v in value]
    return value


def main():
    os.makedirs(DATA, exist_ok=True)
    inp = build_inputs()
    ops = build_ops(inp)
    py = normalise(run_python(ops))
    rs = normalise(run_rust(ops))
    failures = []
    for index, (want, have) in enumerate(zip(py, rs)):
        if want != have:
            failures.append(
                f"op #{index} {ops[index]['op']}:\n"
                f"  python {json.dumps(want, ensure_ascii=False)[:260]}\n"
                f"  rust   {json.dumps(have, ensure_ascii=False)[:260]}"
            )
    if len(py) != len(rs):
        failures.append(f"response count {len(py)} != {len(rs)}")
    for failure in failures:
        print(failure)
    print(f"{len(ops) - len(failures)}/{len(ops)} ops identical")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
