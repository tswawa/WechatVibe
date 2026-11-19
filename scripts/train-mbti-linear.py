"""Train the local MBTI evidence classifier.

Four independent 3-class linear heads (one per MBTI axis) share one boundary-marked
Unicode character 1-4 gram vocabulary. Each head predicts:
    [insufficient, left pole, right pole]
which maps directly onto the existing `PersonalityEvidence` wire contract, so the
Python accumulation/aggregation path is unchanged.

Outputs:
  electron/laya/mbti-linear-model.json   inference artifact
  docs/laya-mbti-linear-report.json      held-out metrics and provenance

Method:
  1. 5-fold cross-validation on `split=train`, grouped by TEXT (the same logistics
     line is deliberately reused as an insufficient example on all four axes),
     selects one shared L2.
  2. Heads are fit on train only. Validation chooses a per-axis temperature; this
     never changes the argmax.
  3. `split=test` is evaluated once and gates the release (default >= 90%).

This is a single-message EVIDENCE model, not a personality diagnosis. The existing
100-message / 30-evidence / 0.2-margin gates in backend_contracts.py still decide
whether an MBTI type is shown.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import Counter
from pathlib import Path

import numpy as np

AXES = ("EI", "SN", "TF", "JP")
AXIS_LABELS = {
    "EI": ("insufficient", "E", "I"),
    "SN": ("insufficient", "S", "N"),
    "TF": ("insufficient", "T", "F"),
    "JP": ("insufficient", "J", "P"),
}
EXPECTED_PER_CLASS = {"train": 32, "validation": 4, "test": 6}
SIZES = (1, 2, 3, 4)
PREFIX = "^"
SUFFIX = "$"
EPOCHS = 1200
LEARNING_RATE = 1.0
PRUNE_THRESHOLD = 0.02
L2_GRID = (1e-3, 3e-3, 1e-2, 3e-2)
TEMPERATURES = (0.25, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0)
CV_SEED = 20261107
FEATURE_SPEC = "boundary-unicode-char-ngram-1-4-binary+axis-cues-v2"

# v2 adds axis-specific structural cues. Each cue token is axis-scoped (the EI head
# only sees EI cues), so it cannot pull another axis's decision. Tokens use @ prefix
# to avoid colliding with boundary-marked character n-grams. TS inference mirrors this.
AXIS_CUES = {
    "EI": {
        "@solo_recharge": ("独处", "一个人", "安静", "自己待", "缓一缓", "回血", "看书"),
        "@social_charge": ("约了", "一整晚", "人多", "聊完", "聚会", "话就特别多"),
    },
    "SN": {
        "@abstract": ("规律", "往后", "换个角度", "说不定", "整条路", "本质", "趋势"),
        "@concrete": ("数据", "上次", "照着", "试过", "步骤", "实测", "按流程"),
    },
    "TF": {
        "@empathy": ("难受", "接受", "人情", "处境", "感受", "大家", "照顾"),
        "@principle": ("规则", "成本", "漏洞", "按流程", "对谁都", "算清楚"),
    },
    "JP": {
        "@fixed": ("提前排", "定下来", "别再改", "逐项", "清单", "划掉", "安心"),
        "@flexible": ("别定死", "到了再说", "多留", "回头挑", "随性", "临时改", "赶不上变化"),
    },
}

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "tests" / "fixtures" / "laya-mbti-corpus.jsonl"
MODEL = ROOT / "electron" / "laya" / "mbti-linear-model.json"
REPORT = ROOT / "docs" / "laya-mbti-linear-report.json"


def features(text: str) -> set[str]:
    compact = PREFIX + "".join(char for char in text if not char.isspace()) + SUFFIX
    return {compact[index:index + size]
            for size in SIZES for index in range(len(compact) - size + 1)}


def row_features(row: dict) -> set[str]:
    """Character n-grams plus axis-scoped cue tokens."""
    result = features(row["text"])
    for token, phrases in AXIS_CUES.get(row["axis"], {}).items():
        if any(phrase in row["text"] for phrase in phrases):
            result.add(token)
    return result


def load_corpus() -> list[dict]:
    rows = [json.loads(line) for line in CORPUS.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len({(row["axis"], row["text"]) for row in rows}) != len(rows):
        raise SystemExit("duplicate (axis, text) rows")
    for axis in AXES:
        for split, expected in EXPECTED_PER_CLASS.items():
            for label in AXIS_LABELS[axis]:
                actual = sum(row["axis"] == axis and row["split"] == split and row["label"] == label
                             for row in rows)
                if actual != expected:
                    raise SystemExit(f"unbalanced corpus: {axis}/{split}/{label}: {actual} != {expected}")
    return rows


def vocabulary(rows: list[dict]) -> list[str]:
    grams: set[str] = set()
    for row in rows:
        grams.update(row_features(row))
    return sorted(grams)


def design_matrix(rows: list[dict], vocab: dict[str, int]) -> np.ndarray:
    matrix = np.zeros((len(rows), len(vocab)), dtype=np.float32)
    for index, row in enumerate(rows):
        for gram in row_features(row):
            column = vocab.get(gram)
            if column is not None:
                matrix[index, column] = 1.0
    return matrix


def targets(rows: list[dict], axis: str) -> np.ndarray:
    one_hot = np.zeros((len(rows), 3), dtype=np.float32)
    positions = {label: index for index, label in enumerate(AXIS_LABELS[axis])}
    for index, row in enumerate(rows):
        one_hot[index, positions[row["label"]]] = 1.0
    return one_hot


def fit(matrix: np.ndarray, one_hot: np.ndarray, l2: float) -> tuple[np.ndarray, np.ndarray]:
    rows = len(one_hot)
    weights = np.zeros((3, matrix.shape[1]), dtype=np.float32)
    bias = np.zeros(3, dtype=np.float32)
    for epoch in range(EPOCHS):
        logits = matrix @ weights.T + bias
        logits -= logits.max(axis=1, keepdims=True)
        exponents = np.exp(logits)
        probabilities = exponents / exponents.sum(axis=1, keepdims=True)
        gradient = (probabilities - one_hot) / rows
        rate = LEARNING_RATE / (1 + epoch * 0.01)
        weights -= rate * (gradient.T @ matrix + l2 * weights)
        bias -= rate * gradient.sum(axis=0)
    weights[np.abs(weights) < PRUNE_THRESHOLD] = 0.0
    return weights, bias


def logits_for(matrix: np.ndarray, weights: np.ndarray, bias: np.ndarray) -> np.ndarray:
    return matrix @ weights.T + bias


def probabilities(logits: np.ndarray, temperature: float) -> np.ndarray:
    scaled = logits / temperature
    scaled -= scaled.max(axis=1, keepdims=True)
    exponents = np.exp(scaled)
    return exponents / exponents.sum(axis=1, keepdims=True)


def axis_metrics(rows: list[dict], axis: str, vocab: dict[str, int],
                 weights: np.ndarray, bias: np.ndarray) -> dict:
    predicted = logits_for(design_matrix(rows, vocab), weights, bias).argmax(axis=1)
    confusion = Counter()
    correct = 0
    for row, index in zip(rows, predicted):
        guess = AXIS_LABELS[axis][int(index)]
        confusion[(row["label"], guess)] += 1
        correct += int(guess == row["label"])
    labels = AXIS_LABELS[axis]
    return {
        "rows": len(rows), "correct": correct, "accuracy": correct / max(1, len(rows)),
        "macroRecall": sum(confusion[(label, label)] /
                           max(1, sum(count for (expected, _), count in confusion.items()
                                      if expected == label)) for label in labels) / len(labels),
        "perClass": {label: {"correct": confusion[(label, label)],
                             "total": sum(count for (expected, _), count in confusion.items()
                                          if expected == label)} for label in labels},
    }


def calibration_loss(rows: list[dict], axis: str, vocab: dict[str, int],
                     weights: np.ndarray, bias: np.ndarray, temperature: float) -> tuple[float, float]:
    distribution = probabilities(logits_for(design_matrix(rows, vocab), weights, bias), temperature)
    positions = {label: index for index, label in enumerate(AXIS_LABELS[axis])}
    nll = 0.0
    brier = 0.0
    for row, values in zip(rows, distribution):
        expected = positions[row["label"]]
        nll -= math.log(max(1e-12, float(values[expected])))
        brier += sum((value - (1.0 if index == expected else 0.0)) ** 2
                     for index, value in enumerate(values))
    return float(nll) / max(1, len(rows)), float(brier) / max(1, len(rows))


def cross_validate(train: list[dict], vocab: dict[str, int], l2: float, folds: int = 5) -> float:
    # Folds are grouped by text WITHIN each axis. Grouping globally by text collapses the
    # per-axis class distribution (the 24 shared insufficient lines dominate every fold) and
    # produced a meaningless ~0.46 CV. Cross-axis reuse of a neutral line is not leakage:
    # each axis is a separate 3-class head.
    correct = 0
    total = 0
    for axis_index, axis in enumerate(AXES):
        axis_rows = [row for row in train if row["axis"] == axis]
        texts = sorted({row["text"] for row in axis_rows})
        random.Random(CV_SEED + axis_index).shuffle(texts)
        fold_of = {text: index % folds for index, text in enumerate(texts)}
        for fold in range(folds):
            fitting = [row for row in axis_rows if fold_of[row["text"]] != fold]
            checked = [row for row in axis_rows if fold_of[row["text"]] == fold]
            if not checked:
                continue
            weights, bias = fit(design_matrix(fitting, vocab), targets(fitting, axis), l2)
            predicted = logits_for(design_matrix(checked, vocab), weights, bias).argmax(axis=1)
            for row, index in zip(checked, predicted):
                correct += int(AXIS_LABELS[axis][int(index)] == row["label"])
                total += 1
    return correct / max(1, total)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=float, default=.90, help="held-out accuracy gate")
    parser.add_argument("--check", action="store_true", help="validate the shipped model, do not retrain")
    args = parser.parse_args()
    rows = load_corpus()
    train = [row for row in rows if row["split"] == "train"]
    validation = [row for row in rows if row["split"] == "validation"]
    test = [row for row in rows if row["split"] == "test"]

    if args.check:
        artifact = json.loads(MODEL.read_text(encoding="utf-8"))
        vocab_list = vocabulary(train)
        vocab = {gram: index for index, gram in enumerate(vocab_list)}
        combined = np.zeros((12, len(vocab)), dtype=np.float64)
        for gram, column in vocab.items():
            values = artifact["weights"].get(gram)
            if values:
                combined[:, column] = values
        bias = np.array(artifact["bias"], dtype=np.float64)
        per_axis = {}
        for axis_index, axis in enumerate(AXES):
            offset = axis_index * 3
            per_axis[axis] = axis_metrics([row for row in test if row["axis"] == axis], axis, vocab,
                                          combined[offset:offset + 3], bias[offset:offset + 3])
        overall = sum(item["correct"] for item in per_axis.values()) / len(test)
        print(json.dumps({"model": artifact["version"], "overall": overall,
                          "perAxis": per_axis}, ensure_ascii=False, indent=2))
        raise SystemExit(0 if overall >= args.target else 1)

    vocab_list = vocabulary(train)
    vocab = {gram: index for index, gram in enumerate(vocab_list)}
    cv = {l2: cross_validate(train, vocab, l2) for l2 in L2_GRID}
    selected_l2 = max(L2_GRID, key=lambda value: (cv[value], value))

    heads: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    temperatures: dict[str, float] = {}
    calibration: dict[str, dict] = {}
    for axis in AXES:
        axis_train = [row for row in train if row["axis"] == axis]
        axis_validation = [row for row in validation if row["axis"] == axis]
        weights, bias = fit(design_matrix(axis_train, vocab), targets(axis_train, axis), selected_l2)
        losses = {t: calibration_loss(axis_validation, axis, vocab, weights, bias, t)
                  for t in TEMPERATURES}
        temperatures[axis] = min(TEMPERATURES, key=lambda t: (losses[t][0], losses[t][1]))
        calibration[axis] = {str(t): {"nll": value[0], "brier": value[1]}
                             for t, value in losses.items()}
        heads[axis] = (weights, bias)

    combined = np.zeros((12, len(vocab_list)), dtype=np.float32)
    combined_bias = np.zeros(12, dtype=np.float32)
    for axis_index, axis in enumerate(AXES):
        offset = axis_index * 3
        weights, bias = heads[axis]
        combined[offset:offset + 3] = weights
        combined_bias[offset:offset + 3] = bias
    exported = {gram: [round(float(value), 6) for value in combined[:, column]]
                for column, gram in enumerate(vocab_list) if np.any(combined[:, column] != 0)}

    # Rebuild float64 weights from the rounded artifact so Python, --check and TypeScript agree.
    rebuilt = np.zeros((12, len(vocab_list)), dtype=np.float64)
    for gram, column in vocab.items():
        values = exported.get(gram)
        if values:
            rebuilt[:, column] = values
    bias64 = np.array([round(float(value), 6) for value in combined_bias], dtype=np.float64)
    validation_metrics = {}
    test_metrics = {}
    for axis_index, axis in enumerate(AXES):
        offset = axis_index * 3
        weights = rebuilt[offset:offset + 3]
        bias = bias64[offset:offset + 3]
        validation_metrics[axis] = axis_metrics([row for row in validation if row["axis"] == axis],
                                                axis, vocab, weights, bias)
        validation_metrics[axis]["nll"], validation_metrics[axis]["brier"] = \
            calibration_loss([row for row in validation if row["axis"] == axis], axis, vocab,
                             weights, bias, temperatures[axis])
        test_metrics[axis] = axis_metrics([row for row in test if row["axis"] == axis],
                                          axis, vocab, weights, bias)

    overall_validation = sum(item["correct"] for item in validation_metrics.values()) / len(validation)
    overall_test = sum(item["correct"] for item in test_metrics.values()) / len(test)
    digest = hashlib.sha256(CORPUS.read_bytes()).hexdigest()
    signature = hashlib.sha256(
        f"{digest}|{selected_l2}|{EPOCHS}|{PRUNE_THRESHOLD}|{FEATURE_SPEC}".encode()
    ).hexdigest()[:8]
    version = f"mbti-linear-v2-{signature}"

    artifact = {
        "version": version,
        "algorithm": "four-head-multinomial-logistic-regression",
        "features": FEATURE_SPEC,
        "corpusSha256": digest,
        "axes": list(AXES),
        "axisLabels": {axis: list(AXIS_LABELS[axis]) for axis in AXES},
        "axisOffsets": {axis: index * 3 for index, axis in enumerate(AXES)},
        "sizes": list(SIZES), "prefix": PREFIX, "suffix": SUFFIX,
        "temperatures": [temperatures[axis] for axis in AXES],
        "l2": selected_l2, "epochs": EPOCHS, "pruneThreshold": PRUNE_THRESHOLD,
        "bias": [round(float(value), 6) for value in combined_bias],
        "weights": exported,
        "vocabSize": len(vocab_list), "exportedGrams": len(exported),
        "trainRows": len(train), "validationAccuracy": overall_validation,
        "testAccuracy": overall_test,
    }
    MODEL.write_text(json.dumps(artifact, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {
        "version": version, "corpusSha256": digest,
        "rows": {"train": len(train), "validation": len(validation), "test": len(test)},
        "features": FEATURE_SPEC, "crossValidation": {str(l2): cv[l2] for l2 in L2_GRID},
        "selectedL2": selected_l2, "epochs": EPOCHS, "pruneThreshold": PRUNE_THRESHOLD,
        "temperatures": temperatures, "calibration": calibration,
        "vocabSize": len(vocab_list), "exportedGrams": len(exported),
        "validation": {"overall": overall_validation, "perAxis": validation_metrics},
        "test": {"overall": overall_test, "perAxis": test_metrics},
        "target": args.target, "passed": overall_test >= args.target,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"version": version, "rows": report["rows"], "selectedL2": selected_l2,
                      "temperatures": temperatures, "validation": overall_validation,
                      "test": overall_test, "perAxis": {axis: test_metrics[axis]["accuracy"]
                                                        for axis in AXES},
                      "target": args.target, "passed": report["passed"]},
                     ensure_ascii=False, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
