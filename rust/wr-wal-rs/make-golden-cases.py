"""Real-world cases for `wr/wal.py`.

The fuzzer only feeds garbage, so no valid WAL ever gets parsed. This builds genuine WAL images
with the original's own `build_wal_header` / `build_frame` and records the interesting shapes:
committed frames, an uncommitted tail, a corrupt first frame, bad magic, bad page size, short data.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

from wr import wal  # noqa: E402

CASES: list[dict] = []


def enc(value):
    if isinstance(value, bool) or isinstance(value, int) or isinstance(value, str):
        return value
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": list(value)}
    raise TypeError(type(value))


def case(fn, *args):
    CASES.append({"fn": fn, "args": [enc(a) for a in args]})


def page(fill: int, size: int) -> bytes:
    return bytes((fill + i) & 0xFF for i in range(size))


SALT1 = bytes([0x11, 0x22, 0x33, 0x44])
SALT2 = bytes([0xAA, 0xBB, 0xCC, 0xDD])

for page_size, little in ((512, True), (1024, False), (4096, True), (4096, False)):
    for s1, s2 in ((SALT1, SALT2), (bytes(4), bytes([0xFF] * 4))):
        case("build_wal_header", page_size, s1, s2, little)

        header = wal.build_wal_header(page_size, s1, s2, little)
        s0 = int.from_bytes(header[24:28], "big")
        s1c = int.from_bytes(header[28:32], "big")

        # 一帧、非提交帧
        case("build_frame", 1, page(3, page_size), s1, s2, s0, s1c, False, 0, little)
        # 一帧、提交帧（带 db_size）
        case("build_frame", 1, page(3, page_size), s1, s2, s0, s1c, True, 1, little)

        # 单次提交
        f1, a0, a1 = wal.build_frame(1, page(1, page_size), s1, s2, s0, s1c, True, 1, little)
        wal_one = header + f1
        case("parse_wal", wal_one)
        case("parse_committed_frames", wal_one)

        # 两次提交（第二次覆盖第一帧）
        f2, b0, b1 = wal.build_frame(1, page(2, page_size), s1, s2, a0, a1, False, 0, little)
        f3, c0, c1 = wal.build_frame(2, page(5, page_size), s1, s2, b0, b1, True, 2, little)
        wal_two = header + f1 + f2 + f3
        case("parse_wal", wal_two)
        case("parse_committed_frames", wal_two)

        # 提交之后跟一段未提交尾巴
        f4, d0, d1 = wal.build_frame(3, page(9, page_size), s1, s2, c0, c1, False, 0, little)
        wal_tail = wal_two + f4
        case("parse_wal", wal_tail)
        case("parse_committed_frames", wal_tail)

        # 第一帧校验和被改坏
        broken = bytearray(wal_one)
        broken[wal.WAL_HEADER_SIZE + 16] ^= 0xFF
        case("parse_wal", bytes(broken))
        case("parse_committed_frames", bytes(broken))

        # 头部 magic 不对
        bad_magic = bytearray(wal_one)
        bad_magic[0:4] = (0x12345678).to_bytes(4, "big")
        case("parse_wal", bytes(bad_magic))
        case("parse_committed_frames", bytes(bad_magic))

        # 头部 page size 非法
        bad_size = bytearray(wal_one)
        bad_size[8:12] = (999).to_bytes(4, "big")
        case("parse_wal", bytes(bad_size))
        case("parse_committed_frames", bytes(bad_size))

        # 头部校验和不匹配
        bad_sum = bytearray(wal_one)
        bad_sum[24] ^= 0x01
        case("parse_wal", bytes(bad_sum))
        case("parse_committed_frames", bytes(bad_sum))

        # 截断到帧中间
        case("parse_wal", wal_one[: wal.WAL_HEADER_SIZE + 10])
        case("parse_committed_frames", wal_one[: wal.WAL_HEADER_SIZE + 10])

# 空与过短
for blob in (b"", b"\x00" * 8, b"\x00" * 31, b"\x00" * 32, b"\x00" * 56):
    case("parse_wal", blob)
    case("parse_committed_frames", blob)

path = os.path.join(HERE, "golden-wal.jsonl")
with open(path, "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(CASES)} cases")
