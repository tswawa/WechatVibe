"use strict";
// Right-click one chat record →「重新算」. Recomputing a single message is two steps:
// forget its saved row, then submit that one id through the ordinary path of the active
// source. Both analysis paths skip an id that already has a result, so the forget call is
// what makes the action do anything at all — a test that only checks the request would miss
// the whole point, so the flow is exercised end to end here.
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
const MENU_SOURCE = section("// ── 消息右键菜单", "function renderMessages(");
// The link rule and the pick helpers decide the same thing about a message; the menu only
// calls them, so the slice has to carry them (`bridge/message_input.py` is the Python twin).
const LINK_SOURCE = section("// Links never reach a model", "function hasIntentContent(");
const PICK_SOURCE = section("function pickableMessage(", "function uncoveredMessages(");
const ENTRY_SOURCE = section("function apiInsightKey(", "const API_INSIGHT_LABEL");

function matches(node, selector) {
  return selector.split(".").filter(Boolean).every(name => node.classes.includes(name));
}
function findAll(root, selector) {
  const parts = selector.trim().split(/\s+/u);
  const last = parts.at(-1);
  const found = [];
  const visit = node => {
    for (const child of node.children) {
      if (matches(child, last)) found.push(child);
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
    hidden: false, disabled: false, checked: false, type: "", value: "",
    style: { left: "", top: "" },
    offsetWidth: 0, offsetHeight: 0,
    rect: { width: 150, height: 42 },
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
    fire(type, event = {}) {
      const payload = { target: node, preventDefault() {}, ...event };
      for (const handler of node.listeners[type] || []) handler(payload);
    },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    removeAttribute(name) { delete node.attributes[name]; },
    focus() { node.focused = true; },
    getBoundingClientRect: () => node.rect,
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
function messageNode(id) {
  const node = element("div", "msg-item incoming");
  node.dataset.messageId = String(id);
  return node;
}
function harness(messages = [], seed = {}) {
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, element("div"));
    return nodes.get(id);
  };
  const posted = [];
  const submitted = [];
  // The order is the feature: submitting before the row is forgotten is a silent no-op,
  // because both analysis paths skip an id that already has a result.
  const events = [];
  const context = vm.createContext({
    element, byId, console,
    document: { createElement: tag => element(tag), addEventListener() {}, activeElement: null },
    window: { innerWidth: 1000, innerHeight: 800, addEventListener() {} },
    text: (id, value) => { byId(id).textContent = value == null ? "" : String(value); },
    toast(value) { context.toastMessage = value; },
    setStripStatus(value) { context.stripStatus = value; },
    refreshLabels() { context.refreshCount = (context.refreshCount || 0) + 1; },
    handleAccountBoundaryError: () => false,
    setIntentActionState(state) { context.intentActionState = state; },
    activeApiInsightEntry: () => context.apiEntry || null,
    apiInsightWorkCurrent: () => context.apiWorkCurrent !== false,
    apiInsightSignature: list => list.map(item => String(item.id)).join(","),
    fineWindowSignature: window => `sig:${window.limit}`,
    submitApiInsightJob(work, candidates, signature) {
      events.push("submit");
      submitted.push({ work, candidates, signature });
    },
    analyzeRecent(user, token, signal, signature, limit, window, targetIds) {
      events.push("submit");
      submitted.push({ user, signature, limit, window, targetIds });
      return Promise.resolve();
    },
    async api(url, options) {
      events.push("forget");
      posted.push({ url, body: JSON.parse(options.body) });
      return { forgotten: true, ...posted.at(-1).body };
    },
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
  context.portraitState.activeAnalysisScope = "scope-key";
  context.chatState.currentAccount = "account-a";
  context.chatState.currentUser = "friend";
  context.chatState.controller = { signal: null };
  vm.runInContext(
    `${LINK_SOURCE}${PICK_SOURCE}${ENTRY_SOURCE}${MENU_SOURCE}
     globalThis.menu = { messageMenuReason, messageSourceId, localRecomputable, openMessageMenu,
       closeMessageMenu, recomputeMessage, forgetMessageAnalysis, dropMessageResult,
       messageFromNode, pickedWindow, hasAnalyzableText, pickableMessage, stripMessageLinks,
       apiInsightKey, activeApiInsightEntry };`,
    context);
  return { menu: context.menu, context, byId, posted, submitted, events };
}
function apiMode(context, sourceId = "a".repeat(32)) {
  context.settingsState.modelSourceSnapshot = { mode: "api", api: { model: "m" }, sourceId };
  context.labelState.apiInsightWork = { key: "api-key", pendingIds: new Set() };
  // `activeApiInsightEntry` comes from the sliced source, so the confirmed results live in
  // the real per-scope cache rather than in a stub.
  if (!(context.labelState.apiInsightCache instanceof Map)) context.labelState.apiInsightCache = new Map();
  const entry = { results: {}, job: { status: "done" } };
  context.labelState.apiInsightCache.set(context.menu.apiInsightKey("account-a", "friend", sourceId), entry);
  context.apiEntry = entry;
}

it("documents the menu in the page and wires it to the message rows", () => {
  assert.match(html, /id="messageContextMenu"[^>]*role="menu"/u);
  assert.match(html, /id="btnRecomputeMessage"[^>]*>重新算<\/button>/u);
  assert.match(MENU_SOURCE, /byId\("chatMessages"\)\.addEventListener\("contextmenu"/u);
  const { context, byId } = harness([message("m1")]);
  const node = messageNode("m1");
  byId("chatMessages").appendChild(node);
  let prevented = false;
  byId("chatMessages").fire("contextmenu", { target: node, clientX: 40, clientY: 60,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "the browser menu must not open over a chat record");
  assert.equal(byId("messageContextMenu").hidden, false);
  assert.equal(byId("btnRecomputeMessage").disabled, false);
  assert.equal(byId("messageContextHint").hidden, true);
  // A right-click on empty space belongs to the browser.
  prevented = false;
  byId("messageContextMenu").hidden = true;
  byId("chatMessages").fire("contextmenu", { target: element("div", "chat-empty"),
    preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(byId("messageContextMenu").hidden, true);
  assert.equal(context.menu.messageFromNode(node).id, "m1");
});

it("clamps the menu inside the viewport and closes it again", () => {
  const { menu, byId } = harness([message("m1")]);
  byId("messageContextMenu").rect = { width: 150, height: 42 };
  menu.openMessageMenu(message("m1"), 980, 790);
  assert.equal(byId("messageContextMenu").style.left, "842px");
  assert.equal(byId("messageContextMenu").style.top, "750px");
  assert.equal(byId("btnRecomputeMessage").focused, true);
  menu.closeMessageMenu();
  assert.equal(byId("messageContextMenu").hidden, true);
  assert.equal(byId("messageContextMenu").style.left, "");
});

it("explains why a message cannot be recomputed instead of offering a dead action", () => {
  const { menu, context } = harness([message("m1"), message("m2", "self"), message("m3", "other", "https://example.com/a"),
    message("m4", "other", "[链接]"), message("m5", "other", "嗯")]);
  assert.equal(menu.messageMenuReason(message("m1")), "");
  assert.equal(menu.messageMenuReason(message("m2", "self")), "这条消息不参与分析");
  assert.equal(menu.messageMenuReason(message("m3", "other", "https://example.com/a")), "这条消息不参与分析",
    "a shared link is never analysed, so it cannot be recomputed either");
  assert.equal(menu.messageMenuReason(message("m4", "other", "[链接]")), "这条消息不参与分析");
  assert.equal(menu.messageMenuReason(message("m5", "other", "？？")), "", "punctuation alone still carries tone");
  context.settingsState.settings.intent = false;
  assert.equal(menu.messageMenuReason(message("m1")), "请先开启「意图识别」");
  context.settingsState.settings.intent = true;
  context.chatState.historyState = { id: "m1" };
  assert.equal(menu.messageMenuReason(message("m1")), "请先返回最新消息再重算");
  context.chatState.historyState = null;
  context.labelState.recentPending = true;
  assert.equal(menu.messageMenuReason(message("m1")), "已有分析正在进行，请稍后再试");
  context.labelState.recentPending = false;
  context.portraitState.activeAnalysisScope = null;
  assert.equal(menu.messageMenuReason(message("m1")), "分析尚未就绪，请稍后再试");
  context.portraitState.activeAnalysisScope = "scope-key";
  context.settingsState.modelSourceResolved = false;
  assert.equal(menu.messageMenuReason(message("m1")), "当前模型来源不可用，无法分析");
});

it("refuses a message that fell out of the 80-message window the backend resolves", () => {
  const messages = Array.from({ length: 90 }, (_unused, index) => message(`m${index}`));
  const { menu, context } = harness(messages);
  assert.equal(menu.messageMenuReason(messages[0]), "这条消息不在最近窗口中");
  assert.equal(menu.messageMenuReason(messages.at(-1)), "");
  context.chatState.messages = messages;
  assert.deepEqual(menu.pickedWindow([messages.at(-1)]).candidates.map(item => item.id), ["m89"]);
});

it("forgets the saved row and then submits exactly that one id in local mode", async () => {
  const { menu, context, posted, submitted, events } = harness([message("m1"), message("o7")]);
  context.labelState.results = { o7: { state: "done", labelSchema: "fine-v1" }, m1: { state: "done" } };
  await menu.recomputeMessage(context.chatState.messages[1]);
  assert.deepEqual(events, ["forget", "submit"], "the row has to be gone before the id is sent");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "/api/analysis-target/forget");
  assert.deepEqual(posted[0].body, { account: "account-a", user: "friend", sourceId: "local", messageId: "o7" });
  assert.equal(submitted.length, 1);
  // `Array.from` on the host side: values that cross the vm boundary keep their own
  // realm's prototype, which strict deep equality rejects even when they look identical.
  assert.deepEqual(Array.from(submitted[0].targetIds), ["o7"], "only the right-clicked message is re-analysed");
  assert.equal(submitted[0].limit, 1, "the window has to reach back to the right-clicked message");
  assert.equal(context.labelState.results.o7, undefined, "the old label goes away before the new run reports");
  assert.equal(context.labelState.results.m1.state, "done", "every other label stays");
  assert.ok(context.refreshCount >= 1);
  assert.equal(context.intentActionState, "submitting");
  assert.equal(context.toastMessage, undefined);
});

it("leaves the row alone when the view moved on while the forget call was in flight", async () => {
  const { menu, context, submitted } = harness([message("o7")]);
  context.api = async (url, options) => {
    context.chatState.currentUser = "other-friend";
    return { forgotten: true, ...JSON.parse(options.body) };
  };
  await menu.recomputeMessage(message("o7"));
  assert.equal(submitted.length, 0, "the answer belonged to a conversation the view has left");
});

it("reports a refused forget call instead of pretending it recomputed", async () => {
  const { menu, context, submitted } = harness([message("o7")]);
  context.api = async () => ({ forgotten: true, account: "account-a", user: "friend", sourceId: "local", messageId: "o8" });
  await menu.recomputeMessage(message("o7"));
  assert.equal(submitted.length, 0);
  assert.equal(context.toastMessage, "重算失败，请稍后重试");
});

it("posts at most one forget call at a time", async () => {
  const { menu, context, posted } = harness([message("o7")]);
  let release = null;
  context.api = (url, options) => new Promise(resolve => {
    posted.push({ url, body: JSON.parse(options.body) });
    release = () => resolve({ forgotten: true, ...posted.at(-1).body });
  });
  const first = menu.recomputeMessage(message("o7"));
  await menu.recomputeMessage(message("o7"));
  assert.equal(posted.length, 1);
  release();
  await first;
  assert.equal(posted.length, 1);
});

it("uses the API source id and hands the single message to the insight job", async () => {
  const { menu, context, posted, submitted, events } = harness([message("o7")]);
  apiMode(context);
  context.apiEntry.results.o7 = { id: "o7", status: "ok", intents: [] };
  context.apiEntry.job = { status: "done" };
  await menu.recomputeMessage(message("o7"));
  assert.deepEqual(events, ["forget", "submit"]);
  assert.equal(posted[0].body.sourceId, "a".repeat(32));
  assert.equal(submitted.length, 1);
  assert.deepEqual(Array.from(submitted[0].candidates, item => item.id), ["o7"]);
  assert.equal(submitted[0].signature, "o7");
  assert.equal(context.apiEntry.results.o7, undefined);
  assert.equal(context.stripStatus, "正在重算这一条…");
});

it("says so when the API conversation is not ready or already running", () => {
  const { menu, context } = harness([message("o7")]);
  apiMode(context);
  context.apiEntry.job = { status: "running" };
  assert.equal(menu.messageMenuReason(message("o7")), "已有分析正在进行，请稍后再试");
  context.apiEntry.job = { status: "done" };
  assert.equal(menu.messageMenuReason(message("o7")), "");
  context.apiWorkCurrent = false;
  assert.equal(menu.messageMenuReason(message("o7")), "当前会话分析尚未就绪，请稍后再试");
  assert.equal(menu.messageMenuReason(message("m1", "self")), "当前会话分析尚未就绪，请稍后再试");
});

it("keeps the link rule in step with the message text predicate it shares", () => {
  const { menu } = harness([]);
  assert.equal(menu.localRecomputable(message("m1", "other", "看这个 https://example.com/a")), true);
  assert.equal(menu.localRecomputable(message("m1", "other", "https://example.com/a")), false);
  assert.equal(menu.localRecomputable(message("m1", "self", "你好")), false);
  assert.equal(menu.localRecomputable({ id: "m1", side: "other", kind: "image", text: "[图片]" }), false);
});
