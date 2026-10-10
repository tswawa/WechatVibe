"use strict";
// 「选择消息」: the user ticks a few chat records and only those may be analysed. The mode
// has to stay a submission scope — the moment the automatic window run takes over again the
// selection means nothing (and in API mode it spends the provider call the selection exists
// to avoid).
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");
const { installViewState } = require("./helpers/view-state-harness.cjs");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");
const html = readFileSync(path.join(__dirname, "..", "chatui", "index.html"), "utf8").replace(/\r/gu, "");

function section(start, end) {
  const first = app.indexOf(start);
  const last = app.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return app.slice(first, last);
}
const PICK_SOURCE = section("function pickableMessage(", "function uncoveredMessages(");
// The link rule lives beside the other text predicates; `pickableMessage` only calls it, so
// the slice has to carry it (and it must stay in step with `bridge/message_input.py`).
const LINK_SOURCE = section("// Links never reach a model", "function hasIntentContent(");

function matches(node, selector) {
  return selector.split(".").filter(Boolean).every(name => node.classes.includes(name));
}
function findAll(root, selector) {
  const parts = selector.trim().split(/\s+/u);
  const last = parts.at(-1);
  const found = [];
  const visit = node => {
    for (const child of node.children) {
      const head = matches(child, last) ? [child] : [];
      const tail = ["input"].includes(last) ? child.children.filter(item => item.tag === "input") : [];
      found.push(...head, ...tail);
      visit(child);
    }
  };
  visit(root);
  return found;
}
function element(tag, className = "", value = "") {
  const node = {
    tag, dataset: {}, children: [], parent: null, listeners: {}, attributes: {},
    textContent: value == null ? "" : String(value),
    hidden: false, disabled: false, checked: false, type: "",
    classes: String(className).split(" ").filter(Boolean),
    classList: {
      contains: name => node.classes.includes(name),
      add: name => { if (!node.classes.includes(name)) node.classes.push(name); },
      remove: name => { node.classes = node.classes.filter(item => item !== name); },
      toggle: (name, force) => {
        const on = force === undefined ? !node.classes.includes(name) : !!force;
        if (on) node.classList.add(name); else node.classList.remove(name);
        return on;
      },
    },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    append(...items) { for (const item of items) node.appendChild(item); },
    addEventListener(type, handler) { (node.listeners[type] = node.listeners[type] || []).push(handler); },
    fire(type, target = node) { for (const handler of node.listeners[type] || []) handler({ target }); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    removeAttribute(name) { delete node.attributes[name]; },
    querySelector: selector => findAll(node, selector)[0] || null,
    querySelectorAll: selector => findAll(node, selector),
    replaceChildren(...items) { node.children = []; for (const item of items) node.appendChild(item); },
    closest(selector) {
      let current = node;
      while (current) {
        if (matches(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
  };
  Object.defineProperty(node, "className", { get: () => node.classes.join(" "), configurable: true });
  return node;
}
function message(id, side = "other", text = "合成消息") {
  return { id, side, kind: "text", text };
}
function harness(messages = [], seed = {}) {
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, element("div"));
    return nodes.get(id);
  };
  const context = vm.createContext({
    element, byId,
    document: { createElement: tag => element(tag) },
    text: (id, value) => { byId(id).textContent = value == null ? "" : String(value); },
    setStripStatus(message) { context.stripStatus = message; },
    toast(value) { context.toastMessage = value; },
    hasIntentContent: value => String(value || "").trim().length > 0,
    isIncompleteFragment: () => false,
    usingApiInsights: () => context.settingsState.modelSourceResolved &&
      context.settingsState.modelSourceSnapshot.mode === "api",
    canAnalyzeLocal: () => context.settingsState.modelSourceResolved &&
      context.settingsState.modelSourceSnapshot.mode === "local",
    settings: { intent: true },
    messages,
    ...seed,
  });
  installViewState(context);
  context.settingsState.modelSourceResolved = true;
  context.settingsState.modelSourceSnapshot = { mode: "local", api: null, sourceId: "local" };
  vm.runInContext(`${LINK_SOURCE}${PICK_SOURCE}
    globalThis.picks = { pickableMessage, pickedMessages, pickedWindow, renderPickBar,
      setPickedMessage, syncPickControls, setMessagePicking, pickAllMessages, attachPickControl,
      stripMessageLinks, messageAnalysisText, hasAnalyzableText };`,
  context);
  const container = byId("chatMessages");
  container.children = [];
  for (const item of messages) {
    const node = element("div", "msg-item incoming");
    node.dataset.messageId = String(item.id);
    context.picks.attachPickControl(item, node);
    container.appendChild(node);
  }
  if (!context.chatState.selectedMessageIds) throw new Error("chat state lost the selection set");
  return { picks: context.picks, context, byId, nodes: container.children };
}

it("offers a checkbox only for messages the active source can analyse", () => {
  const { context, nodes } = harness([message("m1"), message("m2", "self"), { id: "m3", side: "other", kind: "image", text: "" }]);
  assert.ok(nodes[0].classList.contains("pickable"));
  assert.ok(nodes[0].querySelector(".msg-pick"));
  assert.equal(nodes[1].classList.contains("pickable"), false);
  assert.equal(nodes[2].classList.contains("pickable"), false);
  // The API path additionally drops messages without intent content.
  context.settingsState.modelSourceSnapshot = { mode: "api", api: null, sourceId: "api-a" };
  assert.equal(context.picks.pickableMessage(message("m1", "other", "嗯")), true);
});

it("keeps a message that is only a link out of every analysis path", () => {
  const { picks, context, nodes } = harness([
    message("m1", "other", "https://example.com/share"),
    message("m2", "other", "www.example.com/a"),
    message("m3", "other", "[链接]"),
    message("m4", "other", "看这个 https://example.com/a 挺有意思"),
    message("m5", "other", "？？？"),
  ]);
  // The rule itself, shared with `bridge/message_input.py`.
  assert.equal(picks.hasAnalyzableText("https://example.com/a"), false);
  assert.equal(picks.hasAnalyzableText("https://example.com/a。"), false, "trailing punctuation stays with the sentence");
  assert.equal(picks.hasAnalyzableText("[链接]"), false);
  assert.equal(picks.hasAnalyzableText("[重要]"), true, "only WeChat placeholder names are dropped");
  assert.equal(picks.hasAnalyzableText("？？？"), true, "punctuation alone still carries tone, as before");
  assert.equal(picks.messageAnalysisText("看 https://example.com/a。"), "看 。");
  assert.equal(picks.messageAnalysisText("见 mp.weixin.qq.com/s/a"), "见 mp.weixin.qq.com/s/a",
    "a bare domain without a scheme is not stripped");
  // Hand-picking never offers them, and the API submit list never carries them either.
  assert.deepEqual([nodes[0].classList.contains("pickable"), nodes[1].classList.contains("pickable"),
    nodes[2].classList.contains("pickable"), nodes[3].classList.contains("pickable"),
    nodes[4].classList.contains("pickable")],
  [false, false, false, true, true]);
  assert.equal(picks.pickableMessage(message("m9", "other", "https://example.com/a")), false);
  context.settingsState.modelSourceSnapshot = { mode: "api", api: null, sourceId: "api-a" };
  assert.equal(picks.pickableMessage(message("m9", "other", "https://example.com/a")), false);
});

it("sends exactly the picked ids inside the tail window the backend resolves", () => {
  const messages = Array.from({ length: 20 }, (_unused, index) => message(`m${index}`));
  const { picks, context } = harness(messages);
  context.chatState.selectedMessageIds.add("m15");
  context.chatState.selectedMessageIds.add("m17");
  const window = picks.pickedWindow();
  assert.deepEqual(window.candidates.map(item => item.id), ["m15", "m17"]);
  assert.equal(window.limit, 5, "the window must reach back to the oldest picked message");
  assert.equal(picks.pickedMessages().length, 2);
});

it("drops ids that fell out of the 80-message window instead of sending them", () => {
  const messages = Array.from({ length: 90 }, (_unused, index) => message(`m${index}`));
  const { picks, context } = harness(messages);
  picks.setMessagePicking(true);
  picks.pickAllMessages();
  const window = picks.pickedWindow();
  assert.equal(window.limit, 80);
  assert.equal(window.candidates.length, 80, "the oldest ten ids are outside the window");
  assert.deepEqual(window.candidates[0].id, "m10");
  assert.match(context.byId("pickBarCount").textContent, /已选 80 条（10 条超出当前窗口）/u);
});

it("counts the selection on the bar and clears it on exit", () => {
  const { picks, context, byId } = harness([message("m1"), message("m2")]);
  picks.setMessagePicking(true);
  assert.equal(byId("btnPickAnalyze").disabled, true, "an empty selection cannot be submitted");
  picks.setPickedMessage("m1", true);
  assert.match(byId("pickBarCount").textContent, /已选 1 条/u);
  assert.equal(byId("btnPickAnalyze").disabled, false);
  assert.ok(byId("chatMessages").classList.contains("pick-mode"));
  const row = byId("chatMessages").children[0];
  assert.ok(row.classList.contains("picked"));
  assert.equal(row.querySelector(".msg-pick input").checked, true);
  picks.setMessagePicking(false);
  assert.equal(context.chatState.selectedMessageIds.size, 0);
  assert.equal(row.classList.contains("picked"), false);
  assert.equal(row.querySelector(".msg-pick input").checked, false);
  assert.equal(byId("pickBar").hidden, true);
  assert.equal(byId("chatMessages").classList.contains("pick-mode"), false);
});

it("toggles from the row itself and never from the checkbox twice", () => {
  const { context, byId } = harness([message("m1")]);
  context.chatState.messagePicking = true;
  const row = byId("chatMessages").children[0];
  row.fire("click", row.querySelector(".msg-bubble") || row);
  assert.equal(context.chatState.selectedMessageIds.has("m1"), true);
  row.fire("click", row.querySelector(".msg-pick input"));
  assert.equal(context.chatState.selectedMessageIds.has("m1"), true, "the checkbox owns its own click");
  row.fire("click", row);
  assert.equal(context.chatState.selectedMessageIds.has("m1"), false);
});

it("refuses to enter picking without an intent switch or a usable source", () => {
  const { picks, context } = harness([message("m1")]);
  context.settingsState.settings.intent = false;
  picks.setMessagePicking(true);
  assert.equal(context.chatState.messagePicking, false);
  assert.match(context.toastMessage, /意图识别/u);
  context.settingsState.settings.intent = true;
  context.settingsState.modelSourceResolved = false;
  picks.setMessagePicking(true);
  assert.equal(context.chatState.messagePicking, false);
  assert.match(context.toastMessage, /不可用/u);
});

it("keeps the automatic window runs off while the selection is being made", () => {
  const schedule = app.slice(app.indexOf("function scheduleRecent("),
    app.indexOf("function incrementalState("));
  assert.match(schedule, /if \(chatState\.messagePicking\) return;/u);
  const submit = app.slice(app.indexOf("function submitManualRecent("),
    app.indexOf("function submitPickedMessages("));
  assert.match(submit, /if \(chatState\.messagePicking\) \{ submitPickedMessages\(\); return; \}/u);
  const ensure = app.slice(app.indexOf("function ensureApiInsights("),
    app.indexOf("let managedAccounts = [];"));
  assert.match(ensure, /if \(chatState\.messagePicking\) \{ renderApiInsightStatus\(\); return; \}/u);
  // The picked ids ride on the existing recent-window request instead of a new endpoint.
  const analyze = app.slice(app.indexOf("async function analyzeRecent("),
    app.indexOf("async function scheduleIncremental("));
  assert.match(analyze, /\.\.\.\(targetIds\?\.length \? \{ targetIds \} : \{\}\)/u);
  assert.match(analyze, /startInlineIntentPending\(window, targetIds\)/u);
});

it("wires the toolbar button and the pick bar to the existing submit paths", () => {
  assert.match(html, /id="btnPickMessages"/u);
  assert.match(html, /id="pickBar"/u);
  assert.match(html, /id="btnPickAnalyze"/u);
  assert.match(app, /byId\("btnPickAnalyze"\)\.addEventListener\("click", submitPickedMessages\)/u);
  const picked = app.slice(app.indexOf("function submitPickedMessages("),
    app.indexOf("function fineWindow("));
  assert.match(picked, /usingApiInsights\(\)\) \{ submitPickedApiInsights\(candidates\); return; \}/u);
  assert.match(picked, /void analyzeRecent\([\s\S]{0,240}limit, window, targetIds\)/u);
  // Switching conversations or entering history drops a selection the next window cannot resolve.
  const switching = app.slice(app.indexOf("function switchSession("),
    app.indexOf("function switchSession(") + 3000);
  assert.match(switching, /chatState\.messagePicking = false;[\s\S]{0,80}chatState\.selectedMessageIds\.clear\(\);/u);
  assert.match(app, /if \(chatState\.messagePicking\) setMessagePicking\(false\);/u);
});
