"""Real-world cases for `wr/database.py` free functions.

Covers the branches the fuzzer cannot reach: real seconds vs millisecond timestamps, Zstd-compressed
message bodies, invalid UTF-8, and page-dict assembly with and without a committed page count.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

import zstandard  # noqa: E402

CASES: list[dict] = []


def enc(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
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


def case(fn, *args):
    CASES.append({"fn": fn, "args": [enc(a) for a in args]})


# --- 身份 -------------------------------------------------------------------
for name in ("wxid_abc", "", "用户😀", "a" * 200, "with space"):
    case("md5_username", name)
case("contact_id_for", "wxid_me", "wxid_you")
case("contact_id_for", "", "")
case("contact_id_for", "账号", "联系人")
case("message_id_for", "wxid_me", "wxid_you", "shard-1", 42)
case("message_id_for", "", "", "", 0)
case("message_id_for", "a", "b", "c", 9007199254740991)

# --- 时间归一 ---------------------------------------------------------------
for value in (None, 0, -1, -1700000000, 1, 1700000000, 1700000000000,
              99_999_999_999, 100_000_000_000, "1700000000", " 42 ", "abc", "", 1.9, True, False):
    case("normalize_time", value)

# --- 文本提取 ---------------------------------------------------------------
zstd = zstandard.ZstdCompressor()
plain = "你好，世界 hello"
case("extract_text", plain, None)
case("extract_text", "", None)
case("extract_text", None, None)
case("extract_text", None, plain.encode("utf-8"))
case("extract_text", plain.encode("utf-8"), None)
case("extract_text", "", plain.encode("utf-8"))
case("extract_text", None, zstd.compress(plain.encode("utf-8")))
case("extract_text", zstd.compress(plain.encode("utf-8")), None)
case("extract_text", None, zstd.compress(b"\xff\xfe\x00bad"))
case("extract_text", b"\xff\xfe\x00bad", None)
case("extract_text", None, b"\x28\xb5\x2f\xfd" + b"\x00" * 8)  # 坏 zstd
case("extract_text", 123, 456)

# --- 类型分类 ---------------------------------------------------------------
for kind in (1, 10000, 10002, 0, 3, -1, 47, 49):
    case("classify_kind", kind)

# --- 游标 -------------------------------------------------------------------
case("encode_cursor", None)
case("encode_cursor", (1, "shard-a", 2))
case("encode_cursor", (1700000000000, "", 0))
case("decode_cursor", None)
case("decode_cursor", {"sortSeq": "1", "shardId": "s", "localId": "2"})
case("decode_cursor", {"sortSeq": 1, "shardId": "s", "localId": 2})
case("decode_cursor", {"sortSeq": "x", "shardId": "s", "localId": "2"})
case("decode_cursor", {"shardId": "s", "localId": "2"})
case("decode_cursor", ["a"])
case("decode_cursor", "x")

# --- 页拼装 ---------------------------------------------------------------
PAGE_SIZE = 4096
RESERVED = 80
USABLE = PAGE_SIZE - RESERVED


def usable(tag: int) -> bytes:
    return bytes((tag + i) & 0xFF for i in range(USABLE))


one = {1: usable(1)}
case("sqlite_image_from_pages", one)
case("sqlite_image_from_pages", {1: usable(1), 2: usable(2), 3: usable(3)})
case("sqlite_image_from_pages", {3: usable(3), 1: usable(1), 2: usable(2)})
case("sqlite_image_from_pages", {1: usable(1), 2: usable(2), 3: usable(3)}, PAGE_SIZE, RESERVED, 2)
case("sqlite_image_from_pages", {1: usable(1), 2: usable(2)}, PAGE_SIZE, RESERVED, 3)
case("sqlite_image_from_pages", {1: usable(1)}, PAGE_SIZE, RESERVED, 0)
case("sqlite_image_from_pages", {1: usable(1)[:-1]})
case("sqlite_image_from_pages", {})
case("sqlite_image_from_pages", {1: b""})

with open(os.path.join(HERE, "golden-database.jsonl"), "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(CASES)} cases")
