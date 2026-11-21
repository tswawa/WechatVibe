"""Golden cases for profile_signals, restricted to ASCII tokens so jieba and the regex agree."""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STYLE = {key: 0.5 for key in ("socialEnergy", "humor", "composure", "initiative", "care", "affection")}
cases = []


def case(fn, *args):
    cases.append({"fn": fn, "args": list(args)})


case("validate_style_evidence", STYLE)
case("validate_style_evidence", None)
case("validate_style_evidence", {"humor": 0.5})

row = lambda result: [1, result, None, None]
case("historical_mood", [
    row({"emotion": [{"label": "happy", "rawLabel": "joy", "probability": 0.8}]}),
    row({"emotion": [{"label": "sad", "rawLabel": "sorrow", "probability": 0.4}]}),
], {"joy": "^^"})
case("historical_mood", [row({})], {})
case("style_traits", [row({"styleEvidence": STYLE}), row({"styleEvidence": STYLE})])
case("keyword_counts", ["hello world hello", "world test"])
case("keyword_counts", ["hello", "abc def"])
case("keywords_from_counts", {"hello": 3, "world": 2, "test": 1})
case("keywords_from_texts", ["hello hello world", "hello world test"])
case("summary_from_aggregate", 3, {"chat": 0.6, "ask": 0.4}, {"label": "开心"}, [{"word": "hello", "count": 3}], False)
case("summary_from_aggregate", 0, {}, None, [], False)
case("summary_from_aggregate", 2, {}, {"label": "平静"}, [], True)
case("summary_from_signals", [
    row({"intentBroad": [{"label": "chat", "probability": 0.5}]}),
    row({"intentBroad": [{"label": "chat", "probability": 0.3}]}),
], {"label": "开心"}, [{"word": "hello", "count": 2}], False)

with open(os.path.join(HERE, "golden.jsonl"), "w", encoding="utf-8") as f:
    for c in cases:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(cases)} cases")
