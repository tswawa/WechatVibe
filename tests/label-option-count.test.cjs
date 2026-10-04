const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { installViewState } = require("./helpers/view-state-harness.cjs");

const root = path.join(__dirname, "..");
const source = readFileSync(path.join(root, "chatui/app.js"), "utf8");
const labelsSource = readFileSync(path.join(root, "chatui/message-labels.js"), "utf8");
const adaptersSource = readFileSync(path.join(root, "chatui/message-insight-adapters.js"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
function element(tag, className, textContent = "") {
  return { tag, className, textContent, children: [], appendChild(child) { this.children.push(child); } };
}
const context = vm.createContext({
  element,
  percent: value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? `${Math.round(value * 100)}%` : "",
  window: { Kaomoji: { pick: () => null } },
});
installViewState(context);
vm.runInContext(labelsSource, context);
vm.runInContext(adaptersSource, context);
vm.runInContext(
  section("const GENERIC_INTENT_LABELS", "settingsState.settings = undefined;") +
  section("function rankedScores(", "const LABEL_OPTION_FLOOR") +
  section("const LABEL_OPTION_FLOOR", "function hasIntentContent(") +
  section("function hasIntentContent(", "function clearInlineIntentPending(") +
  "globalThis.api = { displayedEmotion, displayedIntent, rankedEmotionScores, hasIntentContent," +
  " isIncompleteFragment, labelOptionsHintText, render: messageLabelsApi().render," +
  " localView: window.MessageInsightAdapters.localView };",
  context);
const api = context.api;
const labels = entries => Array.from(entries, entry => entry.item.label);
const dependencies = { rankedEmotionScores: api.rankedEmotionScores,
  displayedEmotion: api.displayedEmotion, displayedIntent: api.displayedIntent,
  hasIntentContent: api.hasIntentContent, isIncompleteFragment: api.isIncompleteFragment,
  labelSchema: "generic-v10" };

it("keeps the one-candidate default exactly as it was", () => {
  const tie = api.displayedEmotion([
    { label: "平静", probability: 0.52 }, { label: "开心", probability: 0.48 },
  ], "早呀", 1);
  assert.deepEqual(labels(tie), [], "a near tie still shows no single label");
  const single = api.displayedEmotion([
    { label: "平静", probability: 0.7 }, { label: "开心", probability: 0.2 },
  ], "早呀", 1);
  assert.deepEqual(labels(single), ["平静"]);
  assert.equal(single.length, 1);
  assert.equal(single[0].close, undefined);
});

it("shows the close pair and tags the runner-up once the reader asks for more", () => {
  const scores = [
    { label: "平静", probability: 0.52 }, { label: "开心", probability: 0.48 },
    { label: "难过", probability: 0.1 },
  ];
  const shown = api.displayedEmotion(scores, "早呀", 3);
  assert.deepEqual(labels(shown), ["平静", "开心"], "the runner-up above the floor is listed");
  assert.equal(shown[1].close, true, "the near tie is tagged");
  assert.equal(shown[0].close, undefined);
  assert.equal(api.displayedEmotion(scores, "早呀", 2).length, 2);
});

it("keeps the evidence floors and only tags a genuinely close runner-up", () => {
  assert.deepEqual(labels(api.displayedEmotion([{ label: "平静", probability: 0.28 }], "早呀", 3)), []);
  const shown = api.displayedEmotion([
    { label: "平静", probability: 0.7 }, { label: "开心", probability: 0.2 }, { label: "难过", probability: 0.05 },
  ], "早呀", 3);
  assert.deepEqual(labels(shown), ["平静", "开心"]);
  assert.equal(shown[1].close, undefined, "a distant runner-up carries no tie tag");
});

it("marks a close intent runner-up in candidate mode and keeps the single rule", () => {
  const result = { groundedIntent: null, intent: [
    { rawLabel: "share_news", probability: 0.61 }, { rawLabel: "inform", probability: 0.55 },
  ] };
  const single = api.displayedIntent(result, "请把通知发给我", 1);
  assert.deepEqual(Array.from(single, candidate => candidate.label), ["分享"]);
  assert.equal(single[0].close, undefined);
  const pair = api.displayedIntent(result, "请把通知发给我", 2);
  assert.deepEqual(Array.from(pair, candidate => candidate.label), ["分享", "告知事实"]);
  assert.equal(pair[1].close, true);
  const weak = api.displayedIntent({ groundedIntent: null, intent: [
    { rawLabel: "share_news", probability: 0.49 }, { rawLabel: "inform", probability: 0.45 },
  ] }, "请把通知发给我", 2);
  assert.deepEqual(Array.from(weak), []);
});

it("keeps the one-candidate view label-only and lets the richer view carry probabilities", () => {
  // The one-candidate view keeps the original rule, where a near tie leaves the row blank;
  // a decisive leader is what that view shows.
  const decisive = { labelSchema: "generic-v10", groundedIntent: null,
    emotion: [{ label: "平静", probability: 0.7 }, { label: "开心", probability: 0.2 }],
    intent: [{ rawLabel: "share_news", probability: 0.61 }, { rawLabel: "inform", probability: 0.55 }] };
  const single = api.localView(decisive, "请把通知发给我", { ...dependencies, optionCount: 1 });
  assert.equal(single.emotions.length, 1);
  assert.equal(single.intents.length, 1);
  assert.deepEqual(Object.keys(single.emotions[0]), ["label"]);
  assert.deepEqual(Object.keys(single.intents[0]), ["label"]);
  // The near tie the one-candidate view drops is exactly what the richer view exists to show.
  const tie = { ...decisive, emotion: [{ label: "平静", probability: 0.52 }, { label: "开心", probability: 0.48 }] };
  assert.equal(api.localView(tie, "请把通知发给我", { ...dependencies, optionCount: 1 }).emotions.length, 0);
  const pair = api.localView(tie, "请把通知发给我", { ...dependencies, optionCount: 2 });
  assert.equal(pair.emotions.length, 2);
  assert.equal(pair.intents.length, 2);
  assert.equal(pair.emotions[1].probability, 0.48);
  assert.equal(pair.emotions[1].close, true);
  assert.equal(pair.intents[1].close, true);
});

it("renders the chosen candidates with percentages and the close tag", () => {
  const row = api.render({ emotions: [
    { label: "平静", probability: 0.52, close: false },
    { label: "开心", probability: 0.48, close: true },
  ], intents: [] }, "synthetic");
  const line = row.children[0];
  assert.equal(line.children[0].textContent, "情绪");
  assert.equal(line.children[1].children[0].textContent, "平静");
  assert.equal(line.children[1].children[1].textContent, "52%");
  assert.equal(line.children[2].children[0].textContent, "开心");
  assert.equal(line.children[2].children[1].textContent, "48%");
  assert.equal(line.children[2].children[2].textContent, "相近");
  const grounded = api.render({ emotions: [], intents: [{ label: "感谢", probability: null, close: false }] }, "synthetic");
  const groundedNode = grounded.children[0].children[1];
  assert.equal(groundedNode.children.length, 1);
  assert.equal(groundedNode.title, "文本线索判断");
});

it("ships the setting, its default and the reader-facing entry", () => {
  const html = readFileSync(path.join(root, "chatui/index.html"), "utf8");
  for (const id of ["btnLabelOptions1", "btnLabelOptions2", "btnLabelOptions3"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html must ship #${id}`);
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-label=`, "u"), `#${id} needs an accessible name`);
  }
  assert.match(source, /labelOptions: 1 \};/u);
  assert.match(source, /optionCount: labelOptionLimit\(\)/u);
  assert.match(source, /settingsState\.settings\.labelOptions, result\.labelSchema/u);
  assert.match(source, /element, percent,/u);
  // The row explains itself, and the selected choice must be visible without hovering.
  const localStart = html.indexOf('id="localModelSettings"');
  const local = html.slice(localStart, html.indexOf("</section>", localStart));
  assert.ok(local.includes('id="labelOptionsHint"'), "the hint belongs with the local-only settings");
  const css = readFileSync(path.join(root, "chatui/style.css"), "utf8");
  assert.match(css, /\.settings-action-btn\.active \{/u);
  assert.match(css, /#localModelSettings \.label-options-hint/u);
  assert.match(source, /byId\("labelOptionsHint"\)\.textContent = labelOptionsHintText\(/u);
});

it("tells the reader what the chosen option count does", () => {
  assert.match(api.labelOptionsHintText(1), /只显示 1 个标签/u);
  assert.match(api.labelOptionsHintText(1), /接近时整行不显示/u);
  assert.match(api.labelOptionsHintText(2), /前 2 个候选/u);
  assert.match(api.labelOptionsHintText(3), /前 3 个候选/u);
  assert.match(api.labelOptionsHintText(3), /「相近」/u);
  for (const limit of [1, 2, 3]) {
    assert.match(api.labelOptionsHintText(limit), /仅本地分析生效/u, "the hint says where the setting applies");
  }
});