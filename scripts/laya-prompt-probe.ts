// Relationship-prompt selection probe for the local Laya model.
//
//   npx tsx scripts/laya-prompt-probe.ts --dry-run    # validate the case table, no model needed
//   npx tsx scripts/laya-prompt-probe.ts              # real inference (needs .models/laya)
//
// WHY THIS EXISTS
// ---------------
// The affinity head can only be as accurate as the relationship distribution it consumes. This
// probe asks the model one question per message and compares the resulting single-message score
// against the band the message semantically belongs to, so a prompt variant can be selected on
// data instead of taste.
//
// METHOD
// ------
// The case table is split into `fit` and `holdout` up front. Variants are compared on `fit` only;
// the winner is then evaluated once on `holdout`. A variant that does not also improve `holdout`
// must not ship — that is the whole point of keeping the two halves separate.
//
// This is the earlier 40-case exploratory probe. The shipped decision uses
// `scripts/laya-score-train.ts` and the balanced 100-case corpus; this file is kept only for
// ad-hoc wording comparisons and none of its numbers back the production change.

import { readFileSync } from "node:fs";
import path from "node:path";

import { LayaAgent } from "../electron/laya/agent";
import { buildTargetState } from "../electron/laya/context";
import { RELATIONSHIP_OPTIONS } from "../electron/laya/options";
import { NodeOnnxRunner } from "../electron/laya/runner";
import { messageScore } from "../electron/laya/scoring";
import { LayaTokenizer } from "../electron/laya/tokenizer";
import type { AgentConfig, Question } from "../electron/laya/types";

type Split = "fit" | "holdout";

interface ProbeCase {
  id: string;
  text: string;
  /** Inclusive score band the message should land in. */
  band: [number, number];
  split: Split;
}

// Four cases per class per split. `fit` selects the prompt, `holdout` only confirms it.
const CASES: ProbeCase[] = [
  // rejecting — explicit refusal / push-away
  { id: "rej-f1", text: "我不想再和你见面了。", band: [0, 30], split: "fit" },
  { id: "rej-f2", text: "请停止给我发消息。", band: [0, 30], split: "fit" },
  { id: "rej-f3", text: "我拒绝你的追求，我们不可能。", band: [0, 30], split: "fit" },
  { id: "rej-f4", text: "别再联系我了，我不想继续。", band: [0, 30], split: "fit" },
  { id: "rej-h1", text: "不用等我，我不会去的。", band: [0, 30], split: "holdout" },
  { id: "rej-h2", text: "请不要再来找我了。", band: [0, 30], split: "holdout" },
  { id: "rej-h3", text: "我们到此为止吧。", band: [0, 30], split: "holdout" },
  { id: "rej-h4", text: "我不想去，别再劝了。", band: [0, 30], split: "holdout" },

  // distant — cooling off without an explicit refusal
  { id: "dis-f1", text: "我最近想一个人静一静。", band: [20, 50], split: "fit" },
  { id: "dis-f2", text: "最近别约我了，我想缓缓。", band: [20, 50], split: "fit" },
  { id: "dis-f3", text: "我们好像没什么共同话题了。", band: [20, 50], split: "fit" },
  { id: "dis-f4", text: "我现在不想回应这个话题。", band: [20, 50], split: "fit" },
  { id: "dis-h1", text: "最近有点忙，先不聊了。", band: [20, 50], split: "holdout" },
  { id: "dis-h2", text: "先这样吧，我还有点事。", band: [20, 50], split: "holdout" },
  { id: "dis-h3", text: "随便你吧。", band: [20, 50], split: "holdout" },
  { id: "dis-h4", text: "以后再说吧。", band: [20, 50], split: "holdout" },

  // neutral — logistics, reminders, confirmations, requests
  { id: "neu-f1", text: "会议室在二楼。", band: [40, 60], split: "fit" },
  { id: "neu-f2", text: "文件我已经收到了。", band: [40, 60], split: "fit" },
  { id: "neu-f3", text: "周三十点前提交就可以。", band: [40, 60], split: "fit" },
  { id: "neu-f4", text: "地址发给我一下。", band: [40, 60], split: "fit" },
  { id: "neu-h1", text: "会议改到下午三点。", band: [40, 60], split: "holdout" },
  { id: "neu-h2", text: "快递放前台了。", band: [40, 60], split: "holdout" },
  { id: "neu-h3", text: "好的，我稍后处理。", band: [40, 60], split: "holdout" },
  { id: "neu-h4", text: "明天记得带身份证。", band: [40, 60], split: "holdout" },

  // warm — friendly affection, gratitude
  { id: "wrm-f1", text: "今天谢谢你的陪伴。", band: [58, 85], split: "fit" },
  { id: "wrm-f2", text: "你一来我就放心多了。", band: [58, 85], split: "fit" },
  { id: "wrm-f3", text: "很开心认识你。", band: [58, 85], split: "fit" },
  { id: "wrm-f4", text: "这个建议很有用，谢谢你。", band: [58, 85], split: "fit" },
  { id: "wrm-h1", text: "谢谢你一直帮我，真的很感激。", band: [58, 85], split: "holdout" },
  { id: "wrm-h2", text: "和你聊天很开心。", band: [58, 85], split: "holdout" },
  { id: "wrm-h3", text: "周末一起吃饭吧，我请客。", band: [58, 85], split: "holdout" },
  { id: "wrm-h4", text: "你做得真棒，我为你高兴。", band: [58, 85], split: "holdout" },

  // romantic — explicit courtship
  { id: "rom-f1", text: "做我男朋友好吗？", band: [80, 100], split: "fit" },
  { id: "rom-f2", text: "我想每天都见到你，因为我喜欢你。", band: [80, 100], split: "fit" },
  { id: "rom-f3", text: "你对我来说很特别，我想和你恋爱。", band: [80, 100], split: "fit" },
  { id: "rom-f4", text: "我爱你，想和你结婚。", band: [80, 100], split: "fit" },
  { id: "rom-h1", text: "我喜欢你，想和你在一起。", band: [80, 100], split: "holdout" },
  { id: "rom-h2", text: "我想你了，特别想见到你。", band: [80, 100], split: "holdout" },
  { id: "rom-h3", text: "你愿意做我女朋友吗？", band: [80, 100], split: "holdout" },
  { id: "rom-h4", text: "今晚的月色很美，可我一直在想你。", band: [80, 100], split: "holdout" },
];

/** Production wording, copied from electron/laya/options.ts (keep in sync by hand). */
const CURRENT =
  "From the sender of the TARGET message toward the recipient, what relationship signal does " +
  "the TARGET message carry? Choose romantic for clear romantic interest, warm for friendly " +
  "affection, neutral for ordinary or task talk, distant for cooling off or emotional " +
  "distance, and rejecting for an explicit refusal or push-away.";

const CHINESE =
  "判断 TARGET 发送者对接收者传达的关系信号。romantic=明确的爱慕、恋爱意向或暧昧（包括求爱的问题）；" +
  "warm=友善、感谢、愉快互动；neutral=普通事实、事务、提醒、确认或请求，即使语气简短也不代表冷淡；" +
  "distant=疏离、敷衍或减少互动，但没有明确拒绝；rejecting=明确拒绝、推开对方或要求停止联系。" +
  "不要仅因句子短、是请求或是疑问句就判为 rejecting。";

const GUARDRAILS =
  "Classify the relationship signal from the TARGET sender toward the recipient. romantic means " +
  "clear romantic interest or courtship, including a romantic question. warm means friendly " +
  "affection, gratitude, or enjoyable interaction. neutral means ordinary information, logistics, " +
  "reminders, confirmations, requests, or task talk, even when brief. distant means reduced " +
  "engagement or emotional distance without an explicit refusal. rejecting means an explicit " +
  "refusal, push-away, or request to stop contact. Do not treat brevity, a request, or a question " +
  "as rejection.";

const PRECISE =
  CURRENT + " A message is neutral unless it contains an interpersonal signal; routine " +
  "confirmations, reminders, logistics, requests, and statements are neutral even if terse. " +
  "Rejecting requires an explicit refusal or push-away; postponing or being busy is distant, not " +
  "rejecting. A romantic invitation or question is romantic.";

const VARIANTS: Array<[string, string]> = [
  ["current", CURRENT],
  ["chinese", CHINESE],
  ["guardrails", GUARDRAILS],
  ["precise", PRECISE],
];

function validateCases(): void {
  const ids = new Set<string>();
  const perClass = new Map<string, number>();
  for (const item of CASES) {
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (item.band[0] > item.band[1]) throw new Error(`inverted band: ${item.id}`);
    if (item.band[0] < 0 || item.band[1] > 100) throw new Error(`band out of range: ${item.id}`);
    const key = `${item.split}:${item.band[0]}-${item.band[1]}`;
    perClass.set(key, (perClass.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perClass) {
    if (count !== 4) throw new Error(`expected 4 cases for ${key}, found ${count}`);
  }
  const fit = CASES.filter((item) => item.split === "fit").length;
  const holdout = CASES.filter((item) => item.split === "holdout").length;
  if (fit !== 20 || holdout !== 20) throw new Error(`expected 20/20 split, found ${fit}/${holdout}`);
}

function dryRun(): void {
  validateCases();
  console.log(`用例 ${CASES.length} 条（fit 20 / holdout 20，每档每半集 4 条）`);
  for (const [name, instructions] of VARIANTS) {
    const words = instructions.length;
    console.log(`  变体 ${name.padEnd(11)} ${String(words).padStart(4)} 字  ${instructions.slice(0, 42)}…`);
  }
  console.log("\n分档中位数检查");
  const bands = [...new Set(CASES.map((item) => `${item.band[0]}-${item.band[1]}`))]
    .map((key) => key.split("-").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0]);
  for (const [lo, hi] of bands) {
    console.log(`  ${String(lo).padStart(3)}–${String(hi).padEnd(3)} 中位 ${(lo + hi) / 2}`);
  }
  for (let i = 1; i < bands.length; i++) {
    if ((bands[i]![0] + bands[i]![1]) / 2 <= (bands[i - 1]![0] + bands[i - 1]![1]) / 2) {
      throw new Error("band midpoints must increase with the class order");
    }
  }
  console.log("\n用例表校验通过；去掉 --dry-run 并准备 .models/laya 后可跑真实推理。");
}

interface Tally { fit: number; holdout: number }

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    dryRun();
    return;
  }
  validateCases();
  const dir = path.resolve(process.env.LAYA_MODEL_DIR ?? ".models/laya");
  const config = JSON.parse(readFileSync(path.join(dir, "rl_agent_config.json"), "utf8")) as AgentConfig;
  const tokenizer = new LayaTokenizer(
    JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(path.join(dir, "tokenizer/tokenizer_config.json"), "utf8")),
  );
  const runner = await NodeOnnxRunner.create(path.join(dir, "model.onnx"), { executionProvider: "cpu" });
  const agent = new LayaAgent({ config, tokenizer, runner, batchSize: 8 });
  const totals = new Map<string, Tally>();
  try {
    for (const [variant, instructions] of VARIANTS) {
      const question: Question = { type: "choice", instructions, criteria: [...RELATIONSHIP_OPTIONS] };
      const tally: Tally = { fit: 0, holdout: 0 };
      for (const item of CASES) {
        const state = buildTargetState([{ id: item.id, side: "other", text: item.text, time: 1 }], 0);
        const prediction = await agent.predict(state, { relationship: question });
        const answer = prediction.answers.relationship;
        if (answer?.type !== "choice") throw new Error(`missing relationship answer: ${item.id}`);
        const score = Math.round(50 + 50 * messageScore({ relationship: answer.probabilities }));
        const hit = score >= item.band[0] && score <= item.band[1];
        if (hit) tally[item.split] += 1;
        console.log(JSON.stringify({ variant, split: item.split, id: item.id, score,
          band: item.band, hit, choice: answer.choice, distribution: answer.probabilities }));
      }
      totals.set(variant, tally);
    }
  } finally {
    tokenizer.clearEncodeCache();
    await runner.dispose();
  }
  console.log("\n汇总（fit 用于选择，holdout 只用于确认）");
  for (const [variant, tally] of totals) {
    console.log(`  ${variant.padEnd(11)} fit ${tally.fit}/20   holdout ${tally.holdout}/20`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
