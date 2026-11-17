"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8").replace(/\r/g, "");
function body(signature) {
  const start = app.indexOf(signature), end = app.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, signature);
  return app.slice(start, end + 3);
}
const maps = app.slice(app.indexOf("const GENERIC_INTENT_LABELS"), app.indexOf("settingsState.settings = undefined"));
const constants = app.split("\n").filter(line => ["const PLAIN_ACK_TEXT", "const PLAIN_STATUS_TEXT", "const PLAIN_ACTION_LABELS",
  "const PLAIN_TURN"].some(prefix => line.startsWith(prefix))).join("\n");
const context = vm.createContext({});
vm.runInContext(maps + "\n" + constants + "\n" + ["function hasIntentContent(", "function isIncompleteFragment(",
  "function plainAcknowledgementOnly(", "function localIntentTextGuard(", "function displayedIntent("].map(body).join("\n"), context);
const shown = (result, text) => JSON.parse(JSON.stringify(context.displayedIntent(result, text)));

for (const [text, label, kind, display] of [
  ["下午不太方便，我们改到周日上午吧。", "plan", "concrete_reschedule", "改期"],
  ["我有点累了，想先休息，明天再接着说。", "close_chat", "conversation_pause", "收尾"],
  ["愿意，只要提前确认交通和返程时间。", "agree", "conditional_acceptance", "条件同意"],
  ["有点多，可以帮我分担最后的整理吗？", "seek_help", "action_request", "求助"],
]) {
  it(`shows the evidenced action ${display} without inventing or rewriting model scores`, () => {
    const result = { intent: [{rawLabel:"agree",probability:0.97}], groundedIntent:{label,evidenceKind:kind} };
    const before = JSON.stringify(result);
    assert.deepEqual(shown(result,text), [{label:display,probability:null}]);
    assert.equal(JSON.stringify(result), before);
  });
}

it("ordinary acknowledgements and ungrounded low scores still stay blank", () => {
  for (const text of ["好", "收到", "嗯嗯"])
    assert.deepEqual(shown({intent:[{rawLabel:"agree",probability:0.9}],
      groundedIntent:{label:"agree",evidenceKind:"explicit_acceptance"}},text), []);
  assert.deepEqual(shown({intent:[{rawLabel:"plan",probability:0.34}],groundedIntent:null},"明天的安排还没决定。"), []);
});

it("keeps a confident everyday label that used to be suppressed as low signal", () => {
  // 本机真实结果里 top1 几乎都是闲聊 / 分享 / 同意这类，旧规则把它们整类隐藏，
  // 整行只剩 9% 可见。只要首选够高、明显领先次选，就该显示出来。
  for (const [raw, label] of [["share_news", "分享"], ["small_talk", "闲聊"], ["inform", "告知事实"],
    ["share_feeling", "表达感受"]])
    assert.deepEqual(shown({intent:[{rawLabel:raw,probability:0.62},{rawLabel:"agree",probability:0.18}],
      groundedIntent:null},"今天路上看到一只特别胖的猫，蹲在车顶上不肯走。"), [{label,probability:0.62}]);
});

it("still hides a high score that does not lead the second candidate", () => {
  assert.deepEqual(shown({intent:[{rawLabel:"plan",probability:0.42},
    {rawLabel:"agree",probability:0.38}],groundedIntent:null},"明天可能去看电影。"), []);
  assert.deepEqual(shown({intent:[{rawLabel:"plan",probability:0.45},
    {rawLabel:"agree",probability:0.20}],groundedIntent:null},"明天可能去看电影。"), [{label:"计划",probability:0.45}]);
});

it("a mismatched evidence kind cannot grant an action label", () => {
  for (const grounded of [{label:"plan",evidenceKind:"conversation_pause"},
    {label:"close_chat",evidenceKind:"concrete_reschedule"}])
    assert.deepEqual(shown({intent:[{rawLabel:"plan",probability:0.1}],groundedIntent:grounded},"合成消息。"), []);
});

it("frontend guards agree with the model-side interpretation of reported acts and statements", async () => {
  const { isUnattributableIntentTarget, isEmbeddedQuestionStatement } = await import("../electron/laya/grounded-intent.ts");
  for (const text of ["小王问我，能不能帮我检查文档。", "我说的不是请你帮我修。", "他说我先休息一下，明天再聊。",
    "我的想法是：我在意实际能不能完成。", "我已经知道怎么备份。", "你知道怎么备份吗？",
    "我想知道怎么备份。", "有点多，可以帮我分担吗？", "下午不方便，我们改到周六吧。", "“请你帮我修。”"])
    assert.equal(Boolean(context.localIntentTextGuard(text)), isUnattributableIntentTarget(text) || isEmbeddedQuestionStatement(text), text);
});

it("does not suppress the author's own action after a reported statement", () => {
  assert.equal(context.localIntentTextGuard("他说会议改到周三，但我建议先确认地点。"), "");
  assert.deepEqual(shown({intent:[{rawLabel:"suggest_action",probability:0.8}],groundedIntent:null},
    "他说会议改到周三，但我建议先确认地点。"), [{label:"建议或指令",probability:0.8}]);
  assert.equal(context.localIntentTextGuard("他说：会议改到周三，但我建议先确认地点。"), "unattributed");
});

it("an ungrounded model answer cannot turn a negated request or statement into an action", () => {
  for (const text of ["小王问我，能不能帮我检查文档。", "我说的不是请你帮我修。"])
    assert.deepEqual(shown({intent:[{rawLabel:"seek_help",probability:0.99}],groundedIntent:null},text), []);
  assert.deepEqual(shown({intent:[{rawLabel:"agree",probability:0.99}],groundedIntent:null},"我的想法是：我在意实际能不能完成。"), []);
  assert.deepEqual(shown({intent:[{rawLabel:"ask_question",probability:0.99}],groundedIntent:null},"我已经知道怎么备份。"), []);
});

it("statement guards still allow a meaningful explanation instead of hiding every label", () => {
  assert.deepEqual(shown({intent:[{rawLabel:"explain",probability:0.8}],groundedIntent:null},"这说明为什么会失败。"),
    [{label:"解释",probability:0.8}]);
  assert.deepEqual(shown({intent:[{rawLabel:"clarify",probability:0.8}],groundedIntent:null},"我说的不是请你帮我修。"),
    [{label:"澄清",probability:0.8}]);
});
