"""Golden cases for message_contracts: valid insight items and scope strings."""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
cases = []


def case(fn, *args):
    cases.append({"fn": fn, "args": list(args)})


for source in ("wxid_abc", "chatroom-1", ""):
    case("api_insight_scope", source)

for label in ("开心", "担心", "ok", "开心啊", "开门见山", "😀开心", "a开心"):
    case("valid_api_insight_label", label)

items = [
    {"id": "m1", "status": "ok"},
    {"id": "m2", "status": "routine"},
    {"id": "m3", "status": "uncertain", "affect": {}, "intents": []},
    {"id": "m4", "status": "insufficient"},
    {"id": "m5", "status": "ok", "affect": {"tone": "平静", "feeling": "开心"}, "intents": ["询问"]},
    {"id": "m6", "status": "ok", "affect": {"feeling": "平静"}, "intents": []},
    {"id": "m7", "status": "ok", "emotion": "开心", "intent": "询问"},
    {"id": "m8", "status": "ok", "affect": {"tone": "开心", "feeling": "开心"}},
    {"id": "m9", "status": "ok", "intents": ["询问", "确认"]},
    {"id": "m10", "status": "ok", "affect": None, "intents": None},
    {"id": "m11", "status": "bad"},
    {"status": "ok"},
    ["not", "a", "dict"],
]
for item in items:
    case("normalize_api_insight", item)

with open(os.path.join(HERE, "golden.jsonl"), "w", encoding="utf-8") as f:
    for c in cases:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(cases)} cases")
