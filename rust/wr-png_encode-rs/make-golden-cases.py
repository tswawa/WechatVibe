"""Real-world cases for `wr/png_encode.py`: the fuzzer never produces a valid buffer."""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

from wr import png_encode  # noqa: E402

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


def buffer(width: int, height: int, seed: int) -> bytes:
    return bytes((seed + i * 7) & 0xFF for i in range(width * height * 3))


for w, h, seed in (
    (1, 1, 0),
    (1, 8, 3),
    (2, 2, 17),
    (3, 5, 91),
    (16, 16, 5),
    (37, 100, 11),
    (100, 37, 200),
    (256, 4, 0),
):
    case("encode_png_rgb", w, h, buffer(w, h, seed))

# 尺寸非法
case("encode_png_rgb", 0, 4, b"")
case("encode_png_rgb", -3, 4, bytes(36))
case("encode_png_rgb", 4, 0, b"")
case("encode_png_rgb", 4, -2, bytes(24))
# 缓冲区长度不对
case("encode_png_rgb", 4, 4, bytes(47))
case("encode_png_rgb", 4, 4, bytes(49))
case("encode_png_rgb", 1, 1, b"")
# 全黑 / 全白，边界压缩率
case("encode_png_rgb", 32, 32, bytes(32 * 32 * 3))
case("encode_png_rgb", 32, 32, b"\xff" * (32 * 32 * 3))

with open(os.path.join(HERE, "golden-png.jsonl"), "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(CASES)} cases")
