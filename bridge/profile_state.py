"""Incremental sufficient statistics for a persisted, target-scoped portrait."""
import math

from backend_contracts import AFFINITY_DECAY
from profile_signals import STYLE_LABELS


RELATIONSHIP_LABELS = ("romantic", "warm", "neutral", "distant", "rejecting")


def relationship_confidence(result):
    """Match scoring.ts: total-variation distance from a uniform relationship answer.

    Results written before relationship distributions were retained count as fully reliable.
    API results may carry the already computed scoreConfidence instead.
    """
    explicit = result.get("scoreConfidence")
    if explicit is not None:
        if type(explicit) not in (int, float) or not math.isfinite(explicit) or not 0 <= explicit <= 1:
            raise ValueError("invalid relationship confidence")
        return explicit
    if "relationship" not in result:
        return 1.0
    distribution = result.get("relationship") or []
    probabilities = {}
    total = 0.0
    for entry in distribution:
        probability = entry.get("probability") if isinstance(entry, dict) else None
        if type(probability) not in (int, float) or not math.isfinite(probability) or probability <= 0:
            continue
        label = entry.get("rawLabel") or entry.get("label")
        probabilities[label] = probability
        total += probability
    if total <= 0:
        return 0.0
    probabilities = {label: value / total for label, value in probabilities.items()}
    uniform = 1 / len(RELATIONSHIP_LABELS)
    distance = sum(abs(probabilities.get(label, 0.0) - uniform) for label in RELATIONSHIP_LABELS)
    return min(1.0, max(0.0, distance / (2 * (1 - uniform))))


def add_exp_score(state, score, confidence, targets=1, tail_scores=(), tail_confidences=()):
    """Add one identical score block, optionally before existing scored tail messages.

    scoreExp = Σ score·confidence·r**age and confidenceExp = Σ confidence·r**age.
    Missing fields identify a legacy v1 accumulator; keep it on the old formula instead of
    mixing two weighting schemes. Tail entries are chronological and currently occupy ages
    len(tails)-1 .. 0, which makes out-of-order insertion exact as well.
    """
    has_score = "scoreExp" in state
    has_confidence = "confidenceExp" in state
    if not has_score and not has_confidence:
        return
    if has_score != has_confidence or len(tail_scores) != len(tail_confidences):
        raise ValueError("incompatible affinity statistics")
    decay = AFFINITY_DECAY ** targets
    count = len(tail_scores)
    tail_score_exp = sum(value * reliability * AFFINITY_DECAY ** (count - 1 - index)
                         for index, (value, reliability) in enumerate(zip(tail_scores, tail_confidences)))
    tail_confidence_exp = sum(reliability * AFFINITY_DECAY ** (count - 1 - index)
                              for index, reliability in enumerate(tail_confidences))
    block = (1 - decay) / (1 - AFFINITY_DECAY)
    inserted = AFFINITY_DECAY ** count * block
    # Only messages older than the insertion point gain an age. Tails keep their current
    # weight, while every older message decays; appending is the special case with no tail.
    state["scoreExp"] = (state["scoreExp"] * decay + (1 - decay) * tail_score_exp +
                         score * confidence * inserted)
    state["confidenceExp"] = (state["confidenceExp"] * decay + (1 - decay) * tail_confidence_exp +
                              confidence * inserted)


def empty_state():
    return {"count": 0, "targetCount": 0, "scoreCount": 0, "scoreSum": 0.0,
            "scoreWeighted": 0.0, "scoreExp": 0.0, "confidenceExp": 0.0,
            "moodCount": 0, "mood": {}, "latest": None,
            "emotion": {}, "intent": {}, "broad": {}, "words": {},
            "styleCount": 0, "style": {key: 0.0 for key in STYLE_LABELS},
            "axes": {axis: [0.0, 0.0, 0, 0] for axis in ("EI", "SN", "TF", "JP")},
            "supported": 0}


def covers_tail_emotions(state, tails):
    labels = {entry.get("rawLabel") or entry["label"] for emotion in tails for entry in emotion}
    return len(tails) <= state["moodCount"] and labels <= set(state["mood"])


def add_result(state, result, score, side, position, words, tails=()):
    """Append normally in O(new evidence); tails are only for out-of-order backfill."""
    tail_emotions = [item.get("emotion") for item, _score in tails if item.get("emotion")]
    if not covers_tail_emotions(state, tail_emotions):
        raise ValueError("profile statistics do not cover stored tail evidence")
    state["count"] += 1
    for field in ("emotion", "intent"):
        for entry in result.get(field) or []:
            label = entry["label"]
            state[field][label] = state[field].get(label, 0.0) + entry["probability"]
    if side != "other":
        return
    state["targetCount"] += 1
    scored_tails = [(item, value) for item, value in tails if value is not None]
    tail_scores = [value for _result, value in scored_tails]
    if score is not None:
        state["scoreWeighted"] += (state["scoreCount"] - len(tail_scores)) * score + sum(tail_scores)
        add_exp_score(state, score, relationship_confidence(result), tail_scores=tail_scores,
                      tail_confidences=[relationship_confidence(item) for item, _value in scored_tails])
        state["scoreSum"] += score
        state["scoreCount"] += 1
    emotion = result.get("emotion") or []
    if emotion:
        rank = state["moodCount"] - len(tail_emotions)
        for tail in tail_emotions:
            for entry in tail:
                raw = entry.get("rawLabel") or entry["label"]
                state["mood"][raw]["weighted"] += entry["probability"]
        for entry in emotion:
            raw = entry.get("rawLabel") or entry["label"]
            values = state["mood"].setdefault(raw, {"label": entry["label"], "sum": 0.0, "weighted": 0.0})
            values["sum"] += entry["probability"]
            values["weighted"] += rank * entry["probability"]
            values["label"] = entry["label"]
        state["moodCount"] += 1
    if state["latest"] is None or tuple(position) > tuple(state["latest"]):
        state["latest"] = list(position)
    for word, count in words.items():
        state["words"][word] = state["words"].get(word, 0) + count
    for entry in result.get("intentBroad") or []:
        label = entry["label"]
        state["broad"][label] = state["broad"].get(label, 0.0) + entry["probability"]
    evidence = result.get("styleEvidence")
    if evidence:
        state["styleCount"] += 1
        for key in STYLE_LABELS:
            state["style"][key] += evidence[key]
    evidence = result.get("personalityEvidence")
    supported = False
    for axis, totals in state["axes"].items():
        left, right = axis
        distribution = evidence[axis] if evidence else None
        if distribution is None or distribution["insufficient"] >= max(distribution[left], distribution[right]):
            totals[3] += 1
            continue
        totals[0] += distribution[left]
        totals[1] += distribution[right]
        totals[2] += 1
        supported = True
    state["supported"] += int(supported)


def traits_from_state(state):
    count = state["styleCount"]
    return [{"key": key, "label": label, "val": int(100 * state["style"][key] / count + .5),
             "sampleCount": count} for key, label in STYLE_LABELS.items()] if count else []
