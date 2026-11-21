"""Golden cases for message_results: valid and invalid analyzer responses."""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AXES = {"EI": ("E", "I"), "SN": ("S", "N"), "TF": ("T", "F"), "JP": ("J", "P")}
STYLE = {"socialEnergy": "表达活力", "humor": "幽默表达", "composure": "情绪平和",
         "initiative": "话题主动", "care": "关怀支持", "affection": "亲近表达"}


def personality():
    return {axis: {left: .5, right: .3, "insufficient": .2} for axis, (left, right) in AXES.items()}


def valid(fine=False):
    response = {
        "analysisVersion": "v3",
        "emotion": [{"label": "开心", "probability": .9}],
        "intent": [{"label": "询问", "probability": .8}],
        "emotionLabel": "开心", "intentLabel": "询问", "emotionP": .9, "intentP": .8,
        "intentBroad": [{"label": "社交", "probability": .7}],
        "expression": [{"label": "简短", "probability": .6}],
        "playfulIntent": [{"label": "playful:tease", "probability": .4}],
        "styleEvidence": {key: .5 for key in STYLE},
        "personalityEvidence": personality(),
        "relationship": [{"label": "朋友", "probability": .8}],
        "score": .5,
    }
    if fine:
        response["labelSchema"] = "generic-v12"
        response["groundedIntent"] = {"label": "greet", "evidenceKind": "greeting_phrase"}
    return response


cases = []


def case(fn, *args):
    cases.append({"fn": fn, "args": list(args)})


for fn in ("validate_portrait_result", "validate_fine_result"):
    fine = fn.endswith("fine_result")
    case(fn, valid(fine), "v3", "self")
    case(fn, valid(fine), "v3", "other")
    case(fn, valid(fine), "v2", "self")
    bad = valid(fine)
    del bad["emotion"]
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    bad["emotion"] = []
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    bad["intent"] = [{"label": "x", "probability": 1.5}]
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    bad["playfulIntent"] = [{"label": "x", "probability": .4}]
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    bad["styleEvidence"] = {"humor": .5}
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    bad["personalityEvidence"] = {"EI": {}}
    case(fn, bad, "v3", "self")
    bad = valid(fine)
    del bad["score"]
    case(fn, bad, "v3", "other")
    bad = valid(fine)
    bad["relationship"] = None
    case(fn, bad, "v3", "self")

with open(os.path.join(HERE, "golden.jsonl"), "w", encoding="utf-8") as f:
    for c in cases:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
print(f"wrote {len(cases)} cases")
