"""Train the small, dependency-free relationship classifier used to augment Laya.

The 322M-parameter Laya ONNX graph is fixed; this head learns only from the hand-authored corpus.
Features are character n-grams (1..4) with sublinear TF-IDF. The classifier is multinomial
logistic regression trained with Adam and inverse-frequency class weights. No scikit-learn or
SciPy dependency: only NumPy.

Usage:
  .venv/Scripts/python.exe scripts/train_relationship_classifier.py
  .venv/Scripts/python.exe scripts/train_relationship_classifier.py --final-test
  .venv/Scripts/python.exe scripts/train_relationship_classifier.py --export

Default never reads test metrics. `--final-test` is the one-shot release gate and also exports.
The model JSON is written to electron/laya/data/relationship-linear.json.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "tests" / "fixtures" / "laya-affinity-corpus.jsonl"
OUTPUT = ROOT / "electron" / "laya" / "data" / "relationship-linear.json"
LABELS = ("romantic", "warm", "neutral", "distant", "rejecting")
# Target score band midpoint used only for the affinity MAE report.
TARGETS = {"romantic": 92, "warm": 74, "neutral": 50, "distant": 34, "rejecting": 7}


def load_rows():
    rows = [json.loads(line) for line in CORPUS.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit("empty corpus")
    return rows


def normalize(text: str) -> str:
    return "".join(text.strip().lower().split())


def ngrams(text: str):
    padded = f"^{text}$"
    counts = Counter()
    for size in range(1, 5):
        for index in range(0, len(padded) - size + 1):
            counts[padded[index:index + size]] += 1
    return counts


def fit_vectorizer(texts):
    document_frequency = Counter()
    for text in texts:
        document_frequency.update(ngrams(normalize(text)).keys())
    # Every feature seen in training remains available; the corpus is small enough.
    vocabulary = {feature: index for index, feature in enumerate(sorted(document_frequency))}
    count = len(texts)
    idf = np.array([
        math.log((1 + count) / (1 + document_frequency[feature])) + 1
        for feature in vocabulary
    ], dtype=np.float64)

    def transform(values):
        matrix = np.zeros((len(values), len(vocabulary)), dtype=np.float64)
        for row_index, value in enumerate(values):
            for feature, frequency in ngrams(normalize(value)).items():
                column = vocabulary.get(feature)
                if column is not None:
                    matrix[row_index, column] = 1 + math.log(frequency)
            matrix[row_index] *= idf
            norm = np.linalg.norm(matrix[row_index])
            if norm:
                matrix[row_index] /= norm
        return matrix

    return vocabulary, idf, transform


def softmax(logits):
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def train_logistic(X, y, *, learning_rate=0.12, epochs=700, l2=1e-3, seed=17):
    rng = np.random.default_rng(seed)
    classes = len(LABELS)
    samples, features = X.shape
    # Balanced class weights stop the positive-enriched train split from dominating.
    counts = np.bincount(y, minlength=classes).astype(np.float64)
    class_weights = samples / (classes * np.maximum(1, counts))
    sample_weights = class_weights[y]
    weights = rng.normal(0, 0.01, size=(features, classes))
    bias = np.zeros(classes)
    first_moment_w = np.zeros_like(weights)
    second_moment_w = np.zeros_like(weights)
    first_moment_b = np.zeros_like(bias)
    second_moment_b = np.zeros_like(bias)
    beta1, beta2, epsilon = 0.9, 0.999, 1e-8
    target = np.eye(classes)[y]
    for step in range(1, epochs + 1):
        probabilities = softmax(X @ weights + bias)
        weighted_error = (probabilities - target) * sample_weights[:, None]
        gradient_w = X.T @ weighted_error / samples + l2 * weights
        gradient_b = weighted_error.mean(axis=0)
        first_moment_w = beta1 * first_moment_w + (1 - beta1) * gradient_w
        second_moment_w = beta2 * second_moment_w + (1 - beta2) * gradient_w ** 2
        first_moment_b = beta1 * first_moment_b + (1 - beta1) * gradient_b
        second_moment_b = beta2 * second_moment_b + (1 - beta2) * gradient_b ** 2
        correction1 = 1 - beta1 ** step
        correction2 = 1 - beta2 ** step
        weights -= learning_rate * (first_moment_w / correction1) / (
            np.sqrt(second_moment_w / correction2) + epsilon)
        bias -= learning_rate * (first_moment_b / correction1) / (
            np.sqrt(second_moment_b / correction2) + epsilon)
    return weights, bias


def predict(X, weights, bias):
    probabilities = softmax(X @ weights + bias)
    indices = probabilities.argmax(axis=1)
    return indices, probabilities


def report(name, y, probabilities, indices):
    confusion = np.zeros((len(LABELS), len(LABELS)), dtype=int)
    for expected, actual in zip(y, indices):
        confusion[expected, actual] += 1
    recalls = []
    for index in range(len(LABELS)):
        total = confusion[index].sum()
        recalls.append(float(confusion[index, index] / total) if total else 0.0)
    scores = probabilities @ np.array([TARGETS[label] for label in LABELS])
    mae = float(np.abs(scores - np.array([TARGETS[LABELS[index]] for index in y])).mean())
    print(f"\n{name}: n={len(y)} accuracy={np.mean(indices == y):.4f} "
          f"macroRecall={np.mean(recalls):.4f} MAE={mae:.3f}")
    print("expected\\actual " + " ".join(label[:6].rjust(8) for label in LABELS))
    for index, label in enumerate(LABELS):
        print(label[:15].ljust(16) + " ".join(str(value).rjust(8) for value in confusion[index]))
    print("recall " + " ".join(f"{label[:6]}={recalls[i]:.3f}" for i, label in enumerate(LABELS)))
    return {
        "n": len(y), "accuracy": float(np.mean(indices == y)),
        "macroRecall": float(np.mean(recalls)), "mae": mae,
        "recall": dict(zip(LABELS, recalls)),
        "confusion": confusion.tolist(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--final-test", action="store_true",
                        help="evaluate the frozen test split once and export the model")
    parser.add_argument("--export", action="store_true", help="write the model JSON")
    parser.add_argument("--epochs", type=int, default=700)
    args = parser.parse_args()

    rows = load_rows()
    train = [row for row in rows if row["split"] == "train"]
    validation = [row for row in rows if row["split"] == "validation"]
    test = [row for row in rows if row["split"] == "test"]
    label_index = {label: index for index, label in enumerate(LABELS)}
    y_train = np.array([label_index[row["label"]] for row in train])
    y_validation = np.array([label_index[row["label"]] for row in validation])
    y_test = np.array([label_index[row["label"]] for row in test])

    # Validation chooses only L2 strength. Test is untouched unless --final-test.
    best = None
    for l2 in (0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1):
        vocabulary, idf, transform = fit_vectorizer([row["text"] for row in train])
        X_train = transform([row["text"] for row in train])
        X_validation = transform([row["text"] for row in validation])
        weights, bias = train_logistic(X_train, y_train, epochs=args.epochs, l2=l2)
        indices, probabilities = predict(X_validation, weights, bias)
        accuracy = float(np.mean(indices == y_validation))
        # Macro recall is the tie-breaker because train is deliberately positive-enriched.
        recalls = []
        for index in range(len(LABELS)):
            mask = y_validation == index
            recalls.append(float(np.mean(indices[mask] == index)) if mask.any() else 0.0)
        macro = float(np.mean(recalls))
        print(f"l2={l2:<8} validation accuracy={accuracy:.4f} macroRecall={macro:.4f}")
        if best is None or (macro, accuracy) > (best["macro"], best["accuracy"]):
            best = {"l2": l2, "macro": macro, "accuracy": accuracy,
                    "vocabulary": vocabulary, "idf": idf, "weights": weights, "bias": bias}
    if best is None:
        raise SystemExit("no model trained")
    print(f"\nselected l2={best['l2']} by validation macroRecall")
    vocabulary = best["vocabulary"]
    idf = best["idf"]
    transform = fit_vectorizer([row["text"] for row in train])[2]

    # Refit the selected setting on train + validation for the release artifact.
    combined = train + validation
    y_combined = np.array([label_index[row["label"]] for row in combined])
    vocabulary, idf, transform = fit_vectorizer([row["text"] for row in combined])
    X_combined = transform([row["text"] for row in combined])
    weights, bias = train_logistic(X_combined, y_combined, epochs=args.epochs, l2=best["l2"])
    print(f"final fit: {len(combined)} train+validation rows, {len(vocabulary)} features")

    result = {"selectedL2": best["l2"], "rows": {"train": len(train), "validation": len(validation),
              "test": len(test)}, "features": len(vocabulary)}
    if args.final_test:
        X_test = transform([row["text"] for row in test])
        indices, probabilities = predict(X_test, weights, bias)
        result["test"] = report("TEST (one-shot)", y_test, probabilities, indices)
        accuracy = result["test"]["accuracy"]
        if accuracy < 0.9:
            print(f"\nRELEASE GATE FAILED: test accuracy {accuracy:.1%} < 90%")
            return 1
    elif args.export:
        print("warning: --export without --final-test has not passed the frozen test gate")

    if args.final_test or args.export:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": "relationship-linear-v1",
            "labels": list(LABELS),
            "ngram": [1, 4],
            "idf": [float(value) for value in idf],
            "vocabulary": {feature: int(index) for feature, index in vocabulary.items()},
            "weights": weights.tolist(),
            "bias": bias.tolist(),
            "training": result,
        }
        OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
        print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
