// Train and validate the Laya affinity head on the synthetic corpus.
//
//   npx tsx scripts/laya-score-train.ts --dry-run
//   npx tsx scripts/laya-score-train.ts
//   npx tsx scripts/laya-score-train.ts --json
//   npx tsx scripts/laya-score-train.ts --provider=webgpu  # GPU (Windows WebGPU)
//   npx tsx scripts/laya-score-train.ts --provider=cpu     # explicit CPU fallback
//
// CUDA note: onnxruntime-node's Windows package ships CPU, DirectML and WebGPU only. CUDA is
// Linux-only in that binding, and the upstream graph fails DirectML's Reshape probe. WebGPU is
// therefore the supported GPU path here; `cuda` is rejected with an explicit message.
// The default provider is `auto` (WebGPU first on Windows, CPU fallback). Set
// LAYA_TRAIN_PROVIDER or pass --provider=cpu to force the CPU path.
//
// The ONNX classifier is fixed (no training-side repository). "Training" here means selecting
// the relationship prompt and the recency half-life against a labelled corpus, then confirming
// the selected pair on validation and a held-out test split. The test split is never used to pick
// a candidate; it is decoded only for the winner and the v1 baseline.
//
// All rows go through LayaAgent.predictBatch, but the default batch size is 1 so every row is
// decoded in exactly the same shaped forward pass as the legacy per-row script. Measured on
// 120 rows (see docs/laya-scoring-calibration.md §7): packing 16 rows is only 1.3-1.9x faster
// on WebGPU and CHANGES 3/120 answers (max probability delta 0.103); on CPU it is 0.76x, i.e.
// slower. LAYA_TRAIN_BATCH_SIZE > 1 is therefore a preview-only knob, never a report default.
// The real, lossless speedups are the GPU provider and decoding fewer rows (stage A/B split).
import { readFileSync } from "node:fs";
import path from "node:path";

import { LayaAgent } from "../electron/laya/agent";
import { buildTargetState } from "../electron/laya/context";
import {
  ANALYSIS_QUESTIONS, FINE_DISPLAY_QUESTIONS, RELATIONSHIP_INSTRUCTIONS, RELATIONSHIP_OPTIONS,
  SELF_QUALITY_QUESTIONS,
} from "../electron/laya/options";
import { buildPrefix } from "../electron/laya/prompt";
import { toInternal } from "../electron/laya/questions";
import { NodeOnnxRunner } from "../electron/laya/runner";
import { messageScore, relationshipConfidence, type MessageSignal } from "../electron/laya/scoring";
import { LayaTokenizer } from "../electron/laya/tokenizer";
import type { AgentConfig, Batch, Question } from "../electron/laya/types";

type Label = "rejecting" | "distant" | "neutral" | "warm" | "romantic";
type Split = "train" | "validation" | "test";
interface CorpusCase { id: string; text: string; label: Label; target: number; split: Split }
interface Observed extends CorpusCase { distribution: Record<string, number>; score: number; choice: string }

const BANDS: Record<Label, [number, number]> = {
  rejecting: [0, 30],
  distant: [20, 50],
  neutral: [40, 60],
  warm: [58, 85],
  romantic: [80, 100],
};

const BASELINE =
  "From the sender of the TARGET message toward the recipient, what relationship signal does " +
  "the TARGET message carry? Choose romantic for clear romantic interest, warm for friendly " +
  "affection, neutral for ordinary or task talk, distant for cooling off or emotional " +
  "distance, and rejecting for an explicit refusal or push-away.";

const GUARDRAILS =
  "Classify the relationship signal from the TARGET sender toward the recipient. romantic means " +
  "clear romantic interest or courtship, including a romantic question. warm means friendly " +
  "affection, gratitude, or enjoyable interaction. neutral means ordinary information, logistics, " +
  "reminders, confirmations, requests, or task talk, even when brief. distant means reduced " +
  "engagement or emotional distance without an explicit refusal. rejecting means an explicit " +
  "refusal, push-away, or request to stop contact. Do not treat brevity, a request, or a question " +
  "as rejection.";

const PRECISE =
  BASELINE + " A message is neutral unless it contains an interpersonal signal; routine " +
  "confirmations, reminders, logistics, requests, and statements are neutral even if terse. " +
  "Rejecting requires an explicit refusal or push-away; postponing or being busy is distant, not " +
  "rejecting. A romantic invitation or question is romantic.";

/** Frozen copy of relationship-v2, kept so the current prompt can be compared against it. */
const PRODUCTION_V2 =
  "判断 TARGET 发送者对接收者传达的关系信号。romantic=明确的爱慕、恋爱意向或暧昧（包括求爱的问题）；" +
  "warm=友善、感谢、愉快互动；neutral=普通事实、事务、提醒、确认或请求，即使语气简短也不代表冷淡；" +
  "distant=疏离、敷衍或减少互动，但没有明确拒绝；rejecting=明确拒绝、推开对方或要求停止联系。" +
  "不要仅因句子短、是请求或是疑问句就判为 rejecting。" +
  "按顺序判断：只有明确拒绝、推开对方或要求停止联系才选 rejecting；明确表达爱慕、恋爱意向或求爱才选 " +
  "romantic；普通问答、事务、提醒和简短确认一律 neutral；介于热情与拒绝之间、表现为减少互动的才选 distant。";

/** The live prompt (relationship-v2). Kept as the reference the other candidates are measured against. */
const PRODUCTION = RELATIONSHIP_INSTRUCTIONS;

/**
 * The relationship-v3 candidate: v2 + the implicit-affection rule. On the 280-row corpus it beat v2
 * on all five train/validation metrics, but on the frozen test split it scored 45% classification /
 * 12.00 MAE against v2's 55% / 11.60 — the rule over-fires on unseen logistics requests
 * ("你到了给我发个位置。" → romantic 81). Kept as the record of a rejected candidate.
 */
const IMPLICIT_ROMANCE = PRODUCTION_V2 +
  "含蓄示爱也算 romantic：邀请一起过节或单独约会、问对方是否愿意在一起、描述心动思念或想长久陪伴、" +
  "把对方放在特别位置，都是 romantic；只有感谢、鼓励、愉快这类社交礼貌才是 warm。";

const HARD_REJECT = PRODUCTION_V2 +
  "即使没有“拒绝”二字，宣告关系结束（我们结束了、到此为止）、要求对方从自己的生活里消失、" +
  "要求不必再解释或不必再问，都属于 rejecting。";

const SPACE_REQUEST = PRODUCTION_V2 +
  "要求暂停联系、要求冷静或留出空间、要求以后不要再提某个话题、表示最近不想聊天，都属于 distant，" +
  "不要判成 neutral。";

const PURE_LOGISTICS = PRODUCTION_V2 +
  "纯事务通知（延误、改期、地址、密码、提醒、状态更新）即使句子很短、语气平淡，也一律 neutral，" +
  "不要因为简短判成 distant。";

const BOUNDARY_ALL = PRODUCTION_V2 +
  "边界补充：宣告关系结束或要求对方消失、不必再解释属于 rejecting；要求暂停联系、冷静、留空间、" +
  "以后别再提某个话题属于 distant；纯事务通知和状态更新即使简短也属于 neutral；" +
  "邀请约会或过节、问对方是否愿意在一起、描述心动思念或想长久陪伴属于 romantic，" +
  "只有感谢、鼓励、愉快这类社交礼貌才是 warm。";

/**
 * Compact rewrite covering the same four boundaries as BOUNDARY_ALL, but within the head budget.
 * `head_max_len` (256) is shared by instruction + options and v2 already spends 176 + 10, so a
 * rule appended past ~245 tokens is cut off the tail and never reaches the model.
 */
const COMPACT_V3 =
  "判断 TARGET 发送者对接收者传达的关系信号。rejecting=拒绝、推开、要求停止联系、宣告关系结束" +
  "（我们结束了、请从我的生活里消失、不必再解释）；distant=要求冷静或空间、减少互动、以后别再提某话题，" +
  "但没有明确拒绝；neutral=事务、提醒、确认、请求、状态更新，句子再短也属此类；" +
  "romantic=表白、心动、思念、想长久陪伴、邀请单独约会或过节、问对方是否愿意在一起，含蓄示爱也算；" +
  "warm=感谢、鼓励、愉快互动等不含爱慕的友善。" +
  "先判 rejecting，再判 distant，再判 neutral，最后区分 romantic 与 warm：句中有心动对象、" +
  "共同未来或求爱意图即为 romantic。";

/**
 * Per-option glosses. `warm` absorbs every affectionate message (even "我爱你" decodes as warm
 * 77), so the option line itself was the lever tested.
 *
 * NOT a valid result: the glosses take 106 option tokens, which drops the instruction budget from
 * 256 to 150 and silently halves the instruction. Any future criteria dictionary has to be priced
 * against `--budget` first.
 */
const CRITERIA_GLOSS: Record<string, string> = {
  romantic: "明确的爱慕、心动、思念、求爱或恋爱邀请，包括含蓄示爱和邀请单独过节",
  warm: "友善、感谢、鼓励、愉快互动，不含爱慕或心动",
  neutral: "普通事实、事务、提醒、确认、请求或状态更新",
  distant: "疏离、敷衍、减少互动、要求空间或冷静，但没有明确拒绝",
  rejecting: "明确拒绝、推开对方、要求停止联系或宣告关系结束",
};

/** Checklist rewrite. Also truncated once paired with glosses; kept only as a record. */
const CHECKLIST_V3 =
  "判断 TARGET 发送者对接收者传达的关系信号。逐条对照，命中即选：" +
  "rejecting=拒绝对方、要求停止联系、宣告关系结束（如“我们结束了”“请从我的生活里消失”）；" +
  "distant=要求冷静或留出空间、减少互动、以后别再提某话题，但没有明确拒绝；" +
  "neutral=事务通知、提醒、确认、请求、状态更新，再短也属此类；" +
  "romantic=表白、心动、思念、想长久陪伴、邀请单独约会或过节、问对方是否愿意在一起；" +
  "warm=感谢、鼓励、愉快互动、社交礼貌，不含爱慕或心动。" +
  "先判 rejecting，再判 distant，再判 neutral，最后在 romantic 与 warm 之间选：只要句子里有心动的对象、" +
  "未来的共同想象或求爱意图，就是 romantic。";

/** Exclusive-warm rule: an affectionate sentence must not stay warm just because it is also polite. */
const NO_WARM_AFFECTION = PRODUCTION_V2 +
  "warm 不得用于含爱慕、心动、思念、想在一起或求爱意图的句子；这类句子即使同时带有感谢、关心或愉快，" +
  "也一律 romantic。warm 只用于没有爱慕成分的友善、感谢、鼓励与愉快互动。";

/** Position-bias probe: same instructions, options listed from coldest to warmest. */
const REVERSED_ORDER = ["rejecting", "distant", "neutral", "warm", "romantic"];

interface Variant { name: string; instructions: string; criteria?: Record<string, string> }

const VARIANTS: Variant[] = [
  { name: "baseline", instructions: BASELINE },
  { name: "production", instructions: PRODUCTION },
  { name: "implicit-romance", instructions: IMPLICIT_ROMANCE },
  { name: "hard-reject", instructions: HARD_REJECT },
  { name: "space-request", instructions: SPACE_REQUEST },
  { name: "pure-logistics", instructions: PURE_LOGISTICS },
  { name: "no-warm-affection", instructions: NO_WARM_AFFECTION },
  { name: "compact-v3", instructions: COMPACT_V3 },
  { name: "order-reversed", instructions: PRODUCTION_V2, criteria: Object.fromEntries(
    REVERSED_ORDER.map((label) => [label, null])) as Record<string, string> },
  { name: "boundary-all", instructions: BOUNDARY_ALL },
];

const HALF_LIVES = [4, 6, 8, 10, 12, 16, 24];
const CORPUS_PATH = path.resolve("tests/fixtures/laya-affinity-corpus.jsonl");
/**
 * Per-label row count in each split. Mirrors `tests/laya-affinity-corpus.test.ts`.
 * Warm/romantic are intentionally positive-enriched on train/validation; test stays 4/class.
 */
const EXPECTED: Record<Split, Record<Label, number>> = {
  train: { rejecting: 84, distant: 88, neutral: 86, warm: 120, romantic: 117 },
  validation: { rejecting: 24, distant: 24, neutral: 24, warm: 32, romantic: 32 },
  test: { rejecting: 60, distant: 60, neutral: 60, warm: 60, romantic: 60 },
};

function loadCorpus(): CorpusCase[] {
  const rows = readFileSync(CORPUS_PATH, "utf8").split(/\r?\n/u).filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as Partial<CorpusCase>;
      if (typeof value.id !== "string" || typeof value.text !== "string" ||
          !(value.label && value.label in BANDS) || typeof value.target !== "number" ||
          !(value.split && ["train", "validation", "test"].includes(value.split))) {
        throw new Error(`invalid corpus row ${index + 1}`);
      }
      return value as CorpusCase;
    });
  const ids = new Set<string>();
  const text = new Set<string>();
  const count = new Map<string, number>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate corpus id: ${row.id}`);
    if (text.has(row.text)) throw new Error(`duplicate corpus text: ${row.text}`);
    ids.add(row.id);
    text.add(row.text);
    const key = `${row.split}:${row.label}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  for (const split of ["train", "validation", "test"] as const)
    for (const label of Object.keys(BANDS) as Label[])
      if ((count.get(`${split}:${label}`) ?? 0) !== EXPECTED[split][label])
        throw new Error(`unbalanced corpus: ${split}/${label}`);
  return rows;
}

function splitCounts(rows: CorpusCase[]): Record<Split, number> {
  return {
    train: rows.filter((row) => row.split === "train").length,
    validation: rows.filter((row) => row.split === "validation").length,
    test: rows.filter((row) => row.split === "test").length,
  };
}

function errors(rows: Observed[]) {
  return rows.filter((row) => row.choice !== row.label).map((row) =>
    ({ id: row.id, text: row.text, expected: row.label, got: row.choice, score: row.score }));
}

function metrics(rows: Observed[]) {
  const hits = rows.filter((row) => {
    const [low, high] = BANDS[row.label];
    return row.score >= low && row.score <= high;
  }).length;
  const correct = rows.filter((row) => row.choice === row.label).length;
  const mae = rows.reduce((sum, row) => sum + Math.abs(row.score - row.target), 0) / rows.length;
  // Train/validation deliberately over-represent warm/romantic. Raw accuracy would reward the
  // majority classes, so prompt selection uses macro averages over the five labels instead.
  const labels = Object.keys(BANDS) as Label[];
  const perLabel = labels.map((label) => {
    const slice = rows.filter((row) => row.label === label);
    return {
      n: slice.length,
      bandHit: slice.filter((row) => row.score >= BANDS[label][0] && row.score <= BANDS[label][1]).length /
        Math.max(1, slice.length),
      recall: slice.filter((row) => row.choice === label).length / Math.max(1, slice.length),
    };
  });
  return {
    n: rows.length,
    bandHit: hits / rows.length,
    accuracy: correct / rows.length,
    macroBandHit: perLabel.reduce((sum, row) => sum + row.bandHit, 0) / labels.length,
    macroRecall: perLabel.reduce((sum, row) => sum + row.recall, 0) / labels.length,
    mae,
  };
}

function scoreSignals(signals: MessageSignal[], halfLife: number): number {
  if (!signals.length) return 50;
  let numerator = 0;
  let denominator = 0;
  signals.forEach((signal, index) => {
    const age = signals.length - 1 - index;
    const weight = 0.5 ** (age / halfLife) * relationshipConfidence(signal.relationship);
    numerator += messageScore(signal) * weight;
    denominator += weight;
  });
  return Math.round(50 + 50 * Math.max(-1, Math.min(1, denominator ? numerator / denominator : 0)));
}

/** Legacy head: flat 0.5 → 1.0 linear ramp, every answer equally reliable. */
function scoreSignalsV1(signals: MessageSignal[]): number {
  if (!signals.length) return 50;
  let numerator = 0;
  let denominator = 0;
  signals.forEach((signal, index) => {
    const weight = signals.length === 1 ? 1 : 0.5 + 0.5 * index / (signals.length - 1);
    numerator += messageScore(signal) * weight;
    denominator += weight;
  });
  return Math.round(50 + 50 * Math.max(-1, Math.min(1, denominator ? numerator / denominator : 0)));
}

/** Ten short conversations built from corpus rows of the named labels. */
const SCENARIOS: Array<{ id: string; parts: Array<[Label, number]>; band: [number, number] }> = [
  { id: "warm-then-reject", parts: [["warm", 12], ["rejecting", 6]], band: [20, 48] },
  { id: "neutral-then-romance", parts: [["neutral", 12], ["romantic", 8]], band: [75, 100] },
  { id: "warm-distant-mixed", parts: [["warm", 10], ["distant", 10]], band: [35, 65] },
  { id: "neutral-only", parts: [["neutral", 12]], band: [40, 60] },
  { id: "warm-only", parts: [["warm", 12]], band: [58, 85] },
  { id: "distant-only", parts: [["distant", 12]], band: [20, 50] },
  { id: "romance-then-distance", parts: [["romantic", 12], ["distant", 4]], band: [50, 82] },
  { id: "long-warm-recent-reject", parts: [["warm", 24], ["rejecting", 3]], band: [30, 58] },
  { id: "late-romance", parts: [["distant", 12], ["romantic", 8]], band: [65, 95] },
  { id: "reject-only", parts: [["rejecting", 12]], band: [0, 25] },
];

function scenarioSignals(parts: Array<[Label, number]>, byLabel: Map<Label, Observed[]>): MessageSignal[] {
  return parts.flatMap(([label, count]) => {
    const rows = byLabel.get(label)!;
    return Array.from({ length: count }, (_, index) =>
      ({ relationship: rows[index % rows.length]!.distribution }));
  });
}

function legacyScenarioTable(observed: Observed[]) {
  const byLabel = new Map<Label, Observed[]>();
  for (const label of Object.keys(BANDS) as Label[])
    byLabel.set(label, observed.filter((row) => row.label === label));
  const scores = SCENARIOS.map((scenario) => {
    const score = scoreSignalsV1(scenarioSignals(scenario.parts, byLabel));
    const [low, high] = scenario.band;
    return { id: scenario.id, score, hit: score >= low && score <= high,
      distance: score < low ? low - score : score > high ? score - high : 0 };
  });
  return { halfLife: 0, hit: scores.filter((row) => row.hit).length / scores.length,
    loss: scores.reduce((sum, row) => sum + row.distance, 0), scores };
}

function parameterTable(observed: Observed[]) {
  const byLabel = new Map<Label, Observed[]>();
  for (const label of Object.keys(BANDS) as Label[])
    byLabel.set(label, observed.filter((row) => row.label === label));
  return HALF_LIVES.map((halfLife) => {
    const scores = SCENARIOS.map((scenario) => {
      const score = scoreSignals(scenarioSignals(scenario.parts, byLabel), halfLife);
      const [low, high] = scenario.band;
      return { id: scenario.id, score, hit: score >= low && score <= high,
        distance: score < low ? low - score : score > high ? score - high : 0 };
    });
    return { halfLife, hit: scores.filter((row) => row.hit).length / scores.length,
      loss: scores.reduce((sum, row) => sum + row.distance, 0), scores };
  });
}

function fmt(value: number): string { return value.toFixed(3); }

/**
 * The scenario table has 10 entries, so a hit-rate tie is a 10%-granularity tie: several half-lives
 * routinely land on the same score and the "prefer longer" rule then decides on noise. Say so
 * instead of presenting the pick as a measurement.
 */
function halfLifeTieNote(rows: Array<{ halfLife: number; hit: number }>, selected: { halfLife: number; hit: number }): string {
  const tied = rows.filter((row) => row.hit === selected.hit).map((row) => row.halfLife);
  if (tied.length < 3) return "";
  return `（${tied.join("/")} 在验证集同分，10 个场景的分辨率是 10%，半衰期并未真正被区分；` +
    `生产值以 scripts/laya-score-eval.ts 的噪声场景为准）`;
}

/**
 * Token accounting for the instruction head. `head_max_len` is shared by the instruction and the
 * options, and `buildPrefix` cuts the instruction from the tail without complaining, so a rule
 * appended past the budget never reaches the model.
 */
function headBudget(tokenizer: LayaTokenizer, question: Question, headMaxLen: number) {
  const internal = toInternal(question);
  const head = tokenizer.encode(`${internal.t} question: ${internal.ins.replaceAll(tokenizer.maskToken, " ")}`);
  const prefix = buildPrefix(tokenizer, internal, headMaxLen);
  // markers[0] = 1 (CLS) + kept head + 1 (SEP)
  const kept = prefix.markers[0]! - 2;
  return { chars: question.instructions.length, head: head.length, kept,
    options: prefix.ids.length - prefix.markers[0]! - 1, truncated: kept < head.length };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");
  const budget = process.argv.includes("--budget");
  // `--json` must stay machine-readable: status lines go to stderr instead of stdout.
  const status = (message: string) => { if (json) console.error(message); else console.log(message); };
  const startedAt = Date.now();
  const corpus = loadCorpus();
  const counts = splitCounts(corpus);
  if (dryRun) {
    for (const split of ["train", "validation", "test"] as const) {
      const expected = (Object.keys(BANDS) as Label[])
        .reduce((sum, label) => sum + EXPECTED[split][label], 0);
      if (corpus.filter((row) => row.split === split).length !== expected)
        throw new Error(`${split} must contain ${expected} rows`);
    }
    const counts = splitCounts(corpus);
    console.log(`语料 ${corpus.length} 条；train ${counts.train} / validation ${counts.validation} / ` +
      `test ${counts.test}；候选提示词 ${VARIANTS.length} 个`);
    return;
  }
  if (budget) {
    // The instruction head is truncated to whatever `head_max_len` leaves after the options, and
    // the cut is silent: a rule appended past the budget never reaches the model.
    const dir = path.resolve(process.env.LAYA_MODEL_DIR ?? ".models/laya");
    const config = JSON.parse(readFileSync(path.join(dir, "rl_agent_config.json"), "utf8")) as AgentConfig;
    const tokenizer = new LayaTokenizer(
      JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer.json"), "utf8")),
      JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer_config.json"), "utf8")),
    );
    console.log(`head_max_len ${config.head_max_len}；指令超出即从尾部静默截断`);
    console.log("提示词             字符   head token  指令保留  选项 token  截断");
    for (const variant of VARIANTS) {
      const row = headBudget(tokenizer, {
        type: "choice",
        instructions: variant.instructions,
        criteria: variant.criteria ? { ...variant.criteria } : [...RELATIONSHIP_OPTIONS],
      }, config.head_max_len);
      console.log(`${variant.name.padEnd(19)}${String(row.chars).padEnd(6)}` +
        `${String(row.head).padEnd(12)}${String(row.kept).padEnd(10)}` +
        `${String(row.options).padEnd(11)}${row.truncated ? "是" : ""}`);
    }
    console.log("\n现网题目（同一预算）：");
    for (const [name, question] of Object.entries({
      ...ANALYSIS_QUESTIONS, ...FINE_DISPLAY_QUESTIONS, ...SELF_QUALITY_QUESTIONS,
    })) {
      const row = headBudget(tokenizer, question, config.head_max_len);
      console.log(`${name.padEnd(19)}${String(row.chars).padEnd(6)}` +
        `${String(row.head).padEnd(12)}${String(row.kept).padEnd(10)}` +
        `${String(row.options).padEnd(11)}${row.truncated ? "是" : ""}`);
    }
    return;
  }

  const providerArg = process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1]
    ?? process.env.LAYA_TRAIN_PROVIDER ?? "auto";
  if (providerArg === "cuda")
    throw new Error("onnxruntime-node 的 Windows 包不支持 CUDA；请用 --provider=webgpu（Linux 可换 CUDA 版运行时）");
  if (!["cpu", "gpu", "webgpu", "auto"].includes(providerArg))
    throw new Error(`unsupported --provider: ${providerArg}`);
  const provider = (providerArg === "gpu" ? "webgpu" : providerArg) as "cpu" | "webgpu" | "auto";
  const dir = path.resolve(process.env.LAYA_MODEL_DIR ?? ".models/laya");
  const config = JSON.parse(readFileSync(path.join(dir, "rl_agent_config.json"), "utf8")) as AgentConfig;
  const tokenizer = new LayaTokenizer(
    JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer_config.json"), "utf8")),
  );
  const runner = await NodeOnnxRunner.create(path.join(dir, "model.onnx"), { executionProvider: provider });
  status(`推理后端：${runner.provider}${provider === "webgpu" ? " (GPU)" : ""}`);

  // Keep one row per forward pass by default. A larger batch pads every row to the longest
  // sequence in the chunk; on this graph that changes WebGPU logits and is slower on CPU.
  // Preview runs may raise it, but the resulting numbers are not comparable to reports.
  const batchSize = Number(process.env.LAYA_TRAIN_BATCH_SIZE ?? 1);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128)
    throw new Error(`invalid LAYA_TRAIN_BATCH_SIZE: ${batchSize}`);
  if (batchSize > 1)
    status(`警告：LAYA_TRAIN_BATCH_SIZE=${batchSize} 会改变 padding 与 WebGPU 数值，` +
      `仅用于预览，不可与逐行报告比较`);
  let runCount = 0;
  let decodedRows = 0;
  const countingRunner = {
    run: (batch: Batch) => { runCount += 1; return runner.run(batch); },
  };
  const agent = new LayaAgent({ config, tokenizer, runner: countingRunner, batchSize });

  const trainOnly = process.argv.includes("--train-only");
  const selectArg = process.argv.find((arg) => arg.startsWith("--select="))?.split("=")[1];
  // Smoke-test knob: take at most N rows PER LABEL from each split. Stratified so the scenario
  // tables still have every label. Never use the resulting metrics as a report.
  const limitPerLabel = Number(process.env.LAYA_TRAIN_LIMIT ?? 0);
  if (!Number.isInteger(limitPerLabel) || limitPerLabel < 0)
    throw new Error(`invalid LAYA_TRAIN_LIMIT: ${limitPerLabel}`);
  const stratify = (rows: CorpusCase[]): CorpusCase[] => {
    if (!limitPerLabel) return rows;
    const byKey = new Map<string, CorpusCase[]>();
    for (const row of rows) {
      const key = `${row.split}:${row.label}`;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const splits = [...new Set(rows.map((row) => row.split))];
    return splits.flatMap((split) => (Object.keys(BANDS) as Label[])
      .flatMap((label) => (byKey.get(`${split}:${label}`) ?? []).slice(0, limitPerLabel)));
  };
  if (limitPerLabel)
    status(`警告：LAYA_TRAIN_LIMIT=${limitPerLabel}（每类），仅用于冒烟，指标不可用于正式报告`);
  const selectionRows = stratify(corpus.filter((row) => row.split !== "test"));
  const heldOutRows = stratify(corpus.filter((row) => row.split === "test"));
  const questionFor = (variant: Variant): Question => ({
    type: "choice",
    instructions: variant.instructions,
    criteria: variant.criteria ? { ...variant.criteria } : [...RELATIONSHIP_OPTIONS],
  });
  const stateFor = (item: CorpusCase) =>
    buildTargetState([{ id: item.id, side: "other", text: item.text, time: 1 }], 0);

  /** Decode a whole split in packed forward passes instead of one `session.run` per row. */
  const observe = async (variant: Variant, rows: CorpusCase[]): Promise<Observed[]> => {
    if (!rows.length) return [];
    const question = questionFor(variant);
    const predictions = await agent.predictBatch(rows.map((item) =>
      ({ state: stateFor(item), questions: { relationship: question } })));
    if (predictions.length !== rows.length)
      throw new Error(`batched inference returned ${predictions.length} / ${rows.length} rows`);
    decodedRows += rows.length;
    return rows.map((item, index) => {
      const answer = predictions[index]!.answers.relationship;
      if (answer?.type !== "choice") throw new Error(`missing relationship answer: ${item.id}`);
      return { ...item, distribution: answer.probabilities,
        score: Math.round(50 + 50 * messageScore({ relationship: answer.probabilities })),
        choice: answer.choice };
    });
  };

  const observations = new Map<string, Observed[]>();
  interface Report { variant: string; train: ReturnType<typeof metrics>; validation: ReturnType<typeof metrics> }
  let reports: Report[] = [];
  let winnerVariant = "";
  try {
    // Stage A: every candidate prompt sees train + validation only. The test split is not
    // decoded here, so it can never influence prompt or half-life selection.
    for (const variant of VARIANTS) {
      const budget = headBudget(tokenizer, questionFor(variant), config.head_max_len);
      // A truncated variant is not comparable: part of its instruction never reached the model.
      if (budget.truncated)
        status(`警告：${variant.name} 的指令被截断（${budget.head} → ${budget.kept} token），结果不可比`);
      observations.set(variant.name, await observe(variant, selectionRows));
    }
    reports = VARIANTS.map((variant) => {
      const rows = observations.get(variant.name)!;
      return { variant: variant.name,
        train: metrics(rows.filter((row) => row.split === "train")),
        validation: metrics(rows.filter((row) => row.split === "validation")) };
    });
    // Prompt selection uses train only. Macro averages keep the positive-only enrichment from
    // turning the warm/romantic majority into a selection advantage.
    reports.sort((a, b) => b.train.macroBandHit - a.train.macroBandHit ||
      b.train.macroRecall - a.train.macroRecall || a.train.mae - b.train.mae);
    // `--select=` only reports test for a configuration that was already chosen by
    // train/validation (e.g. the prompt that ships). It must not pick between candidates.
    winnerVariant = selectArg
      ? reports.find((row) => row.variant === selectArg)?.variant
        ?? (() => { throw new Error(`unknown --select: ${selectArg}`); })()
      : reports[0]!.variant;

    // Stage B: decode test once, only for the selected prompt and the v1 baseline.
    if (!trainOnly) {
      for (const name of new Set([winnerVariant, "baseline"])) {
        const variant = VARIANTS.find((item) => item.name === name)!;
        const rows = observations.get(name) ?? [];
        observations.set(name, rows.concat(await observe(variant, heldOutRows)));
      }
    }
  } finally {
    tokenizer.clearEncodeCache();
    await runner.dispose();
  }

  const winner = { variant: winnerVariant };
  const inference = {
    provider: runner.provider, batchSize, runCount, decodedRows,
    selectionRows: selectionRows.length,
    heldOutRows: trainOnly ? 0 : heldOutRows.length,
    limitPerLabel,
  };
  const inferenceLine = `推理：${inference.decodedRows} 行 / ${inference.runCount} 次前向，` +
    `batch ${inference.batchSize}，平均 ` +
    `${(inference.decodedRows / Math.max(1, inference.runCount)).toFixed(1)} 行/次` +
    (limitPerLabel ? `；LIMIT=${limitPerLabel}/类，指标不可用于正式报告` : "") +
    (batchSize > 1 ? "；批量预览，数值不可比" : "");
  const winnerRows = observations.get(winner.variant)!;
  const baselineRows = observations.get("baseline")!;
  const trainParams = parameterTable(winnerRows.filter((row) => row.split === "train"));
  const validationParams = parameterTable(winnerRows.filter((row) => row.split === "validation"));
  // Train fits the prompt; validation selects the only numeric hyperparameter. The test split
  // is evaluated for the resulting single pair and for the legacy baseline, never for choices.
  // A hit-rate tie prefers the longer half-life: the offline noise scenario starts failing below
  // 8 messages, and shorter windows overreact to a single ambiguous decode.
  validationParams.sort((a, b) => b.hit - a.hit || b.halfLife - a.halfLife || a.loss - b.loss);
  const selected = validationParams[0]!;
  const trainSelected = trainParams.find((row) => row.halfLife === selected.halfLife)!;

  // `--train-only` skips stage B entirely: test rows are never decoded.
  if (trainOnly) {
    console.log(`\n训练语料：${counts.train} train / ${counts.validation} validation；` +
      `后端 ${inference.provider}；` +
      `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（--train-only，跳过 test 集）`);
    console.log(inferenceLine);
    console.log("提示词            训练宏区间  训练宏召回  训练MAE   验证宏区间  验证宏召回");
    for (const row of reports) {
      console.log(`${row.variant.padEnd(18)}${fmt(row.train.macroBandHit).padEnd(12)}` +
        `${fmt(row.train.macroRecall).padEnd(12)}${fmt(row.train.mae).padEnd(10)}` +
        `${fmt(row.validation.macroBandHit).padEnd(12)}${fmt(row.validation.macroRecall)}`);
    }
    console.log(`\n选中提示词：${winner.variant}${selectArg ? "（--select 指定）" : "（按训练集）"}`);
    console.log("半衰期  训练场景命中  验证场景命中  训练档位距离  验证档位距离");
    for (const row of trainParams) {
      const validation = validationParams.find((item) => item.halfLife === row.halfLife)!;
      console.log(`${String(row.halfLife).padEnd(8)}${`${Math.round(row.hit * 100)}%`.padEnd(14)}` +
        `${`${Math.round(validation.hit * 100)}%`.padEnd(14)}${String(row.loss).padEnd(14)}${validation.loss}`);
    }
    console.log(`\n选中半衰期（按验证集）：${selected.halfLife}${halfLifeTieNote(validationParams, selected)}`);
    for (const split of ["train", "validation"] as const) {
      const rows = winnerRows.filter((row) => row.split === split);
      console.log(`\n${winner.variant} 未判对（${split}）`);
      for (const row of errors(rows))
        console.log(`  ${row.id.padEnd(14)} 应为 ${row.expected.padEnd(9)} 实际 ${row.got.padEnd(9)} ` +
          `分数 ${String(row.score).padStart(3)}  ${row.text}`);
    }
    return;
  }

  const testRows = winnerRows.filter((row) => row.split === "test");
  const testParams = parameterTable(testRows).find((row) => row.halfLife === selected.halfLife)!;
  const baselineTest = metrics(baselineRows.filter((row) => row.split === "test"));
  const baselineTestScenarios = legacyScenarioTable(baselineRows.filter((row) => row.split === "test"));
  const selectedTest = metrics(testRows);

  const output = {
    provider: runner.provider,
    elapsedMs: Date.now() - startedAt,
    inference,
    corpus: { total: corpus.length, ...splitCounts(corpus) },
    candidates: reports.map((row) => ({ variant: row.variant, train: row.train,
      validation: row.validation })),
    selected: { prompt: winner.variant, halfLife: selected.halfLife,
      trainBandHit: trainSelected.hit, validationBandHit: selected.hit,
      trainScenarios: trainSelected.scores, validationScenarios: selected.scores },
    before: { prompt: "baseline", halfLife: "linear-v1", test: baselineTest,
      testScenarios: baselineTestScenarios,
      errors: errors(baselineRows.filter((row) => row.split === "test")) },
    after: { prompt: winner.variant, halfLife: selected.halfLife, test: selectedTest,
      testScenarios: testParams, errors: errors(testRows) },
  };
  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`\n训练语料：${counts.train} train / ${counts.validation} validation / ` +
    `${counts.test} test；测试集不参与选择；` +
    `后端 ${output.provider}；耗时 ${(output.elapsedMs / 1000).toFixed(1)}s`);
  console.log(inferenceLine);
  console.log("提示词            训练宏区间  训练宏召回  训练MAE   验证宏区间  验证宏召回");
  for (const row of reports) {
    console.log(`${row.variant.padEnd(18)}${fmt(row.train.macroBandHit).padEnd(12)}` +
      `${fmt(row.train.macroRecall).padEnd(12)}${fmt(row.train.mae).padEnd(10)}` +
      `${fmt(row.validation.macroBandHit).padEnd(12)}${fmt(row.validation.macroRecall)}`);
  }
  console.log(`\n选中提示词：${winner.variant}${selectArg ? "（--select 指定）" : "（按训练集）"}`);
  console.log("半衰期  训练场景命中  验证场景命中  训练档位距离  验证档位距离");
  for (const row of trainParams) {
    const validation = validationParams.find((item) => item.halfLife === row.halfLife)!;
    console.log(`${String(row.halfLife).padEnd(8)}${`${Math.round(row.hit * 100)}%`.padEnd(14)}` +
      `${`${Math.round(validation.hit * 100)}%`.padEnd(14)}${String(row.loss).padEnd(14)}${validation.loss}`);
  }
  console.log(`\n选中半衰期（按验证集）：${selected.halfLife}${halfLifeTieNote(validationParams, selected)}`);
  console.log("\n测试集最终对比（仅评估，不参与选择）");
  console.log("配置                         区间命中  分类准确率  MAE      对话场景命中");
  console.log(`${"v1 baseline + linear".padEnd(29)}` +
    `${`${Math.round(baselineTest.bandHit * 100)}%`.padEnd(10)}` +
    `${`${Math.round(baselineTest.accuracy * 100)}%`.padEnd(12)}${fmt(baselineTest.mae).padEnd(9)}` +
    `${Math.round(baselineTestScenarios.hit * 100)}%`);
  console.log(`${`final ${winner.variant}`.padEnd(29)}` +
    `${`${Math.round(selectedTest.bandHit * 100)}%`.padEnd(10)}` +
    `${`${Math.round(selectedTest.accuracy * 100)}%`.padEnd(12)}${fmt(selectedTest.mae).padEnd(9)}` +
    `${Math.round(testParams.hit * 100)}%`);
  console.log("\n优化后仍未判对（测试集）");
  for (const row of errors(testRows)) {
    console.log(`  ${row.id.padEnd(14)} 应为 ${row.expected.padEnd(9)} 实际 ${row.got.padEnd(9)} ` +
      `分数 ${String(row.score).padStart(3)}  ${row.text}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
