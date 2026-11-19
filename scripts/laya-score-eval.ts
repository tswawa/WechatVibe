// Calibration + before/after evaluation for the local Laya affinity head.
//
//   npx tsx scripts/laya-score-eval.ts            # fit + compare v1 (legacy) vs v2 (current)
//   npx tsx scripts/laya-score-eval.ts --json     # machine-readable output
//
// WHAT THIS MEASURES
// ------------------
// The affinity score is `50 + 50 * weighted mean of per-message relationship scores`. The model
// produces the per-message relationship distribution; the head (electron/laya/scoring.ts) turns a
// sequence of those distributions into one integer. This script evaluates THE HEAD, not the
// classifier: it feeds hand-authored distribution archetypes ("what a message of this kind
// typically looks like") through both the old and the new aggregation and compares the results
// against the five stages the UI actually renders (score / 20 -> 素昧平生 .. 亲密无间).
//
// The archetypes are a documented prior, not measured model output. To calibrate against real
// output, replace `SCENARIOS` with distributions captured from a real session (see
// `scripts/test-model.ts` for the inference harness). Until then, treat the numbers below as
// "does the head reproduce the intended ordering and range", not as "the model is X% accurate".

import {
  AFFINITY_CALIBRATION,
  affinityFromSignals,
  messageScore,
  relationshipConfidence,
  type MessageSignal,
} from "../electron/laya/scoring";
import { RELATIONSHIP_WEIGHT } from "../electron/laya/options";

// ---------------------------------------------------------------------------------------------
// Rejected candidate: interior contrast expansion.
//
// `expand(e, gain) = sign(e)·|e|^(1/gain)` stretches the mid-range while pinning -1/0/1 and is
// exactly the identity at gain = 1. It was evaluated as a fix for the compressed interior and
// rejected: it never changed a semantic band, but it pushed a purely `warm` conversation from 78
// to 80 at gain 1.15 and to 84 at gain 1.5 — across the UI's 80-point boundary. Kept here so the
// rejection stays reproducible; the production head does not use it.
// ---------------------------------------------------------------------------------------------

function expand(expectation: number, gain: number): number {
  const e = Math.max(-1, Math.min(1, expectation));
  if (gain <= 0 || gain === 1) return e;
  return Math.sign(e) * Math.abs(e) ** (1 / gain);
}

// ---------------------------------------------------------------------------------------------
// Legacy (v1) head, kept verbatim so the comparison is apples-to-apples.
// ---------------------------------------------------------------------------------------------

function recencyWeightsV1(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => 0.5 + (0.5 * i) / (n - 1));
}

function affinityFromScoresV1(scores: number[]): number {
  if (scores.length === 0) return 50;
  const weights = recencyWeightsV1(scores.length);
  let numerator = 0;
  let denominator = 0;
  scores.forEach((score, i) => {
    const w = weights[i]!;
    numerator += Math.max(-1, Math.min(1, score)) * w;
    denominator += w;
  });
  return Math.round(50 + 50 * (denominator === 0 ? 0 : numerator / denominator));
}

const affinityV1 = (signals: MessageSignal[]): number =>
  affinityFromScoresV1(signals.map((signal) => messageScore(signal)));

// ---------------------------------------------------------------------------------------------
// Distribution archetypes.
// ---------------------------------------------------------------------------------------------

type Dist = Record<string, number>;

/** Builds a distribution from label -> mass, renormalising so the numbers stay readable. */
function dist(mass: Partial<Dist>): Dist {
  const out: Dist = {};
  let total = 0;
  for (const label of Object.keys(RELATIONSHIP_WEIGHT)) {
    const value = mass[label] ?? 0;
    out[label] = value;
    total += value;
  }
  for (const label of Object.keys(out)) out[label] = out[label]! / total;
  return out;
}

const ARCHETYPE = {
  /** Ordinary logistics / small talk: the classifier's dominant neutral prior. */
  plain: dist({ neutral: 0.78, warm: 0.12, distant: 0.06, romantic: 0.02, rejecting: 0.02 }),
  /** Friendly but not flirty. */
  warm: dist({ neutral: 0.46, warm: 0.42, distant: 0.05, romantic: 0.06, rejecting: 0.01 }),
  /** Clear mutual interest. */
  flirty: dist({ neutral: 0.24, warm: 0.34, romantic: 0.36, distant: 0.04, rejecting: 0.02 }),
  /** Overt romantic signalling. */
  romantic: dist({ neutral: 0.14, warm: 0.22, romantic: 0.60, distant: 0.03, rejecting: 0.01 }),
  /** Cooling off. */
  cool: dist({ neutral: 0.44, warm: 0.08, distant: 0.42, romantic: 0.01, rejecting: 0.05 }),
  /** Explicit refusal. */
  reject: dist({ neutral: 0.20, warm: 0.03, distant: 0.22, romantic: 0.01, rejecting: 0.54 }),
  /** Low-confidence answer: near-uniform, as an uncertain decode actually looks. */
  unsure: dist({ neutral: 0.24, warm: 0.20, distant: 0.20, romantic: 0.18, rejecting: 0.18 }),
} satisfies Record<string, Dist>;

const repeat = (d: Dist, n: number): MessageSignal[] =>
  Array.from({ length: n }, () => ({ relationship: { ...d } }));

const seq = (...parts: Array<[Dist, number]>): MessageSignal[] =>
  parts.flatMap(([d, n]) => repeat(d, n));

// ---------------------------------------------------------------------------------------------
// Scenarios. `stage` is the UI band the scenario should land in (score / 20).
// ---------------------------------------------------------------------------------------------

interface Scenario {
  id: string;
  note: string;
  /** Inclusive score band this scenario is expected to land in. */
  band: [number, number];
  /** Higher = should score higher; used for the ordinal check. `null` = excluded from ranking. */
  rank: number | null;
  /** Part of the fitting split; the rest is holdout. */
  fit: boolean;
  signals: MessageSignal[];
}

const SCENARIOS: Scenario[] = [
  { id: "empty", note: "没有对方消息", band: [50, 50], rank: null, fit: false, signals: [] },
  { id: "cold", note: "20 条冷淡/客套", band: [20, 42], rank: 1, fit: true,
    signals: seq([ARCHETYPE.cool, 20]) },
  { id: "plain", note: "40 条普通闲聊", band: [40, 58], rank: 2, fit: true,
    signals: seq([ARCHETYPE.plain, 40]) },
  { id: "polite", note: "40 条友好但不暧昧", band: [54, 70], rank: 3, fit: true,
    signals: seq([ARCHETYPE.warm, 40]) },
  { id: "flirty", note: "40 条明显暧昧", band: [68, 88], rank: 5, fit: true,
    signals: seq([ARCHETYPE.flirty, 40]) },
  { id: "romance", note: "30 条热恋", band: [80, 100], rank: 6, fit: true,
    signals: seq([ARCHETYPE.romantic, 30]) },
  { id: "reject_recent", note: "40 条友好后 5 条明确拒绝", band: [28, 55], rank: 0, fit: true,
    signals: seq([ARCHETYPE.warm, 40], [ARCHETYPE.reject, 5]) },
  { id: "one_reject_long", note: "120 条友好里只有 1 条拒绝", band: [48, 68], rank: 2.5, fit: true,
    signals: seq([ARCHETYPE.warm, 120], [ARCHETYPE.reject, 1]) },
  { id: "noisy", note: "40 条友好 + 40 条低置信噪声", band: [54, 70], rank: null, fit: false,
    signals: seq([ARCHETYPE.warm, 40], [ARCHETYPE.unsure, 40]) },
  { id: "mixed", note: "忽冷忽热交替", band: [40, 65], rank: 3.5, fit: false,
    signals: seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]).concat(
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1]),
      seq([ARCHETYPE.romantic, 1], [ARCHETYPE.cool, 1])) },
  { id: "single_warm", note: "只有 1 条友好消息", band: [58, 82], rank: null, fit: false,
    signals: seq([ARCHETYPE.warm, 1]) },
  { id: "recovering", note: "30 条冷淡后转 10 条热恋", band: [58, 88], rank: 4, fit: false,
    signals: seq([ARCHETYPE.cool, 30], [ARCHETYPE.romantic, 10]) },
];

// ---------------------------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------------------------

interface Score {
  id: string;
  v1: number;
  v2: number;
  band: [number, number];
  rank: number | null;
}

function inBand(score: number, [lo, hi]: [number, number]): boolean {
  return score >= lo && score <= hi;
}

/** Fraction of pairs whose relative order matches the expected ranking. */
function ordinalAccuracy(rows: Score[]): number {
  const ranked = rows.filter((row) => row.rank !== null);
  let correct = 0;
  let total = 0;
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      if (a.rank === b.rank) continue;
      total++;
      const expected = a.rank < b.rank ? a.v2 < b.v2 : a.v2 > b.v2;
      if (expected) correct++;
    }
  }
  return total === 0 ? 1 : correct / total;
}

function ordinalAccuracyV1(rows: Score[]): number {
  const ranked = rows.filter((row) => row.rank !== null);
  let correct = 0;
  let total = 0;
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      if (a.rank === b.rank) continue;
      total++;
      const expected = a.rank < b.rank ? a.v1 < b.v1 : a.v1 > b.v1;
      if (expected) correct++;
    }
  }
  return total === 0 ? 1 : correct / total;
}

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

const stdev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};

/** How far one appended block moves the score (responsiveness to fresh evidence). */
function sensitivity(base: Scenario, extra: Dist, count: number): number {
  const before = affinityFromSignals(base.signals).affinity;
  const after = affinityFromSignals([...base.signals, ...repeat(extra, count)]).affinity;
  return after - before;
}

function sensitivityV1(base: Scenario, extra: Dist, count: number): number {
  const before = affinityV1(base.signals);
  const after = affinityV1([...base.signals, ...repeat(extra, count)]);
  return after - before;
}

// ---------------------------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------------------------

function evaluate(): { rows: Score[]; fitRows: Score[]; holdoutRows: Score[] } {
  const rows: Score[] = SCENARIOS.map((scenario) => ({
    id: scenario.id,
    v1: affinityV1(scenario.signals),
    v2: affinityFromSignals(scenario.signals).affinity,
    band: scenario.band,
    rank: scenario.rank,
  }));
  const fitIds = new Set(SCENARIOS.filter((s) => s.fit).map((s) => s.id));
  return {
    rows,
    fitRows: rows.filter((row) => fitIds.has(row.id)),
    holdoutRows: rows.filter((row) => !fitIds.has(row.id)),
  };
}

function report(): void {
  const { rows, fitRows, holdoutRows } = evaluate();
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const body = rows.filter((row) => row.id !== "empty");
  const bodyV1 = body.map((row) => row.v1);
  const bodyV2 = body.map((row) => row.v2);

  const pad = (value: string | number, width: number): string => String(value).padEnd(width);
  console.log(`\n亲和度评分头标定 ${AFFINITY_CALIBRATION.version}`);
  console.log(`  halfLife=${AFFINITY_CALIBRATION.halfLifeMessages}\n`);

  console.log(`${pad("场景", 16)}${pad("说明", 30)}${pad("期望区间", 12)}${pad("v1", 6)}${pad("v2", 6)}  命中`);
  console.log("-".repeat(78));
  for (const row of rows) {
    const scenario = byId.get(row.id)!;
    const hitV1 = inBand(row.v1, row.band) ? "✓" : "✗";
    const hitV2 = inBand(row.v2, row.band) ? "✓" : "✗";
    console.log(
      `${pad(row.id, 16)}${pad(scenario.note, 30)}` +
      `${pad(`${row.band[0]}–${row.band[1]}`, 12)}${pad(row.v1, 6)}${pad(row.v2, 6)}  ${hitV1}→${hitV2}`,
    );
  }

  const hit = (list: Score[], pick: "v1" | "v2"): string =>
    `${list.filter((row) => inBand(row[pick], row.band)).length}/${list.length}`;

  console.log("\n指标");
  console.log(`  区间命中率 (全部)      v1 ${hit(rows, "v1")}   v2 ${hit(rows, "v2")}`);
  console.log(`  区间命中率 (拟合集)    v1 ${hit(fitRows, "v1")}   v2 ${hit(fitRows, "v2")}`);
  console.log(`  区间命中率 (留出集)    v1 ${hit(holdoutRows, "v1")}   v2 ${hit(holdoutRows, "v2")}`);
  console.log(`  排序一致率 (pairwise)  v1 ${(ordinalAccuracyV1(rows) * 100).toFixed(1)}%   ` +
    `v2 ${(ordinalAccuracy(rows) * 100).toFixed(1)}%`);
  console.log(`  有效分数跨度           v1 ${(Math.max(...bodyV1) - Math.min(...bodyV1))}   ` +
    `v2 ${(Math.max(...bodyV2) - Math.min(...bodyV2))}`);
  console.log(`  标准差                 v1 ${stdev(bodyV1).toFixed(2)}   v2 ${stdev(bodyV2).toFixed(2)}`);

  const polite = byId.get("polite")!;
  const flirty = byId.get("flirty")!;
  console.log("\n敏感度 / 稳定性");
  console.log(`  友好会话追加 3 条明确拒绝   v1 ${sensitivityV1(polite, ARCHETYPE.reject, 3)}   ` +
    `v2 ${sensitivity(polite, ARCHETYPE.reject, 3)}`);
  console.log(`  暧昧会话追加 20 条低置信噪声 v1 ${sensitivityV1(flirty, ARCHETYPE.unsure, 20)}   ` +
    `v2 ${sensitivity(flirty, ARCHETYPE.unsure, 20)}`);
  console.log(`  普通闲聊追加 20 条普通闲聊   v1 ${sensitivityV1(byId.get("plain")!, ARCHETYPE.plain, 20)}   ` +
    `v2 ${sensitivity(byId.get("plain")!, ARCHETYPE.plain, 20)}`);

  console.log("\n被否决的方案：内部对比度拉伸（anchors 固定，中段放大）");
  console.log("  原始期望    gain=1.0    gain=1.15   gain=1.5    （单条消息得分）");
  for (const e of [-1, -0.3, 0, 0.3, 0.55, 1]) {
    const scores = [1, 1.15, 1.5].map((gain) =>
      Math.round(50 + 50 * expand(e, gain)));
    console.log(`  ${String(e).padEnd(10)}${String(scores[0]).padEnd(10)}` +
      `${String(scores[1]).padEnd(11)}${String(scores[2]).padEnd(10)}`);
  }
  console.log("  → gain>1 不改变任何场景的语义档位，却把纯 warm 从 78 推到 80（gain 1.15）乃至 84（gain 1.5），越过 80 分档，故不采用。\n");

  console.log("示例分布的原始期望与可靠度");
  for (const [name, d] of Object.entries(ARCHETYPE)) {
    console.log(`  ${name.padEnd(9)} E[w]=${messageScore({ relationship: d }).toFixed(3).padStart(6)}  ` +
      `reliability=${relationshipConfidence(d).toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Grid search over the one shipped numeric parameter: the recency half-life. Contrast gain,
// weight floors and reliability floors were evaluated and rejected (see scoring.ts); keeping
// them out of this table makes the search match production instead of a superset.
// ---------------------------------------------------------------------------------------------

function gridSearch(): void {
  const halfLives = [4, 6, 8, 10, 12, 16, 24, 60, 100000];

  interface Row { halfLife: number;
    fitHit: number; holdHit: number; spread: number; sensitivity: number; stability: number }
  const results: Row[] = [];
  const scoreWith = (signals: MessageSignal[], halfLife: number): number => {
    if (signals.length === 0) return 50;
    let num = 0;
    let den = 0;
    signals.forEach((signal, i) => {
      const age = signals.length - 1 - i;
      const wi = 0.5 ** (age / halfLife) * relationshipConfidence(signal.relationship);
      num += messageScore(signal) * wi;
      den += wi;
    });
    return Math.round(50 + 50 * Math.max(-1, Math.min(1, den === 0 ? 0 : num / den)));
  };

  for (const halfLife of halfLives) {
    const fit = SCENARIOS.filter((s) => s.fit);
    const holdout = SCENARIOS.filter((s) => !s.fit);
    const hitOf = (list: Scenario[]): number =>
      list.filter((s) => {
        const score = scoreWith(s.signals, halfLife);
        return score >= s.band[0] && score <= s.band[1];
      }).length / list.length;
    const scores = SCENARIOS.filter((s) => s.id !== "empty")
      .map((s) => scoreWith(s.signals, halfLife));
    const polite = SCENARIOS.find((s) => s.id === "polite")!;
    const flirty = SCENARIOS.find((s) => s.id === "flirty")!;
    const sens = scoreWith([...polite.signals, ...repeat(ARCHETYPE.reject, 3)], halfLife) -
      scoreWith(polite.signals, halfLife);
    const stab = scoreWith([...flirty.signals, ...repeat(ARCHETYPE.unsure, 20)], halfLife) -
      scoreWith(flirty.signals, halfLife);
    results.push({ halfLife, fitHit: hitOf(fit), holdHit: hitOf(holdout),
      spread: Math.max(...scores) - Math.min(...scores), sensitivity: sens, stability: stab });
  }

  const objective = (row: Row): number =>
    row.fitHit * 100 + row.holdHit * 40 + Math.min(12, Math.abs(row.sensitivity)) * 1.5
    - Math.abs(row.stability) * 2;

  results.sort((a, b) => objective(b) - objective(a));
  console.log("\n半衰期搜索（拟合集 8 个场景，留出集 4 个场景）");
  console.log("  halfLife 拟合命中  留出命中  跨度  敏感度  稳定性  目标值");
  for (const row of results) {
    console.log(`  ${String(row.halfLife).padEnd(9)}${row.fitHit.toFixed(2).padEnd(10)}` +
      `${row.holdHit.toFixed(2).padEnd(10)}${String(row.spread).padEnd(6)}` +
      `${String(row.sensitivity).padEnd(8)}${String(row.stability).padEnd(8)}` +
      `${objective(row).toFixed(1)}`);
  }
}

report();
if (process.argv.includes("--grid")) gridSearch();
