import assert from "node:assert/strict";
import { it } from "node:test";

import { analyzeApiGuidance, GUIDANCE_MIN_CONTEXT, GUIDANCE_VERSION,
  type GuidanceInput } from "../electron/api-guidance";
import { ModelConnectorError, type GenerationRequest, type ModelConfig } from "../electron/model-connectors";

const config: ModelConfig = { protocol: "responses", baseUrl: "https://example.invalid/v1",
  apiKey: "synthetic-never-sent", model: "synthetic" };

const input = (overrides: Partial<GuidanceInput> = {}): GuidanceInput => ({
  messages: [
    { id: "m1", sender: "SELF", text: "好的，我这边先整理一下" },
    { id: "m2", sender: "OTHER", text: "这个方案再看看吧" },
    { id: "m3", sender: "SELF", text: "好的，我改一下再发您" },
  ],
  targetIds: ["m2"],
  scenario: "leader",
  analyzeSelf: false,
  contextTokens: 32768,
  ...overrides,
});

const okOthers = {
  reading: "对方没有否定方案，而是在确认自己的判断。",
  strategies: ["先给结论再补理由", "把改动点列成条目"],
  replies: [{ tone: "稳妥", text: "收到，我把这两处改好后今天下班前发您。" }],
};
const selfAdvice = { summary: "回复偏短，缺少结论。", strengths: ["确认及时"], improvements: ["先给结论"] };

const reply = (payload: unknown, capture?: (request: GenerationRequest) => void) =>
  async (_config: ModelConfig, value: GenerationRequest) => {
    capture?.(value);
    return { text: JSON.stringify(payload), usage: { inputTokens: 30, outputTokens: 20 } };
  };
const fails = (code: string) => (error: unknown) => error instanceof ModelConnectorError && error.code === code;

it("reads the subtext and the scenario advice from one provider turn", async () => {
  let sent: GenerationRequest | undefined;
  const result = await analyzeApiGuidance(config, input(), reply({
    subtexts: [{ id: "g2", status: "ok", surface: "再看看", implied: "希望我先自查再交付",
      tactic: "留台阶", sentiment: { polarity: "negative", label: "有点挑剔" } }],
    advice: { forOthers: okOthers, forSelf: null },
  }, value => { sent = value; }));

  assert.equal(sent!.system.includes("领导"), true, "the leader scenario reaches the prompt");
  const payload = JSON.parse(sent!.prompt.split("INPUT_JSON:\n")[1]!);
  assert.deepEqual(payload.targetIds, ["g2"], "real message ids never enter the prompt");
  assert.deepEqual(payload.subjectKind, "领导或上级");
  assert.deepEqual(payload.messages.map((item: { text: string }) => item.text),
    ["好的，我这边先整理一下", "这个方案再看看吧", "好的，我改一下再发您"]);
  assert.equal(result.version, GUIDANCE_VERSION);
  assert.equal(result.scenario, "leader");
  assert.equal(result.analyzeSelf, false);
  assert.equal(result.subtexts.length, 1);
  assert.deepEqual(result.subtexts[0], { id: "m2", status: "ok", surface: "再看看",
    implied: "希望我先自查再交付", tactic: "留台阶", sentiment: { polarity: "negative", label: "有点挑剔" } });
  assert.deepEqual(result.advice!.forOthers, okOthers);
  assert.equal(result.advice!.forSelf, null);
});

it("keeps the self branch tied to the settings switch in both directions", async () => {
  const withSelf = await analyzeApiGuidance(config, input({ analyzeSelf: true }),
    reply({ subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
      advice: { forOthers: okOthers, forSelf: selfAdvice } }));
  assert.deepEqual(withSelf.advice!.forSelf, selfAdvice);

  // A self section the switch did not ask for is a contract violation, not an extra hint.
  await assert.rejects(() => analyzeApiGuidance(config, input(), reply({
    subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
    advice: { forOthers: okOthers, forSelf: selfAdvice },
  })), fails("invalid-output"));
  await assert.rejects(() => analyzeApiGuidance(config, input({ analyzeSelf: true }), reply({
    subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-output"));
});

it("passes the user's own dissatisfaction through as revision guidance, not chat data", async () => {
  let sent: GenerationRequest | undefined;
  await analyzeApiGuidance(config, input({ feedback: "别再判断成中性" }), reply({
    subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
    advice: { forOthers: okOthers, forSelf: null },
  }, value => { sent = value; }));
  const payload = JSON.parse(sent!.prompt.split("INPUT_JSON:\n")[1]!);
  assert.equal(payload.userFeedback, "别再判断成中性");
  assert.equal("userFeedback" in payload.messages[0], false);
});

it("requires exactly one reading per target and never reassigns an unknown one", async () => {
  // "2" is a real alias in this window, but it belongs to another message. It must not
  // be silently accepted as the answer for the requested target.
  await assert.rejects(() => analyzeApiGuidance(config, input(), reply({
    subtexts: [{ id: "g3", status: "ok", implied: "这是另一条" }],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-output"), "another message's reading is not the target's reading");

  // A dropped target leaves the batch incomplete rather than becoming an empty success.
  await assert.rejects(() => analyzeApiGuidance(config, input(), reply({
    subtexts: [],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-output"));

  await assert.rejects(() => analyzeApiGuidance(config, input({ targetIds: ["m2", "m9"] }), reply({
    subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-request"), "a target outside the window is a bad request");

  // Only OTHER messages can be read; asking for my own line is rejected up front.
  await assert.rejects(() => analyzeApiGuidance(config, input({ targetIds: ["m1"] }), reply({
    subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-request"));
});

it("reports a terminal reading without smuggling in an interpretation", async () => {
  const result = await analyzeApiGuidance(config, input(), reply({
    subtexts: [{ id: "g2", status: "uncertain" }],
    advice: { forOthers: okOthers, forSelf: null },
  }));
  assert.deepEqual(result.subtexts, [{ id: "m2", status: "uncertain" }]);
  await assert.rejects(() => analyzeApiGuidance(config, input(), reply({
    subtexts: [{ id: "g2", status: "uncertain", implied: "其实我知道他在想什么" }],
    advice: { forOthers: okOthers, forSelf: null },
  })), fails("invalid-output"));
});

it("refuses advice that cannot be acted on", async () => {
  const cases = [
    { ...okOthers, strategies: [] },
    { ...okOthers, reading: "" },
    { ...okOthers, replies: [] },
    { ...okOthers, replies: [{ tone: "稳妥" }] },
    { ...okOthers, strategies: ["一", "二", "三", "四", "五"] },
  ];
  for (const forOthers of cases) {
    await assert.rejects(() => analyzeApiGuidance(config, input(), reply({
      subtexts: [{ id: "g2", status: "ok", implied: "希望我先自查再交付" }],
      advice: { forOthers, forSelf: null },
    })), fails("invalid-output"), JSON.stringify(forOthers));
  }
});

it("rejects an unreadable request before spending a provider call", async () => {
  let calls = 0;
  const counting = async () => { calls++; return { text: "{}" }; };
  const cases: GuidanceInput[] = [
    input({ contextTokens: GUIDANCE_MIN_CONTEXT - 1 }),
    input({ scenario: "boss" as GuidanceInput["scenario"] }),
    input({ targetIds: ["m1"] }),
    input({ targetIds: ["m2", "m2"] }),
    input({ feedback: "好".repeat(401) }),
    input({ targetIds: [] }),
  ];
  for (const value of cases) {
    await assert.rejects(() => analyzeApiGuidance(config, value, counting), fails("invalid-request"));
  }
  assert.equal(calls, 0, "an invalid window never reaches the provider");
});
