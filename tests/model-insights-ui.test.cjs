const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
const code = section("async function api(", "function status(") +
  section("function updateLabel(", "function messageNode(") +
  section("const MODEL_SOURCE_PROTOCOLS", "let managedAccounts = [];") +
  "globalThis.ui = { showModelSource, updateLabel, validApiInsight, renderApiInsightResult, " +
  "ensureApiInsights, cancelApiInsightWork, activeApiInsightKey, apiInsightCache, " +
  "getSource: () => modelSourceSnapshot };";

function element(tag, className = "", value = "") {
  const node = {
    tag, className, textContent: value == null ? "" : String(value), value: "", hidden: false,
    disabled: false, dataset: {}, children: [], parent: null,
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    getBoundingClientRect() { return { top: 0, bottom: 0 }; },
    querySelectorAll() { return []; },
    querySelector(selector) {
      const wanted = selector.split(" ").at(-1).slice(1);
      const seek = parent => {
        for (const child of parent.children) {
          if (child.className.split(" ").includes(wanted)) return child;
          const nested = seek(child);
          if (nested) return nested;
        }
        return null;
      };
      return seek(this);
    },
    classList: { add(name) { node.className += ` ${name}`; }, toggle() {} },
  };
  Object.defineProperty(node, "childNodes", { get: () => node.children });
  Object.defineProperty(node, "options", { get: () => node.children });
  return node;
}
function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].join(" ");
}
function countClass(node, name) {
  return Number(node.className.split(" ").includes(name)) +
    node.children.reduce((sum, child) => sum + countClass(child, name), 0);
}
function messageNode(id = "m1") {
  const node = element("div", "msg-item incoming");
  node.dataset.messageId = id;
  const wrap = node.appendChild(element("div", "msg-content-wrap"));
  wrap.appendChild(element("div", "msg-bubble", "合成消息"));
  return node;
}
const response = body => ({ ok: true, json: async () => body });
const localState = { mode: "local", api: null, sourceId: "local", status: "active" };
function apiState(sourceId = "api-a") {
  return { mode: "api", api: { protocol: "responses", baseUrl: "https://example.test/v1",
    model: "synthetic-model", hasKey: true }, sourceId, status: "active" };
}
const insight = { id: "m1", status: "ok", emotion: "平静", intent: "请求帮助" };
const insufficient = { id: "m1", status: "insufficient" };

function harness(fetchImpl = async () => response({ account: "acct", sourceId: "api-a",
  results: {}, job: { id: null, status: "idle", total: 0, processed: 0 } })) {
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, element("div"));
    return nodes.get(id);
  };
  byId("settingsModal").querySelector = () => element("div");
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, element, byId,
    document: { createElement: tag => element(tag) },
    text: (id, value) => { byId(id).textContent = value == null ? "" : String(value); },
    fetch: fetchImpl,
    setTimeout: () => 1, clearTimeout() {},
    settings: { intent: true }, currentAccount: "acct", currentUser: "chat",
    view: "chat", apiPortraitSnapshot: null,
    syncPortraitMode() {}, cancelApiPortraitPoll() {}, loadProfile() {},
    controller: new AbortController(), generation: 1, historyState: null,
    runtimeSnapshot: null, runtimeBusy: false, incrementalFailed: false, recentFailed: false,
    messages: [], results: {}, inlineIntentPending: new Map(),
    CURRENT_LABEL_SCHEMA: "generic-v8", catalogReady: true, catalogLabelRevision: 0,
    fineMessageResult: result => result?.state === "done",
    rankedEmotionScores: () => [{ item: { label: "本地情绪", probability: 0.8 } }],
    appendScoreLine: row => row.appendChild(element("span", "intent-pct", "80%")),
    appendIntentLine: row => row.appendChild(element("span", "intent-name", "本地意图")),
    displayedIntent: () => [{ label: "本地意图", probability: 0.8 }],
    clearInlineIntentPending() {}, setIntentActionState() {}, refreshLabels() {},
    submitManualRecent() {},
    handleAccountBoundaryError: () => false,
    hasIntentContent: value => /[\p{L}\p{N}]/u.test(value),
    isIncompleteFragment: () => false,
  });
  context.fineWindow = () => ({ candidates: context.messages.filter(message =>
    message.side === "other" && message.kind === "text") });
  vm.runInContext(code, context);
  return { ui: context.ui, byId, context };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

it("switches bubble labels by source without mixing cached Laya and API results", () => {
  const { ui, context } = harness();
  const message = { id: "m1", side: "other", kind: "text", text: "请把文件发给我" };
  context.messages = [message];
  context.results = { m1: { state: "done", labelSchema: "generic-v8", emotion: [], intent: [] } };
  const bubble = messageNode();
  ui.showModelSource(localState);
  ui.updateLabel(message, bubble);
  assert.equal(countClass(bubble, "intent-pct"), 1);
  ui.showModelSource(apiState());
  ui.updateLabel(message, bubble);
  assert.equal(countClass(bubble, "intent-pct"), 0);
  assert.equal(countClass(bubble, "inline-intent-row"), 0);
  ui.apiInsightCache.set(ui.activeApiInsightKey(), { results: { m1: insight }, job: null, error: "" });
  ui.updateLabel(message, bubble);
  assert.match(textOf(bubble), /平静/);
  assert.match(textOf(bubble), /请求帮助/);
  assert.equal(countClass(bubble, "intent-pct"), 0);
  ui.showModelSource(localState);
  ui.updateLabel(message, bubble);
  assert.equal(countClass(bubble, "intent-pct"), 1);
});

it("renders only emotion and intent tags, with no confidence or response suggestions", () => {
  const { ui } = harness();
  assert.equal(ui.validApiInsight(insight, "m1"), true);
  const row = ui.renderApiInsightResult(insight);
  assert.equal(countClass(row, "intent-pct"), 0);
  assert.equal(countClass(row, "api-insight-tag"), 2);
  assert.equal(countClass(row, "api-insight-options"), 0);
  assert.match(textOf(row), /情绪 平静/);
  assert.match(textOf(row), /意图 请求帮助/);
  assert.doesNotMatch(textOf(row), /下一步|请把文件|发送文件/);
  assert.equal(ui.validApiInsight({ ...insight, emotion: "平静80%" }, "m1"), false);
  assert.equal(ui.validApiInsight({ ...insight, intent: "问" }, "m1"), false);
  assert.equal(ui.validApiInsight({ ...insight, emotion: "非常开心" }, "m1"), true);
});

it("does not force emotion or intent tags for insufficient evidence", () => {
  const { ui, context } = harness();
  const message = { id: "m1", side: "other", kind: "text", text: "嗯" };
  context.messages = [message];
  ui.showModelSource(apiState());
  ui.apiInsightCache.set(ui.activeApiInsightKey(), { results: { m1: insufficient }, job: null, error: "" });
  const bubble = messageNode();
  ui.updateLabel(message, bubble);
  assert.equal(countClass(bubble, "inline-intent-row"), 0);
  assert.equal(countClass(bubble, "intent-pct"), 0);
});

it("posts only scoped message IDs and a bounded limit; no API key or chat text", async () => {
  const calls = [];
  const { ui, context } = harness(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (calls.length === 1) return response({ account: "acct", sourceId: "api-a", results: {},
      job: { id: null, status: "idle", total: 0, processed: 0 } });
    if (calls.length === 2) return response({ account: "acct", sourceId: "api-a",
      job: { id: "j1", status: "queued", total: 2, processed: 0 } });
    return response({ account: "acct", sourceId: "api-a", results: {},
      job: { id: "j1", status: "running", total: 2, processed: 0 } });
  });
  context.messages = [
    { id: "m1", side: "other", kind: "text", text: "请把文件发给我" },
    { id: "m2", side: "other", kind: "text", text: "什么时候完成？" },
  ];
  ui.showModelSource(apiState());
  await tick();
  await tick();
  assert.equal(calls[1].url, "/api/model-insights");
  assert.deepEqual(calls[1].body, { account: "acct", user: "chat", limit: 2,
    targetIds: ["m1", "m2"] });
  assert.equal(JSON.stringify(calls).includes("SYNTHETIC_KEY"), false);
  assert.equal(JSON.stringify(calls).includes("请把文件"), false);
});

it("analyzes only visible historical messages using a scoped history anchor", async () => {
  const calls = [];
  const { ui, context, byId } = harness(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.startsWith("/api/model-insights?")) return response({ account: "acct", sourceId: "api-a",
      results: {}, job: { id: null, status: "idle", total: 0, processed: 0 } });
    return response({ account: "acct", sourceId: "api-a",
      job: { id: "history-job", status: "queued", total: 1, processed: 0 } });
  });
  context.historyState = { beforeCursor: "older" };
  context.messages = [
    { id: "old", side: "other", kind: "text", text: "上周见面吗？", historyCursor: "history-anchor" },
    { id: "hidden", side: "other", kind: "text", text: "不在视野里", historyCursor: "other-anchor" },
  ];
  const visible = messageNode("old");
  visible.getBoundingClientRect = () => ({ top: 20, bottom: 90 });
  const hidden = messageNode("hidden");
  hidden.getBoundingClientRect = () => ({ top: 300, bottom: 350 });
  const container = byId("chatMessages");
  container.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
  container.querySelectorAll = () => [visible, hidden];
  ui.showModelSource(apiState());
  await tick();
  await tick();
  const post = calls.find(call => call.url === "/api/model-insights");
  assert.deepEqual(post.body.targetIds, ["old"]);
  assert.equal(post.body.around, "history-anchor");
  assert.equal(JSON.stringify(post.body).includes("上周见面吗"), false);
});

it("reveals visible API labels in small batches without losing later messages", async () => {
  const posts = [];
  const { ui, context } = harness(async (url, options) => {
    if (url === "/api/model-insights") {
      const body = JSON.parse(options.body);
      posts.push(body.targetIds);
      return response({ account: "acct", sourceId: "api-a",
        job: { id: `job-${posts.length}`, status: "queued", total: body.targetIds.length, processed: 0 } });
    }
    const completed = posts.flat();
    return response({ account: "acct", sourceId: "api-a",
      results: Object.fromEntries(completed.map(id => [id, { ...insight, id }])),
      job: { id: completed.length ? `job-${posts.length}` : null,
        status: completed.length ? "done" : "idle", total: completed.length, processed: completed.length } });
  });
  context.messages = Array.from({ length: 5 }, (_, index) => ({
    id: `m${index + 1}`, side: "other", kind: "text", text: `请处理第${index + 1}件事`,
  }));
  ui.showModelSource(apiState());
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(posts, [["m1", "m2", "m3"], ["m4", "m5"]]);
  assert.equal(Object.keys(ui.apiInsightCache.get(ui.activeApiInsightKey()).results).length, 5);
});

it("hydrates completed API results into the current bubble", async () => {
  let requests = 0;
  const { ui, context } = harness(async () => {
    requests++;
    if (requests === 1) return response({ account: "acct", sourceId: "api-a", results: {},
      job: { id: null, status: "idle", total: 0, processed: 0 } });
    if (requests === 2) return response({ account: "acct", sourceId: "api-a",
      job: { id: "j1", status: "queued", total: 1, processed: 0 } });
    return response({ account: "acct", sourceId: "api-a", results: { m1: insight },
      job: { id: "j1", status: "done", total: 1, processed: 1 } });
  });
  const message = { id: "m1", side: "other", kind: "text", text: "请把文件发给我" };
  context.messages = [message];
  ui.showModelSource(apiState());
  await tick();
  await tick();
  const bubble = messageNode();
  ui.updateLabel(message, bubble);
  assert.equal(ui.apiInsightCache.get(ui.activeApiInsightKey()).results.m1.status, "ok");
  assert.match(textOf(bubble), /请求帮助/);
  assert.equal(countClass(bubble, "intent-pct"), 0);
});

it("ignores a late response from an old source", async () => {
  const pending = [];
  const { ui, context } = harness(() => new Promise(resolve => pending.push(resolve)));
  context.messages = [{ id: "m1", side: "other", kind: "text", text: "请把文件发给我" }];
  ui.showModelSource(apiState("api-a"));
  ui.showModelSource(apiState("api-b"));
  pending[0](response({ account: "acct", sourceId: "api-a", results: { m1: insight },
    job: { id: "old", status: "done", total: 1, processed: 1 } }));
  await tick();
  assert.equal(ui.apiInsightCache.get(JSON.stringify(["acct", "chat", "api-a"])).results.m1, undefined);
  assert.equal(ui.getSource().sourceId, "api-b");
  ui.cancelApiInsightWork();
  pending[1](response({ account: "acct", sourceId: "api-b", results: {},
    job: { id: null, status: "idle", total: 0, processed: 0 } }));
});

it("ignores a late result after the account or conversation changes", async () => {
  let resolveFetch;
  const { ui, context } = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  context.messages = [{ id: "m1", side: "other", kind: "text", text: "请把文件发给我" }];
  ui.showModelSource(apiState());
  context.currentAccount = "another-account";
  context.currentUser = "another-chat";
  context.generation++;
  ui.cancelApiInsightWork();
  resolveFetch(response({ account: "acct", sourceId: "api-a", results: { m1: insight },
    job: { id: "old", status: "done", total: 1, processed: 1 } }));
  await tick();
  assert.equal(ui.apiInsightCache.get(JSON.stringify(["acct", "chat", "api-a"])).results.m1, undefined);
  assert.equal(ui.activeApiInsightKey(), JSON.stringify(["another-account", "another-chat", "api-a"]));
});

it("reports API failure without falling back to local bubble labels", async () => {
  const { ui, context, byId } = harness(async () => ({ ok: false, status: 503 }));
  const message = { id: "m1", side: "other", kind: "text", text: "请把文件发给我" };
  context.messages = [message];
  context.results = { m1: { state: "done", labelSchema: "generic-v8", emotion: [], intent: [] } };
  ui.showModelSource(apiState());
  await tick();
  const bubble = messageNode();
  ui.updateLabel(message, bubble);
  assert.equal(byId("analysisStatus").textContent, "分析结果读取失败");
  assert.equal(byId("btnRetryAnalysis").hidden, false);
  assert.equal(countClass(bubble, "intent-pct"), 0);
  assert.equal(countClass(bubble, "inline-intent-row"), 0);
});
