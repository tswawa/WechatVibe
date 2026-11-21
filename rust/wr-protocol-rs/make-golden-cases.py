"""Real-world cases for `wr/protocol.py`: valid and invalid request shapes."""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

CASES: list[dict] = []


def enc(value):
    if isinstance(value, bool) or isinstance(value, int) or isinstance(value, str):
        return value
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": list(value)}
    if isinstance(value, dict):
        return {k: enc(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [enc(v) for v in value]
    raise TypeError(type(value))


def case(fn, *args):
    CASES.append({"fn": fn, "args": [enc(a) for a in args]})


# --- validate_request 正常 ---
case("validate_request", {"id": "req-1", "method": "status", "params": {}})
case("validate_request", {"id": "a", "method": "m", "params": {"x": 1}})
case("validate_request", {"id": "id" * 128, "method": "m" * 64})
case("validate_request", {"id": "req-2", "method": "discover"})
case("validate_request", {"id": "req-3", "method": "discover", "params": None})
case("validate_request", {"id": "req-4", "method": "snapshot", "params": {"account": "a"}})
# --- validate_request 非法 ---
case("validate_request", {})
case("validate_request", {"id": "", "method": "m"})
case("validate_request", {"id": "x" * 257, "method": "m"})
case("validate_request", {"id": 1, "method": "m"})
case("validate_request", {"id": "i", "method": ""})
case("validate_request", {"id": "i", "method": "m" * 65})
case("validate_request", {"id": "i", "method": 7})
case("validate_request", {"id": "i", "method": "m", "params": []})
case("validate_request", {"id": "i", "method": "m", "params": "x"})
case("validate_request", [])
case("validate_request", "x")
case("validate_request", None)

# --- ok / fail ---
case("ok", "req-1", {"a": 1})
case("ok", "req-2", None)
case("ok", "req-3", [1, 2, 3])
case("ok", "", {})
case("fail", "req-1", "bad_request", "boom")
case("fail", "req-2", "key_unavailable", "")
case("fail", "", "internal", "x")

with open(os.path.join(HERE, "golden-protocol.jsonl"), "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(CASES)} cases")
