const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

// Load the pure decision and rendering functions from the desktop's classic script.
const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
function element(tag, className, textContent = "") {
  return {
    tag, className, textContent, children: [],
    appendChild(child) { this.children.push(child); },
  };
}
const context = vm.createContext({
  element,
  percent: value => `${value * 100}%`,
  window: { Kaomoji: { pick: () => null } },
});
vm.runInContext(section("const GENERIC_INTENT_LABELS", "let settings;") +
  section("function hasIntentContent(", "function clearInlineIntentPending(") +
  "globalThis.displayedIntentForTest = displayedIntent;" +
  "globalThis.appendScoreLineForTest = appendScoreLine;" +
  "globalThis.appendIntentLineForTest = appendIntentLine;", context);
const select = context.displayedIntentForTest;
const plain = candidates => Array.from(candidates, candidate => ({ ...candidate }));

it("shows evidence-backed intent plus distinct scored model alternatives", () => {
  const result = select({
    groundedIntent: { label: "status_report", evidenceKind: "progress_statement" },
    intent: [{ rawLabel: "complain", probability: 0.49 },
      { rawLabel: "status_report", probability: 0.31 },
      { rawLabel: "inform", probability: 0.2 }],
  }, "文件已上传到共享盘。");
  assert.deepEqual(plain(result), [
    { label: "状态报告", probability: null },
    { label: "抱怨", probability: 0.49 },
    { label: "告知事实", probability: 0.2 },
  ]);
});

it("shows grounded acknowledgements, inspection, and process explanation", () => {
  for (const [text, label, evidenceKind, expected] of [
    ["好了", "confirm", "short_acknowledgement", "确认"],
    ["我看看", "inspect", "first_person_inspection", "查看"],
    ["因为线路故障，所以暂时断开。", "explain", "process_explanation", "解释"],
  ]) {
    const result = select({ groundedIntent: { label, evidenceKind }, intent: [] }, text);
    assert.deepEqual(plain(result), [{ label: expected, probability: null }]);
  }
});

it("keeps up to three ranked Laya candidates with their original probabilities", () => {
  const result = select({ groundedIntent: null, intent: [
    { rawLabel: "inform", probability: 0.24 },
    { rawLabel: "general_exchange", probability: 0.41 },
    { rawLabel: "small_talk", probability: 0.35 },
    { rawLabel: "share_news", probability: 0 },
  ] }, "今天天气不错。");
  assert.deepEqual(plain(result), [
    { label: "一般交流", probability: 0.41 },
    { label: "闲聊", probability: 0.35 },
    { label: "告知事实", probability: 0.24 },
  ]);
});

it("renders nuanced generic-v7 labels using their original model probabilities", () => {
  const result = select({ groundedIntent: null, intent: [
    { rawLabel: "confide", probability: 0.72 },
    { rawLabel: "seek_comfort", probability: 0.2 },
    { rawLabel: "share_feeling", probability: 0.08 },
  ] }, "我今天有点难过，想跟你说说。");
  assert.deepEqual(plain(result), [
    { label: "倾诉", probability: 0.72 },
    { label: "求安慰", probability: 0.2 },
    { label: "表达感受", probability: 0.08 },
  ]);
});

it("omits intent for punctuation and quote-only text while retaining an emotion row", () => {
  const result = {
    groundedIntent: { label: "greet", evidenceKind: "greeting_phrase" },
    intent: [{ rawLabel: "greet", probability: 0.99 }],
  };
  for (const text of ['"', "“”", "！？…", "  '  "]) {
    const candidates = select(result, text);
    assert.deepEqual(plain(candidates), []);
    const row = element("div", "inline-intent-row");
    context.appendScoreLineForTest(row, "情绪", [{ item: { label: "平静", probability: 0.7 } }], "synthetic", true);
    context.appendIntentLineForTest(row, candidates);
    assert.equal(row.children.length, 1);
    assert.match(row.children[0].className, /emotion-line/);
  }
});

it("does not present a forced intent for unfinished fragments", () => {
  const result = { groundedIntent: null, intent: [
    { rawLabel: "status_report", probability: 0.64 },
    { rawLabel: "inform", probability: 0.36 },
  ] };
  assert.deepEqual(plain(select(result, "这就是")), []);
  assert.deepEqual(plain(select(result, "这是昨天说的文件")), [
    { label: "状态报告", probability: 0.64 },
    { label: "告知事实", probability: 0.36 },
  ]);
});

it("renders a model top three with percentages and a grounded label without one", () => {
  const modelRow = element("div", "inline-intent-row");
  context.appendIntentLineForTest(modelRow, select({ groundedIntent: null, intent: [
    { rawLabel: "share_news", probability: 0.61 },
    { rawLabel: "inform", probability: 0.27 },
    { rawLabel: "small_talk", probability: 0.12 },
  ] }, "今天收到通知了。"));
  assert.equal(modelRow.children.length, 1);
  assert.equal(modelRow.children[0].children.length, 4); // title and three candidates
  assert.deepEqual(modelRow.children[0].children.slice(1).map(item => item.children[1].textContent),
    ["61%", "27%", "12%"]);

  const groundedRow = element("div", "inline-intent-row");
  context.appendIntentLineForTest(groundedRow, select({
    groundedIntent: { label: "thank", evidenceKind: "thanks_phrase" }, intent: [],
  }, "谢谢你。"));
  assert.equal(groundedRow.children[0].children.length, 2);
  assert.equal(groundedRow.children[0].children[1].children.length, 1); // no percentage
  assert.match(groundedRow.children[0].children[1].className, /grounded/);
});

it("ignores malformed model candidates without inventing a fallback score", () => {
  assert.deepEqual(plain(select({ groundedIntent: null, intent: [
    { rawLabel: "inform", probability: "0.99" },
    { rawLabel: "unknown", probability: 0.8 },
    { label: "分享", probability: 0.7 },
  ] }, "文件在共享盘。")), []);
});
