"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const app = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8").replace(/\r/g, "");
function body(signature) {
  const start = app.indexOf(signature), end = app.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, signature);
  return app.slice(start, end + 3);
}
const source = [
  "function conversationAnalysisRequested(", "function currentIntentRequestScope(",
  "function analysisBlockedWithoutRequest(", "function usingLocalFine(", "function canAnalyzeLocal(",
  "function setIntentActionState(", "function renderRecentAction(", "function renderJob(",
  "function settleInlineIntentPending(",
  "function renderApiInsightStatus(", "function prepareManualLocalIntent(", "function submitManualRecent(",
  "function submitPickedMessages(", "function cancelRecentIntentWork(", "async function analyzeRecent(",
  "async function loadAnalysis(", "function resumeLocalAnalysis(", "function showLocalModel(",
  "async function loadLocalModel(", "function applyActiveModelSource(", "function beginUnknownModelSource(",
  "function visibleResults(", "function fineMessageResult(", "function fineWindow(",
  "function analyzableMessages(", "function fineWindowSignature(", "function uncoveredMessages(",
  "function scheduleRecent(", "function incrementalState(", "async function startIncremental(",
  "function scheduleIncremental(", "async function toggleIntentRecognition(",
  "function messageRenderSignature(", "function messagesSignature(",
].map(body).join("\n") + "\nlet recentIntentController = null;\n";

function harness({ ready = true, results = {}, apiOverride } = {}) {
  const nodes = new Map(), requests = [], timers = new Map(), modelEvents = [];
  let timerId = 0, runJob = { status: "idle" };
  function byId(id) {
    if (!nodes.has(id)) {
      const node = { hidden: false, textContent: "", title: "", dataset: {}, attributes: {}, classes: new Set(),
        classList: { toggle(name, on) { if (on) node.classes.add(name); else node.classes.delete(name); } },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
      };
      nodes.set(id, node);
    }
    return nodes.get(id);
  }
  const candidates = ["m1", "m2"].map(id => ({ id, side: "other", kind: "text", text: `Synthetic ${id}` }));
  const localSource = { mode: "local", sourceId: "local:laya" };
  const context = vm.createContext({ AbortController, AbortSignal, byId,
    Event: class Event { constructor(type) { this.type = type; } },
    window: { dispatchEvent(event) { modelEvents.push(event); return true; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); },
    CURRENT_LABEL_SCHEMA: "generic-v11", document: { hidden: false }, startupActive: false,
    chatState: { currentAccount: "acct", currentUser: "friend", generation: 1, view: "chat",
      selectedConversations: new Set(["friend"]), requestedConversations: new Set(),
      controller: new AbortController(), messageSourceReady: true, messagePicking: false,
      historyState: null, messages: candidates },
    labelState: { intentActionState: "idle", intentRequestScope: null, recentPending: false, recentFailed: false,
      results: {}, requestedRecentSignatures: new Set(), apiInsightCache: new Map(), inlineIntentPending: new Map() },
    portraitState: { activeAnalysisScope: "scope", analysisGeneration: 1, autoIncrementalState: new Map() },
    settingsState: { settings: { intent: true }, modelSourceResolved: true, modelSourceSnapshot: localSource,
      localModelResolved: ready, localModelReady: ready,
      localModelRequest: 0,
      suppressedLocalAccounts: new Set(), suppressedApiSources: new Set() },
    save() {}, refreshLabels() {}, cacheCurrentSession() {}, updateProfileProgress() {}, cancelLocalProfilePoll() {},
    clearInlineIntentPending() {}, startInlineIntentPending() {}, acceptResponseAccount: account => account === "acct",
    handleAccountBoundaryError: () => false, isNetworkFailure: () => false,
    activeApiInsightEntry: () => null, activeApiInsightKey: () => null,
    setStripStatus: value => { byId("stripStatusText").textContent = value; },
    text: (id, value) => { byId(id).textContent = value; }, toast() {},
    pickedWindow: () => ({ limit: candidates.length, candidates: candidates.slice(-1) }),
    applySettings: () => context.setIntentActionState(context.labelState.intentActionState),
    api: async (url, options = {}, signal) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, payload, signal });
      if (apiOverride) {
        const value = apiOverride(url, payload, signal);
        if (value !== undefined) return value;
      }
      if (url === "/api/local-model") return { state: "ready", source: "bundled", path: "synthetic-model" };
      if (url === "/api/analyze") {
        runJob = { status: "running", recent: { id: "recent-1", status: "running" } };
        return { account: "acct", job: runJob };
      }
      if (url.startsWith("/api/analysis?")) return { account: "acct", analysisVersion: "current", results, job: runJob };
      throw new Error(`Unexpected synthetic request: ${url}`);
    },
  });
  for (const name of ["syncPortraitMode", "syncGuidanceMode", "renderModelBadge", "cancelMessageRegeneration",
    "cancelApiPortraitPoll", "clearApiPortraitView", "cancelApiInsightWork", "setMessagePicking", "loadGuidance",
    "loadProfile", "ensureApiInsights", "clearProfileView", "updateModelSourceControls", "submitPickedApiInsights"])
    context[name] = () => {};
  vm.runInContext(source, context);
  const flush = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve)); };
  return { context, requests, byId, candidates, localSource, flush, modelEvents,
    posts: () => requests.filter(request => request.url === "/api/analyze" && request.payload),
    async click() { await context.toggleIntentRecognition(); await flush(); },
  };
}

it("cached done and skipped results give completion feedback without rerunning the model", async () => {
  const run = harness({ results: { m1: { state: "done", labelSchema: "generic-v11", emotion: [], intent: [] },
    m2: { state: "skipped" } } });
  await run.context.loadAnalysis("friend", 1, run.context.chatState.controller.signal);
  await run.click();
  assert.equal(run.posts().length, 0);
  assert.equal(run.context.labelState.intentActionState, "done");
  assert.equal(run.byId("btnToggleIntent").textContent, "识别完成");
  assert.match(run.byId("btnToggleIntent").title, /已读取 2 条.*跳过 1 条/u);
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("old fine-label results are refreshed for loaded targets without starting portrait work", async () => {
  const run = harness({ results: {
    m1: { state: "done", labelSchema: "generic-v9", emotion: [], intent: [] },
    m2: { state: "done", labelSchema: "generic-v10", emotion: [], intent: [] },
  } });
  await run.click();
  assert.equal(run.posts().length, 1);
  assert.equal(run.posts()[0].payload.mode, "recent");
  assert.deepEqual(run.posts()[0].payload.targetIds, ["m1", "m2"]);
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("a click deferred until the first snapshot still reports back when it resumes", async () => {
  let finish;
  const run = harness({
    results: { m1: { state: "done", labelSchema: "generic-v11", emotion: [], intent: [] }, m2: { state: "skipped" } },
    apiOverride: url => url.startsWith("/api/analysis?") ? new Promise(resolve => { finish = resolve; }) : undefined,
  });
  run.candidates.length = 0;                             // nothing recognisable in this window
  run.context.portraitState.activeAnalysisScope = null;  // the first snapshot is not ready yet
  await run.click();
  assert.equal(run.posts().length, 0);
  assert.equal(run.context.labelState.manualRecentDeferred, true);
  assert.equal(run.context.labelState.manualRecentUserInitiated, true,
    "the click must survive the wait, or the resume cannot report back");
  // The deferred read resolves and resumes without the original call arguments.
  finish({ account: "acct", analysisVersion: "current", results: {}, job: { status: "idle" } });
  await run.flush();
  assert.equal(run.context.labelState.manualRecentDeferred, false);
  assert.equal(run.context.labelState.manualRecentUserInitiated, false);
  assert.equal(run.context.labelState.intentActionState, "done");
  assert.match(run.byId("btnToggleIntent").title, /没有可识别的消息/);
});

it("a failed first read clears the deferred click so the next click retries", async () => {
  let fail = true;
  const run = harness({
    apiOverride: url => {
      if (!url.startsWith("/api/analysis?")) return undefined;
      return fail ? Promise.reject(new Error("synthetic read failure")) : undefined;
    },
  });
  run.context.portraitState.activeAnalysisScope = null;
  await run.click();
  assert.equal(run.context.labelState.manualRecentDeferred, false,
    "a failed read must not leave the deferred wait behind");
  assert.equal(run.context.labelState.manualRecentUserInitiated, false);
  assert.equal(run.context.labelState.intentActionState, "error");
  fail = false;
  await run.click();
  assert.equal(run.context.settingsState.settings.intent, true,
    "the second click must retry the read, not close intent recognition");
  assert.equal(run.posts().length, 1, "the retry submits the window analysis");
});

it("authoritative hydration clears an old running recent job, but a transport error does not", async () => {
  const run = harness();
  const recent = { id: "old", status: "running" };
  run.context.labelState.currentRecentJob = recent;
  run.context.renderJob({ status: "error", error: "Synthetic read failure" }, true, false);
  assert.equal(run.context.labelState.currentRecentJob, recent);
  await run.context.loadAnalysis("friend", 1, run.context.chatState.controller.signal);
  assert.equal(run.context.labelState.currentRecentJob, null);
  await run.click();
  assert.equal(run.posts().length, 1);
  assert.equal(run.context.labelState.currentRecentJob.id, "recent-1");
});

it("source switches clear transient local state and reject a local to API to local late read", async () => {
  let finish;
  let delay = true;
  const run = harness({ apiOverride: url => url.startsWith("/api/analysis?") && delay
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  const read = run.context.loadAnalysis("friend", 1, run.context.chatState.controller.signal);
  run.context.labelState.currentRecentJob = { id: "old", status: "running" };
  run.context.labelState.recentFailed = true;
  run.context.labelState.requestedRecentSignatures.add("old-window");
  run.context.applyActiveModelSource({ mode: "api", sourceId: "api:a" });
  assert.equal(run.context.labelState.currentRecentJob, null);
  assert.equal(run.context.labelState.recentFailed, false);
  assert.equal(run.context.labelState.requestedRecentSignatures.size, 0);
  delay = false;
  run.context.applyActiveModelSource(run.localSource);
  assert.equal(run.modelEvents.length, 2);
  assert.ok(run.modelEvents.every(event => event.type === "model-source-updated" && event.detail === undefined));
  await run.flush();
  finish({ account: "acct", results: { m1: { state: "done", labelSchema: "generic-v11" } },
    job: { recent: { id: "late", status: "running" } } });
  await read;
  assert.equal(run.context.labelState.currentRecentJob, null);
  assert.deepEqual(Object.keys(run.context.labelState.results), []);
  await run.click();
  assert.equal(run.posts().length, 1);
});

it("unknown source never captures or migrates an intent request to another source", async () => {
  const run = harness();
  run.context.beginUnknownModelSource();
  await run.click();
  assert.equal(run.context.labelState.intentRequestScope, null);
  assert.match(run.byId("stripStatusText").textContent, /正在读取模型来源/u);
  run.context.applyActiveModelSource(run.localSource);
  await run.flush();
  assert.equal(run.posts().length, 0);
});

it("normal recognition includes new loaded messages after file readiness without granting portraits", async () => {
  let finish;
  const run = harness({ ready: false, apiOverride: url => url === "/api/local-model"
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  await run.click();
  assert.equal(run.context.canAnalyzeLocal(), false);
  assert.equal(run.context.labelState.intentActionState, "waiting");
  assert.equal(run.posts().length, 0);
  run.candidates.push({ id: "new", side: "other", kind: "text", text: "Added after click" });
  finish({ state: "ready", source: "bundled", path: "synthetic-model" });
  await run.flush();
  assert.equal(run.context.canAnalyzeLocal(), true);
  assert.equal(run.posts().length, 1);
  assert.deepEqual(run.posts()[0].payload.targetIds, ["m1", "m2", "new"]);
  assert.equal(run.posts()[0].payload.mode, "recent");
  assert.equal(run.context.chatState.requestedConversations.size, 0);
  assert.equal(run.context.portraitState.autoIncrementalState.size, 0);
});

for (const outcome of ["missing", "failure"]) it(`unknown readiness stops waiting on ${outcome}`, async () => {
  let finish, fail;
  const run = harness({ ready: false, apiOverride: url => url === "/api/local-model"
    ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : undefined });
  await run.click();
  if (outcome === "missing") finish({ state: "missing", source: "none", path: "" });
  else fail(new Error("Synthetic local model status failure"));
  await run.flush();
  assert.equal(run.context.labelState.intentActionState, "error");
  assert.equal(run.context.labelState.manualRecentDeferred, false);
  assert.equal(run.posts().length, 0);
  assert.match(run.byId("analysisStatus").textContent, outcome === "missing" ? /未安装/u : /读取失败/u);
});

for (const stop of ["closed", "conversation", "source"]) it(`late readiness cannot submit after intent is ${stop}`, async () => {
  let finish;
  const run = harness({ ready: false, apiOverride: url => url === "/api/local-model"
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  await run.click();
  if (stop === "closed") await run.click();
  else if (stop === "conversation") {
    run.context.chatState.currentUser = "other";
    run.context.chatState.generation++;
    run.context.labelState.intentRequestScope = null;
    run.context.cancelRecentIntentWork();
  } else run.context.applyActiveModelSource({ mode: "api", sourceId: "api:a" });
  finish({ state: "ready", source: "bundled", path: "synthetic-model" });
  await run.flush();
  assert.equal(run.posts().length, 0);
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("file-ready Laya submits normally even while runtime weights are still idle", async () => {
  const run = harness();
  run.context.settingsState.runtimeSnapshot = { status: "idle", modelProvider: null };
  await run.click();
  assert.equal(run.posts().length, 1);
  assert.equal(run.context.labelState.intentActionState, "running");
});
