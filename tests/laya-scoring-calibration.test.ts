// Offline regression for the calibrated affinity head (electron/laya/scoring.ts).
//
// The head turns a sequence of per-message relationship distributions into one 0..100 score. It
// never loads the model: these tests pin the aggregation contract (anchors, recency, reliability
// weighting, monotonicity) plus the scenario table reproduced by scripts/laya-score-eval.ts.
import assert from "node:assert/strict";
import { it } from "node:test";

import {
  AFFINITY_CALIBRATION,
  affinityFromSignals,
  affinityFromScores,
  messageScore,
  recencyWeights,
  relationshipConfidence,
  type MessageSignal,
} from "../electron/laya/scoring";

const LABELS = ["romantic", "warm", "neutral", "distant", "rejecting"] as const;

function dist(mass: Partial<Record<(typeof LABELS)[number], number>>): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const label of LABELS) {
    const value = mass[label] ?? 0;
    out[label] = value;
    total += value;
  }
  for (const label of LABELS) out[label] = out[label]! / total;
  return out;
}

const repeat = (d: Record<string, number>, n: number): MessageSignal[] =>
  Array.from({ length: n }, () => ({ relationship: { ...d } }));

const oneHot = (label: (typeof LABELS)[number]): Record<string, number> =>
  Object.fromEntries(LABELS.map((key) => [key, key === label ? 1 : 0]));

const ARCHETYPE = {
  plain: dist({ neutral: 0.78, warm: 0.12, distant: 0.06, romantic: 0.02, rejecting: 0.02 }),
  warm: dist({ neutral: 0.46, warm: 0.42, distant: 0.05, romantic: 0.06, rejecting: 0.01 }),
  flirty: dist({ neutral: 0.24, warm: 0.34, romantic: 0.36, distant: 0.04, rejecting: 0.02 }),
  romantic: dist({ neutral: 0.14, warm: 0.22, romantic: 0.60, distant: 0.03, rejecting: 0.01 }),
  cool: dist({ neutral: 0.44, warm: 0.08, distant: 0.42, romantic: 0.01, rejecting: 0.05 }),
  reject: dist({ neutral: 0.20, warm: 0.03, distant: 0.22, romantic: 0.01, rejecting: 0.54 }),
  unsure: dist({ neutral: 0.24, warm: 0.20, distant: 0.20, romantic: 0.18, rejecting: 0.18 }),
};

it("keeps the weight anchors exact", () => {
  assert.equal(affinityFromSignals([]).affinity, 50, "no evidence is neutral");
  assert.equal(affinityFromSignals(repeat(oneHot("neutral"), 10)).affinity, 50, "neutral is 50");
  assert.equal(affinityFromSignals(repeat(oneHot("warm"), 10)).affinity, 78, "warm keeps 0.55");
  assert.equal(affinityFromSignals(repeat(oneHot("romantic"), 10)).affinity, 100);
  // -0.45·50 = 27.5; the exact float is 27.4999…, so accept either side of the .5 boundary.
  assert.ok(Math.abs(affinityFromSignals(repeat(oneHot("distant"), 10)).affinity - 28) <= 1,
    "distant keeps -0.45");
  assert.equal(affinityFromSignals(repeat(oneHot("rejecting"), 10)).affinity, 0);
});

it("decays recency exponentially from the newest message", () => {
  assert.deepEqual(recencyWeights(0), []);
  assert.deepEqual(recencyWeights(1), [1]);
  const weights = recencyWeights(41);
  assert.equal(weights.length, 41);
  assert.equal(weights.at(-1), 1, "newest message has full weight");
  assert.ok(weights[0]! < 0.07, "40 messages back is worth far less than the newest");
  const half = recencyWeights(AFFINITY_CALIBRATION.halfLifeMessages + 1);
  assert.ok(Math.abs(half[0]! - 0.5) < 1e-12, "one half-life back is half weight");
  const descending = recencyWeights(30);
  for (let i = 1; i < descending.length; i++) assert.ok(descending[i]! >= descending[i - 1]!);
});

it("lets recent evidence outweigh equally sized older evidence", () => {
  const warmingUp = affinityFromSignals([...repeat(ARCHETYPE.cool, 20), ...repeat(ARCHETYPE.romantic, 20)]);
  const coolingDown = affinityFromSignals([...repeat(ARCHETYPE.romantic, 20), ...repeat(ARCHETYPE.cool, 20)]);
  assert.ok(warmingUp.affinity > coolingDown.affinity + 20,
    `recent romance must dominate: ${warmingUp.affinity} vs ${coolingDown.affinity}`);
});

it("treats a near-uniform answer as no evidence", () => {
  assert.ok(relationshipConfidence(ARCHETYPE.unsure) < 0.1);
  assert.ok(Math.abs(relationshipConfidence(oneHot("romantic")) - 1) < 1e-12);
  assert.equal(relationshipConfidence({}), 0);
  const base = affinityFromSignals(repeat(ARCHETYPE.flirty, 40)).affinity;
  const padded = affinityFromSignals([...repeat(ARCHETYPE.flirty, 40), ...repeat(ARCHETYPE.unsure, 20)]).affinity;
  assert.ok(Math.abs(padded - base) <= 10, `uniform noise must not move the score much: ${base} -> ${padded}`);
  // 40 uniform answers outnumber the 40 informative ones; the score may drop but must stay well
  // above the neutral prior, which is where an unweighted mean would land.
  const drowned = affinityFromSignals([...repeat(ARCHETYPE.flirty, 40), ...repeat(ARCHETYPE.unsure, 40)]).affinity;
  assert.ok(drowned >= 55, `signal must survive an equal mass of uniform answers: ${drowned}`);
});

it("moves monotonically with added evidence", () => {
  const base = repeat(ARCHETYPE.warm, 30);
  const baseScore = affinityFromSignals(base).affinity;
  assert.ok(affinityFromSignals([...base, ...repeat(ARCHETYPE.reject, 3)]).affinity < baseScore);
  assert.ok(affinityFromSignals([...base, ...repeat(ARCHETYPE.romantic, 3)]).affinity > baseScore);
  assert.ok(affinityFromSignals([...base, ...repeat(ARCHETYPE.plain, 3)]).affinity <= baseScore,
    "neutral filler must never raise the score");
});

it("is deterministic and idempotent", () => {
  const signals = [...repeat(ARCHETYPE.cool, 30), ...repeat(ARCHETYPE.flirty, 10)];
  const first = affinityFromSignals(signals);
  const second = affinityFromSignals(signals.map((signal) => ({ relationship: { ...signal.relationship } })));
  assert.deepEqual(first, second);
  assert.equal(affinityFromScores([]).affinity, 50);
});

it("reproduces the calibrated scenario table", () => {
  const cases: Array<[string, MessageSignal[], [number, number]]> = [
    ["cold", repeat(ARCHETYPE.cool, 20), [20, 42]],
    ["plain", repeat(ARCHETYPE.plain, 40), [40, 58]],
    ["polite", repeat(ARCHETYPE.warm, 40), [54, 70]],
    ["flirty", repeat(ARCHETYPE.flirty, 40), [68, 88]],
    ["romance", repeat(ARCHETYPE.romantic, 30), [80, 100]],
    ["reject_recent", [...repeat(ARCHETYPE.warm, 40), ...repeat(ARCHETYPE.reject, 5)], [28, 55]],
    ["one_reject_long", [...repeat(ARCHETYPE.warm, 120), ...repeat(ARCHETYPE.reject, 1)], [48, 68]],
    ["noisy", [...repeat(ARCHETYPE.warm, 40), ...repeat(ARCHETYPE.unsure, 40)], [54, 70]],
    ["recovering", [...repeat(ARCHETYPE.cool, 30), ...repeat(ARCHETYPE.romantic, 10)], [58, 88]],
  ];
  for (const [name, signals, band] of cases) {
    const score = affinityFromSignals(signals).affinity;
    assert.ok(score >= band[0] && score <= band[1],
      `${name} scored ${score}, expected ${band[0]}..${band[1]}`);
  }
  // The two scenarios the flat 0.5..1.0 recency ramp got wrong: a fresh rejection after a friendly
  // stretch, and a conversation that turned romantic late. v1 scored 57 and 55 — both in the wrong
  // UI band (友善默契 / 初识相知).
  assert.equal(affinityFromSignals([...repeat(ARCHETYPE.warm, 40), ...repeat(ARCHETYPE.reject, 5)]).affinity, 50);
  assert.equal(affinityFromSignals([...repeat(ARCHETYPE.cool, 30), ...repeat(ARCHETYPE.romantic, 10)]).affinity, 66);
});

it("keeps the raw per-message score uncalibrated for display and the API classifier", () => {
  assert.equal(messageScore({ relationship: oneHot("warm") }), 0.55);
  assert.equal(messageScore({ relationship: oneHot("neutral") }), 0);
  assert.equal(messageScore({ relationship: oneHot("rejecting") }), -1);
});
