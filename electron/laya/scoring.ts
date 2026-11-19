// Written for this project (not vendored).
//
// Entertainment scoring. Pure and dependency-free so it can be unit tested without the model.
// - Affinity uses the model's RELATIONSHIP distribution only (romantic / warm / neutral /
//   distant / rejecting), and only for OTHER-side messages. Emotion is display-only, so sadness
//   or anxiety cannot by itself lower affection.
// - The self-quality grade uses the model's SELF-QUALITY distribution, mapped deterministically
//   to SSS/SS/S/A/B/C/D with the documented weights and thresholds below.
// No keyword rules, no random scores, no hidden rejection caps.
//
// Calibrated aggregation (v2)
// ---------------------------
// v1 aggregated the raw expectation Σ p_r·w_r with a flat linear recency ramp (0.5 → 1.0) and
// treated every message as equally reliable. Two defects are reproducible offline with
// `scripts/laya-score-eval.ts`:
//
//   1. Inertia. With the 0.5 → 1.0 ramp the oldest message in a history keeps half the weight of
//      the newest, so a conversation that changed direction barely moves: 40 friendly messages
//      followed by 5 explicit rejections still scored 57 (友善默契), and 30 cool messages
//      followed by 10 romantic ones scored 55. The score described the whole archive, not the
//      current state the UI labels it as.
//   2. Dilution. A near-uniform decode contributed exactly as much as a confident one, so
//      ambiguous filler messages pulled every conversation back toward the neutral prior.
//
// The v2 head keeps the anchors (neutral → 50, warm → 78, romantic → 100, rejecting → 0) and
// changes only the weighting: exponential recency with a message half-life for defect 1, and a
// distance-from-uniform confidence multiplier for defect 2. The half-life lives in
// `AFFINITY_CALIBRATION`.
//
// A third candidate — an interior contrast expansion (power, anchors fixed) meant to widen the
// compressed mid-range — was measured and rejected: it does not change which semantic band a
// scenario lands in, but pushes a purely `warm` conversation from 78 to 80 (gain 1.15) and 84
// (gain 1.5), i.e. across the UI's 80-point boundary into 亲密无间. Numbers and the grid search
// are in `docs/laya-scoring-calibration.md`.

import { RELATIONSHIP_WEIGHT, SELF_QUALITY_WEIGHT } from "./options";

/** Per-message model output used for affinity: relationship label -> probability. */
export interface MessageSignal {
  relationship: Record<string, number>;
}

/** A relationship label chosen by the model. */
export type RelationshipLabel = keyof typeof RELATIONSHIP_WEIGHT;

/**
 * Tunable parameters of the affinity head. `version` is bumped whenever any value changes so a
 * stored score can be traced back to the parameters that produced it.
 *
 * - `halfLifeMessages` a message this many positions older than the newest keeps half its weight.
 *
 * There is deliberately no weight floor and no reliability floor. Both were tried and measured
 * (`scripts/laya-score-eval.ts --grid`): a floor re-introduces exactly the history inertia the
 * recalibration removes, and it makes the aggregate depend on the total message count, which the
 * incremental Python accumulator cannot reproduce without extra state. With pure exponential
 * decay the persisted score and this one stay identical by construction.
 */
export const AFFINITY_CALIBRATION = {
  version: "affinity-v2",
  halfLifeMessages: 8,
} as const;

/** Label order of the relationship question; the reliability measure uses exactly these classes. */
const RELATIONSHIP_LABELS = Object.keys(RELATIONSHIP_WEIGHT) as RelationshipLabel[];

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Normalizes a probability map to sum 1; all-nonpositive input becomes empty. */
function normalize(probabilities: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [label, p] of Object.entries(probabilities)) {
    if (Number.isFinite(p) && p > 0) {
      out[label] = p;
      sum += p;
    }
  }
  if (sum <= 0) return {};
  for (const label of Object.keys(out)) out[label] = out[label]! / sum;
  return out;
}

function weightedSum(
  probabilities: Record<string, number>,
  weights: Record<string, number>,
): number {
  let sum = 0;
  for (const [label, p] of Object.entries(normalize(probabilities))) {
    const w = weights[label];
    if (typeof w === "number") sum += p * w;
  }
  return sum;
}

/** Highest-probability label after normalization; undefined for an empty map. */
export function argmaxLabel(probabilities: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestP = -Infinity;
  for (const [label, p] of Object.entries(probabilities)) {
    if (Number.isFinite(p) && p > bestP) {
      bestP = p;
      best = label;
    }
  }
  return best;
}

/** Mean label -> probability map over per-message signals. */
export function meanDistribution(signals: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (signals.length === 0) return out;
  for (const signal of signals) {
    for (const [label, p] of Object.entries(signal)) {
      out[label] = (out[label] ?? 0) + p / signals.length;
    }
  }
  return out;
}

/**
 * Single-message contribution in [-1, 1]:
 *
 *   messageScore = Σ_r P(relationship=r) * weight(r)
 *
 * with the normalized relationship distribution and `RELATIONSHIP_WEIGHT` in [-1, 1]. Emotion
 * probabilities are intentionally ignored here.
 *
 * This is the raw expectation and is what the per-message views and the API portrait classifier
 * compare against; the aggregation below only reweights these values, it never rescales them.
 */
export function messageScore(signal: MessageSignal): number {
  return clamp(weightedSum(signal.relationship, RELATIONSHIP_WEIGHT), -1, 1);
}

/**
 * How far the answer is from "no opinion", in [0, 1]: the total-variation distance to the uniform
 * distribution over the five relationship classes, rescaled so the maximum possible distance
 * (one-hot) maps to 1.
 *
 * A uniform answer scores 0, a one-hot answer scores 1. Used as the reliability multiplier so a
 * near-uniform answer cannot outvote an informative one. An empty map scores 0.
 *
 * Total variation is used instead of `1 - H/log(5)` on purpose: entropy rates a genuinely mixed
 * but informative answer (for example 0.36 romantic / 0.34 warm / 0.24 neutral) as "unsure",
 * because it only looks at peakiness. Distance from uniform keeps such an answer at ~0.43 while
 * a near-uniform decode sits at ~0.05, which is the separation the multiplier needs.
 */
export function relationshipConfidence(probabilities: Record<string, number>): number {
  const p = normalize(probabilities);
  if (Object.keys(p).length === 0) return 0;
  const uniform = 1 / RELATIONSHIP_LABELS.length;
  let distance = 0;
  for (const label of RELATIONSHIP_LABELS) distance += Math.abs((p[label] ?? 0) - uniform);
  // Σ|p - u| peaks at 2·(1 - 1/k) for a one-hot answer.
  const maxDistance = 2 * (1 - uniform);
  return clamp(distance / maxDistance, 0, 1);
}

/**
 * Recency weights over `n` messages (oldest first): pure exponential decay from the newest
 * message, `0.5 ** (age / halfLife)`. A single message gets weight 1.
 *
 * v1 used a linear 0.5 → 1.0 ramp, which gave the oldest message in a long history half the
 * weight of the newest one — i.e. almost no recency at all.
 */
export function recencyWeights(
  n: number,
  halfLife = AFFINITY_CALIBRATION.halfLifeMessages,
): number[] {
  if (n <= 0) return [];
  if (n === 1) return [1];
  const half = halfLife > 0 ? halfLife : Number.POSITIVE_INFINITY;
  return Array.from({ length: n }, (_, i) => 0.5 ** ((n - 1 - i) / half));
}

export interface AffinityResult {
  /** Integer 0..100; 50 (neutral) when there are no scores. */
  affinity: number;
  /** Recency- and reliability-weighted mean per-message score in [-1, 1]. */
  weightedScore: number;
}

/**
 * Entertainment affinity over per-message signals (already filtered to OTHER-side messages by the
 * caller):
 *
 *   w_m           = recency(m) · confidence(m)
 *   weightedScore = Σ score_m · w_m / Σ w_m             ([-1, 1])
 *   affinity      = round(50 + 50 · weightedScore)      ([0, 100], 50 when empty)
 *
 * `confidence` is `relationshipConfidence`, so a maximally uniform answer contributes nothing and
 * a one-hot answer contributes its full recency weight. The half-life was selected on the
 * labelled corpus validation split; test was used once for the final comparison only.
 *
 * There is deliberately NO blending with a previous value here: the caller sends the full
 * history every time, so a repeated identical request is idempotent. `delta` is computed by the
 * caller as `affinity - previousAffinity` (0 when no previous is given).
 */
export function affinityFromSignals(signals: readonly MessageSignal[]): AffinityResult {
  if (signals.length === 0) return { affinity: 50, weightedScore: 0 };
  const weights = recencyWeights(signals.length);
  let numerator = 0;
  let denominator = 0;
  signals.forEach((signal, i) => {
    const w = weights[i]! * relationshipConfidence(signal.relationship);
    numerator += messageScore(signal) * w;
    denominator += w;
  });
  const weightedScore = denominator === 0 ? 0 : numerator / denominator;
  return { affinity: Math.round(50 + 50 * clamp(weightedScore, -1, 1)), weightedScore };
}

/**
 * Numeric variant of `affinityFromSignals` for callers that only kept the per-message score
 * (`messageScore` output) and not the distribution. Confidence correction is unavailable there,
 * so every score counts as fully reliable; the recency decay still applies, which keeps the two
 * entry points on the same scale.
 */
export function affinityFromScores(scores: readonly number[]): AffinityResult {
  if (scores.length === 0) return { affinity: 50, weightedScore: 0 };
  const weights = recencyWeights(scores.length);
  let numerator = 0;
  let denominator = 0;
  scores.forEach((score, i) => {
    const w = weights[i]!;
    numerator += (Number.isFinite(score) ? clamp(score, -1, 1) : 0) * w;
    denominator += w;
  });
  const weightedScore = denominator === 0 ? 0 : numerator / denominator;
  return { affinity: Math.round(50 + 50 * clamp(weightedScore, -1, 1)), weightedScore };
}

/** Letter band for the 0..100 affinity (the affinity grade, NOT the self-performance grade). */
export function gradeFor(affinity: number): string {
  if (affinity >= 85) return "S";
  if (affinity >= 70) return "A";
  if (affinity >= 58) return "B";
  if (affinity >= 45) return "C";
  if (affinity >= 32) return "D";
  return "E";
}

export const NO_SELF_GRADE = "—";

/**
 * Deterministic self-quality score in [0, 1] from the model's SELF-QUALITY distribution:
 *
 *   score = Σ_c P(class=c) * SELF_QUALITY_WEIGHT(c)
 *
 * with SELF_QUALITY_WEIGHT = { connected: 1.0, empathic: 0.9, "off topic": 0.3,
 * pressuring: 0.15, offensive: 0.0 }. Empty input scores 0.
 */
export function selfQualityScore(probabilities: Record<string, number>): number {
  return clamp(weightedSum(probabilities, SELF_QUALITY_WEIGHT), 0, 1);
}

/**
 * Deterministic self-quality grade from the score in [0, 1]:
 *
 *   SSS >= 0.90   SS >= 0.80   S >= 0.68   A >= 0.55   B >= 0.42   C >= 0.28   D < 0.28
 */
export function selfQualityGrade(score: number): string {
  if (score >= 0.9) return "SSS";
  if (score >= 0.8) return "SS";
  if (score >= 0.68) return "S";
  if (score >= 0.55) return "A";
  if (score >= 0.42) return "B";
  if (score >= 0.28) return "C";
  return "D";
}

/**
 * Fixed next-step sentence chosen by a deterministic rule over the aggregate model output.
 * The model does not generate free text; it only selects which fixed line is shown.
 *
 * `dominantRelationship` / `dominantIntent` are taken from the LATEST OTHER-side message, so the
 * advice follows the most recent signal. `selfQualityClass` is the raw self-quality argmax class.
 * Precedence: self behaviour problems first, then rejection/distance, then the latest intent,
 * then default. The overall `affinity` is intentionally NOT used here: a stale low history score
 * must not mask a fresh make-plan / seek-comfort signal. Kept as the first parameter for
 * signature compatibility.
 */
export function nextStepFor(
  _affinity: number,
  dominantRelationship?: string,
  dominantIntent?: string,
  selfQualityClass?: string,
): string {
  if (selfQualityClass === "offensive" || selfQualityClass === "pressuring") {
    return "先停止给对方压力，换成更轻松的回应";
  }
  if (dominantRelationship === "rejecting" || dominantIntent === "reject") {
    return "先接住拒绝信号，放慢节奏，不要追问";
  }
  if (dominantRelationship === "distant" || dominantIntent === "distance") {
    return "降低推进速度，先回到轻松话题";
  }
  switch (dominantIntent) {
    case "seek comfort":
      return "先共情，再给建议";
    case "give comfort":
      return "接住对方的好意，真诚回应";
    case "flirt":
      return "可以顺势给出明确而克制的回应";
    case "make plan":
      return "把时间和细节定下来";
    case "ask question":
      return "直接回答对方的问题，别绕";
  }
  if (dominantRelationship === "romantic") {
    return "可以顺势给出明确而克制的回应";
  }
  return "自然一点，保持稳定回应";
}
