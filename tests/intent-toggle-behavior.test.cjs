"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const app = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8").replace(/\r/g, "");
function body(signature) {
  const start = app.indexOf(signature);
  const end = app.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, signature);
  return app.slice(start, end + 3);
}
const actionStart = app.indexOf('byId("btnToggleIntent").addEventListener("click",');
const actionEnd = app.indexOf('for (const [id, key] of [["selectThemeMode"', actionStart);
assert.ok(actionStart >= 0 && actionEnd > actionStart);
// The link/placeholder filter (`stripMessageLinks` -> `hasAnalyzableText`) sits between the
// model blocks these cases slice out, so carry it over whole instead of by signature.
const linkFilter = app.slice(app.indexOf("const MESSAGE_LINK_PATTERN"), app.indexOf("function hasIntentContent("));
assert.ok(linkFilter.includes("function hasAnalyzableText("), "app.js is missing the link filter");
const source = linkFilter + "\n" + [
  "function validConversationSelection(", "async function requestConversationAnalysis(",
  "function conversationAnalysisRequested(", "function currentIntentRequestScope(", "function analysisBlockedWithoutRequest(",
  "function fineWindow(", "function analyzableMessages(", "function fineMessageResult(",
  "function uncoveredMessages(", "function fineWindowSignature(", "function scheduleRecent(",
  "function hasIntentContent(", "function isIncompleteFragment(", "function apiInsightCandidates(", "function apiInsightSignature(",
  "function setIntentActionState(", "function renderRecentAction(", "function submitManualRecent(", "function prepareManualLocalIntent(", "function submitPickedMessages(",
  "function submitPickedApiInsights(", "function cancelRecentIntentWork(", "async function analyzeRecent(",
  "function apiInsightWorkCurrent(", "function cancelApiInsightWork(",
  "async function fetchApiInsightResults(", "function renderApiInsightStatus(",
  "async function submitApiInsightJob(", "function ensureApiInsights(", "async function toggleIntentRecognition(",
].map(body).join("\n") + "\nlet recentIntentController = null;\n" + app.slice(actionStart, actionEnd);

function harness(mode = "local", apiOverride, options = {}) {
  const nodes = new Map(), posts = [], requests = [], effects = [];
  const candidates = options.noCandidates ? [] : options.messages ||
    ["m1", "m2"].map(id => ({ id, side: "other", kind: "text", text: `Synthetic ${id}` }));
  const viewport = { top: Math.max(0, candidates.length - 4) * 100, height: 400 };
  let insightReadJob = { status: "idle" };
  function byId(id) {
    if (!nodes.has(id)) {
      const node = { hidden: false, textContent: "", dataset: {}, attributes: {}, listeners: {}, classes: new Set(),
        classList: { toggle(name, enabled) { if (enabled) node.classes.add(name); else node.classes.delete(name); } },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        getBoundingClientRect: () => ({ top: viewport.top, bottom: viewport.top + viewport.height, height: viewport.height }),
        querySelectorAll: () => candidates.map((message, index) => ({ dataset: { messageId: String(message.id) },
          getBoundingClientRect: () => ({ top: index * 100, bottom: (index + 1) * 100 }) })),
      };
      nodes.set(id, node);
    }
    return nodes.get(id);
  }
  const context = vm.createContext({ AbortController, AbortSignal, URLSearchParams, byId,
    setTimeout: () => 1, clearTimeout() {},
    CURRENT_LABEL_SCHEMA: "generic-v11", document: { hidden: false }, startupActive: false,
    chatState: { currentAccount: "acct", currentUser: "friend", generation: 1, view: "chat",
      sessions: new Map([["friend", {}], ["other", {}]]),
      selectedConversations: new Set(["friend", "other"]), requestedConversations: new Set(),
      conversationSelectionBusy: false, conversationSelectionGeneration: 1,
      controller: new AbortController(), messagePicking: false, historyState: null, messages: candidates },
    labelState: { intentActionState: "idle", intentRequestScope: null, recentPending: false, recentFailed: false,
      results: options.covered ? Object.fromEntries(candidates.map(message => [message.id,
        { state: "done", labelSchema: "generic-v11" }])) : {},
      requestedRecentSignatures: new Set(), apiInsightCache: new Map(), apiInsightWork: null },
    portraitState: { activeAnalysisScope: "scope", analysisGeneration: 1 },
    settingsState: { settings: { intent: true }, modelSourceResolved: true,
      localModelResolved: true, localModelReady: true,
      modelSourceSnapshot: { mode, sourceId: mode === "api" ? "api-a" : "local" },
      suppressedLocalAccounts: new Set(), suppressedApiSources: new Set() },
    save() {}, renderSessions() {}, refreshLabels() {}, updateProfileProgress() {}, cancelLocalProfilePoll() {},
    setStripStatus: value => effects.push(value), text: (id, value) => { byId(id).textContent = value; },
    canAnalyzeLocal: () => context.settingsState.modelSourceSnapshot.mode === "local",
    usingLocalFine: () => context.settingsState.modelSourceSnapshot.mode === "local",
    usingApiInsights: () => context.settingsState.modelSourceSnapshot.mode === "api",
    pickedWindow: () => ({ limit: 2, candidates: [candidates[1]] }),
    validApiInsight: (value, id) => value?.id === id && value.status === "ok",
    activeApiInsightKey: () => JSON.stringify([context.chatState.currentAccount, context.chatState.currentUser,
      context.settingsState.modelSourceSnapshot.sourceId]),
    activeApiInsightEntry: () => context.labelState.apiInsightCache.get(context.activeApiInsightKey()),
    parseApiPartialLabels: () => ({}), scheduleApiInsightPoll: () => effects.push("poll-api"),
    applySettings: () => context.setIntentActionState(context.labelState.intentActionState),
    startInlineIntentPending: () => effects.push("pending"), clearInlineIntentPending: () => effects.push("clear-pending"),
    // Mirror the real guard in app.js: a snapshot without `recent` only overwrites
    // the stored job when it is a complete snapshot. The old unconditional
    // assignment hid stale queued/running snapshots from every test.
    renderJob: (job, settlePending = true, completeSnapshot = true) => {
      effects.push("render-job");
      if (completeSnapshot || Object.hasOwn(job ?? {}, "recent")) context.labelState.currentRecentJob = job?.recent || null;
      context.renderRecentAction(job);
    }, loadAnalysis: async () => effects.push("read-analysis"),
    handleAccountBoundaryError: () => false, isNetworkFailure: () => false,
    retryAnalysis: () => effects.push("incremental"), analyzeConversations: () => effects.push("other-conversations"),
    toast: value => effects.push(value),
    api: async (url, options, signal) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, payload, signal });
      if (payload) posts.push({ url, payload, signal });
      if (apiOverride) {
        const custom = apiOverride(url, payload, signal);
        if (custom !== undefined) return custom;
      }
      if (url === "/api/conversation-selection") return { account: "acct",
        selectedSessions: ["friend", "other"], requestedSessions: payload.requested ? [payload.session] : [] };
      if (url === "/api/analyze") return { account: "acct", job: { recent: { id: "recent-1", status: "queued" } } };
      if (url === "/api/model-insights") {
        insightReadJob = { id: "api-1", status: "running" };
        return { account: "acct", sourceId: "api-a", job: insightReadJob };
      }
      if (url.startsWith("/api/model-insights?")) return { account: "acct", sourceId: "api-a",
        results: {}, job: insightReadJob };
      throw new Error(`Unexpected synthetic request: ${url}`);
    },
  });
  vm.runInContext(source, context);
  context.setIntentActionState("idle");
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, posts, requests, effects, byId, flush, options, viewport,
    async click() { byId("btnToggleIntent").listeners.click(); await flush(); await flush(); } };
}

for (const mode of ["local", "api"]) {
  it(`one explicit ${mode} click submits only window labels without granting cumulative analysis`, async () => {
    const run = harness(mode);
    assert.equal(run.byId("btnToggleIntent").attributes["aria-pressed"], "false",
      "the default display setting is not a conversation authorization");
    assert.equal(run.posts.length, 0, "opening a conversation does not submit work");
    await run.click();
    assert.equal(run.posts.length, 1);
    assert.equal(run.posts[0].url, mode === "api" ? "/api/model-insights" : "/api/analyze");
    assert.equal(run.posts[0].payload.user, "friend");
    assert.equal(run.context.chatState.requestedConversations.size, 0);
    assert.equal(run.byId("btnToggleIntent").attributes["aria-pressed"], "true");
    if (mode === "local") {
      assert.equal(run.posts[0].payload.mode, "recent");
      assert.equal(run.effects.includes("incremental"), false, "header submits labels without an extra portrait pass");
    }
    assert.deepEqual(run.posts[0].payload.targetIds, ["m1", "m2"]);
  });

  it(`re-enabling an authorized ${mode} conversation does not toggle its saved request off`, async () => {
    const run = harness(mode);
    run.context.chatState.requestedConversations.add("friend");
    run.context.settingsState.settings.intent = false;
    await run.click();
    assert.equal(run.posts.length, 1);
    assert.equal(run.posts[0].url, mode === "api" ? "/api/model-insights" : "/api/analyze");
    assert.equal(run.context.chatState.requestedConversations.has("friend"), true);
  });

  it(`the ${mode} intent action preserves a picked subset`, async () => {
    const run = harness(mode);
    run.context.chatState.messagePicking = true;
    await run.click();
    assert.equal(run.posts.length, 1);
    assert.deepEqual(run.posts[0].payload.targetIds, ["m2"]);
  });

  it(`${mode} failure makes the next click retry rather than close intent`, async () => {
    let attempts = 0;
    const targetUrl = mode === "api" ? "/api/model-insights" : "/api/analyze";
    const run = harness(mode, url => {
      if (url === targetUrl && ++attempts === 1) throw new Error("Synthetic provider failure");
    });
    await run.click();
    assert.equal(run.posts.length, 1);
    assert.equal(run.context.labelState.intentActionState, "error");
    await run.click();
    assert.equal(run.posts.length, 2);
    assert.equal(run.context.settingsState.settings.intent, true);
    assert.equal(run.context.chatState.requestedConversations.size, 0);
  });
}

it("switching account, conversation, or source before API hydration finishes never submits stale targets", async () => {
  for (const switchScope of [context => { context.chatState.currentAccount = "acct-b"; },
    context => { context.chatState.currentUser = "other"; context.chatState.generation++; },
    context => { context.settingsState.modelSourceSnapshot.sourceId = "api-b"; }]) {
    let finish;
    const run = harness("api", url => url.startsWith("/api/model-insights?") ? new Promise(resolve => { finish = resolve; }) : undefined);
    await run.click();
    assert.equal(run.posts.length, 0);
    switchScope(run.context);
    finish({ account: "acct", sourceId: "api-a", results: {}, job: { status: "idle" } });
    await run.flush();
    assert.equal(run.posts.length, 0);
    assert.equal(run.context.currentIntentRequestScope(), null);
  }
});

it("closing intent before API hydration finishes prevents late submission", async () => {
  let finish;
  const run = harness("api", url => url.startsWith("/api/model-insights?") ? new Promise(resolve => { finish = resolve; }) : undefined);
  await run.click();
  await run.click();
  finish({ account: "acct", sourceId: "api-a", results: {}, job: { status: "idle" } });
  await run.flush();
  assert.equal(run.posts.length, 0);
  assert.equal(run.context.settingsState.settings.intent, false);
  assert.equal(run.byId("btnToggleIntent").attributes["aria-pressed"], "false");
});

it("closing local intent aborts only its HTTP request and discards the late response", async () => {
  let finish;
  const run = harness("local", url => url === "/api/analyze" ? new Promise(resolve => { finish = resolve; }) : undefined);
  await run.click();
  const request = run.posts[0];
  assert.equal(request.signal.aborted, false);
  await run.click();
  assert.equal(request.signal.aborted, true);
  assert.equal(run.context.chatState.controller.signal.aborted, false, "chat and portrait ownership stays alive");
  assert.equal(run.context.labelState.recentPending, false);
  assert.equal(run.context.labelState.manualRecentAwaitingPost, false);
  finish({ job: { recent: { id: "late", status: "done" } } });
  await run.flush();
  assert.equal(run.effects.includes("render-job"), false);
  assert.equal(run.effects.includes("read-analysis"), false);
  run.context.submitManualRecent();
  assert.equal(run.posts.length, 1, "closed intent does not submit another recent pass");
});

it("closing API intent aborts its polling request without affecting the chat controller", async () => {
  const run = harness("api");
  await run.click();
  const work = run.context.labelState.apiInsightWork;
  await run.click();
  assert.equal(work.controller.signal.aborted, true);
  assert.equal(run.context.labelState.apiInsightWork, null);
  assert.equal(run.context.chatState.controller.signal.aborted, false);
  run.context.ensureApiInsights();
  assert.equal(run.posts.length, 1);
});

it("the next local refresh cannot turn header labels into full-history or portrait work", async () => {
  const run = harness("local");
  await run.click();
  run.context.portraitState.autoIncrementalState = new Map();
  vm.runInContext(["function incrementalState(", "async function startIncremental(",
    "function scheduleIncremental("].map(body).join("\n"), run.context);
  run.context.scheduleIncremental("friend", 1, run.context.chatState.controller.signal,
    { job: { status: "done" } }, false, "same-window");
  await run.flush();
  assert.equal(run.posts.length, 1);
  assert.equal(run.context.portraitState.autoIncrementalState.size, 0);
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("API header picking waits for hydration, then posts the subset and keeps running polls", async () => {
  let finish;
  let firstRead = true;
  const run = harness("api", url => {
    if (url.startsWith("/api/model-insights?") && firstRead) {
      firstRead = false;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  run.context.chatState.messagePicking = true;
  await run.click();
  assert.equal(run.posts.length, 0, "no POST may race the initial idle GET");
  finish({ account: "acct", sourceId: "api-a", results: {}, job: { status: "idle" } });
  await run.flush();
  await run.flush();
  assert.equal(run.posts.length, 1);
  assert.deepEqual(run.posts[0].payload.targetIds, ["m2"]);
  assert.equal(run.context.activeApiInsightEntry().job.status, "running");
  assert.ok(run.effects.includes("poll-api"));
});

it("entering picking pauses an earlier whole-window header request before hydration", async () => {
  let finish;
  const run = harness("api", url => url.startsWith("/api/model-insights?") ? new Promise(resolve => { finish = resolve; }) : undefined);
  await run.click();
  run.context.chatState.messagePicking = true;
  finish({ account: "acct", sourceId: "api-a", results: {}, job: { status: "idle" } });
  await run.flush();
  assert.equal(run.posts.length, 0);
});

it("a local to API to local switch clears label scope and discards the old local request", async () => {
  let finish;
  const run = harness("local", url => url === "/api/analyze" ? new Promise(resolve => { finish = resolve; }) : undefined);
  for (const name of ["syncPortraitMode", "syncGuidanceMode", "renderModelBadge", "cancelMessageRegeneration",
    "cancelApiPortraitPoll", "clearApiPortraitView", "setMessagePicking", "resumeLocalAnalysis", "loadGuidance"])
    run.context[name] = () => {};
  vm.runInContext(body("function applyActiveModelSource("), run.context);
  await run.click();
  const request = run.posts[0];
  run.context.applyActiveModelSource({ mode: "api", sourceId: "api-a" });
  run.context.applyActiveModelSource({ mode: "local", sourceId: "local" });
  assert.equal(run.context.labelState.intentRequestScope, null);
  assert.equal(run.context.currentIntentRequestScope(), null);
  assert.equal(request.signal.aborted, true);
  assert.equal(run.context.labelState.manualRecentDeferred, false);
  assert.equal(run.context.labelState.manualRecentAwaitingPost, false);
  finish({ job: { recent: { id: "late", status: "done" } } });
  await run.flush();
  assert.equal(run.posts.length, 1);
  assert.equal(run.effects.includes("render-job"), false);
  assert.equal(run.byId("btnToggleIntent").attributes["aria-pressed"], "false");
});

it("normal local recognition follows newly loaded messages without granting portrait analysis", async () => {
  const run = harness("local");
  await run.click();
  run.context.labelState.results = { m1: { state: "done", labelSchema: "generic-v11" },
    m2: { state: "done", labelSchema: "generic-v11" } };
  run.context.labelState.currentRecentJob = { status: "done" };
  run.context.scheduleRecent("friend", 1, run.context.chatState.controller.signal, true);
  await run.flush();
  assert.equal(run.posts.length, 1, "completed messages are not submitted again");
  run.context.chatState.messages.push({ id: "new", side: "other", kind: "text", text: "New synthetic message" });
  run.context.scheduleRecent("friend", 1, run.context.chatState.controller.signal, true);
  await run.flush();
  assert.equal(run.posts.length, 2);
  assert.deepEqual(run.posts.at(-1).payload.targetIds, ["m1", "m2", "new"]);
  assert.equal(run.posts.at(-1).payload.mode, "recent");
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("normal API recognition follows new loaded messages after the existing batch completes", async () => {
  const run = harness("api");
  await run.click();
  const entry = run.context.activeApiInsightEntry();
  entry.job = { status: "done" };
  entry.sessionReady = true;
  entry.results = { m1: { id: "m1", status: "ok" }, m2: { id: "m2", status: "ok" } };
  run.context.ensureApiInsights();
  await run.flush();
  assert.equal(run.posts.length, 1);
  run.context.chatState.messages.push({ id: "new", side: "other", kind: "text", text: "New synthetic message" });
  run.context.ensureApiInsights();
  await run.flush();
  assert.equal(run.posts.length, 2);
  assert.deepEqual(run.posts.at(-1).payload.targetIds, ["new"]);
  assert.equal(run.context.chatState.requestedConversations.size, 0);
});

it("local recognition includes all loaded targets above the four visible bubbles", async () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    ({ id: `m${index}`, side: "other", kind: "text", text: `Synthetic ${index}` }));
  const run = harness("local", undefined, { messages });
  await run.click();
  assert.deepEqual(run.posts[0].payload.targetIds, messages.map(message => message.id));
  assert.equal(run.posts[0].payload.limit, 20);
  for (const layout of [{ top: 0, height: 200 }, { top: 900, height: 500 }, { top: 1600, height: 400 }]) {
    Object.assign(run.viewport, layout);
    assert.deepEqual(Array.from(run.context.fineWindow().candidates, message => message.id), messages.map(message => message.id));
  }
});

it("local recognition targets only other text and keeps the full loaded window for context", async () => {
  const messages = [
    { id: "self", side: "self", kind: "text", text: "Synthetic question" },
    { id: "other", side: "other", kind: "text", text: "Synthetic answer" },
    { id: "image", side: "other", kind: "image", text: "[image]" },
    { id: "empty", side: "other", kind: "text", text: "  " },
  ];
  const run = harness("local", undefined, { messages });
  await run.click();
  assert.equal(run.posts[0].payload.limit, 4);
  assert.deepEqual(run.posts[0].payload.targetIds, ["other"]);
});

it("local recognition uses at most the loaded recent 80 and never requests history pages", async () => {
  const messages = Array.from({ length: 90 }, (_, index) =>
    ({ id: `m${index}`, side: "other", kind: "text", text: `Synthetic ${index}` }));
  const run = harness("local", undefined, { messages });
  await run.click();
  assert.equal(run.posts[0].payload.limit, 80);
  assert.deepEqual(run.posts[0].payload.targetIds, messages.slice(-80).map(message => message.id));
  assert.equal(run.requests.some(request => request.url.startsWith("/api/history")), false);
});

for (const boundary of ["account", "conversation", "generation", "source", "history", "picking"]) {
  it(`normal local recognition stops at the ${boundary} boundary`, async () => {
    const run = harness("local");
    await run.click();
    run.context.chatState.messages.push({ id: "new", side: "other", kind: "text", text: "New synthetic message" });
    run.context.labelState.currentRecentJob = { status: "done" };
    if (boundary === "account") run.context.chatState.currentAccount = "another-account";
    if (boundary === "conversation") run.context.chatState.currentUser = "other";
    if (boundary === "generation") run.context.chatState.generation++;
    if (boundary === "source") run.context.settingsState.modelSourceSnapshot.sourceId = "another-local-source";
    if (boundary === "history") run.context.chatState.historyState = {};
    if (boundary === "picking") run.context.chatState.messagePicking = true;
    run.context.scheduleRecent(run.context.chatState.currentUser, run.context.chatState.generation,
      run.context.chatState.controller.signal, true);
    await run.flush();
    assert.equal(run.posts.length, 1);
    assert.equal(run.context.chatState.requestedConversations.size, 0);
  });
}

for (const mode of ["local", "api"]) {
  it(`a picked ${mode} scope remains fixed after leaving selection and receiving new messages`, async () => {
    const run = harness(mode);
    run.context.chatState.messagePicking = true;
    await run.click();
    run.context.chatState.messagePicking = false;
    run.context.chatState.messages.push({ id: "new", side: "other", kind: "text", text: "New synthetic message" });
    if (mode === "local") {
      run.context.labelState.currentRecentJob = { status: "done" };
      run.context.scheduleRecent("friend", 1, run.context.chatState.controller.signal, true);
    } else {
      run.context.activeApiInsightEntry().job = { status: "done" };
      run.context.activeApiInsightEntry().requestedSignature = null;
      run.context.ensureApiInsights();
    }
    await run.flush();
    assert.equal(run.posts.length, 2);
    assert.deepEqual(run.posts.at(-1).payload.targetIds, ["m2"]);
    assert.equal(run.context.chatState.requestedConversations.size, 0);
  });
}

it("cancelling intent work drops the stale job snapshot so the next click submits again", async () => {
  const run = harness("local");
  await run.click();
  assert.equal(run.posts.length, 1);
  // A source/account switch cancels the in-flight run while the last known job
  // still reads "running"; keeping it made submitManualRecent() return silently.
  run.context.labelState.currentRecentJob = { id: "old", status: "running" };
  run.context.cancelRecentIntentWork();
  assert.equal(run.context.labelState.currentRecentJob, null, "cancel clears the previous source snapshot");
  run.context.submitManualRecent();
  await run.flush();
  assert.equal(run.posts.length, 2, "a stale running snapshot must not swallow the click");
  assert.equal(run.posts.at(-1).url, "/api/analyze");
});

it("a click with no recognisable candidate says so instead of doing nothing", async () => {
  const run = harness("local", undefined, { noCandidates: true });
  await run.click();
  assert.equal(run.posts.length, 0);
  assert.equal(run.context.labelState.intentActionState, "done");
  assert.match(run.byId("btnToggleIntent").title, /没有可识别的消息/);
});

it("an automatic resume never announces completion the user did not ask for", async () => {
  const run = harness("local", undefined, { covered: true });
  run.context.chatState.requestedConversations.add("friend");
  // applyActiveModelSource() clears the scope, then resumes automatically.
  run.context.labelState.intentRequestScope = null;
  run.context.submitManualRecent();
  await run.flush();
  assert.equal(run.posts.length, 0);
  assert.equal(run.context.labelState.intentActionState, "idle",
    "an unrequested resume must not flash 识别完成");
  assert.doesNotMatch(run.byId("btnToggleIntent").title || "", /已读取|没有可识别/,
    "an unrequested resume must not rewrite the button tooltip");
});

it("a profile refresh cannot revive a cancelled job snapshot", async () => {
  const run = harness("local");
  await run.click();
  assert.equal(run.posts.length, 1);
  const remembered = { status: "running", recent: { id: "old", status: "running" } };
  run.context.portraitState.currentAnalysisJob = remembered;
  run.context.cancelRecentIntentWork();
  assert.equal(remembered.recent, null, "the remembered job drops the cancelled snapshot");
  // loadProfile() replays the remembered job with a complete snapshot.
  run.context.renderJob(remembered);
  assert.equal(run.context.labelState.currentRecentJob, null);
});

it("a covered window with a captured scope reports its own count, including skipped", async () => {
  const run = harness("local");
  await run.click();
  assert.equal(run.posts.length, 1);
  run.context.cancelRecentIntentWork();
  run.context.labelState.results = { m1: { state: "done", labelSchema: "generic-v11" }, m2: { state: "skipped" } };
  run.options.covered = true;
  run.context.submitManualRecent();
  await run.flush();
  assert.equal(run.posts.length, 1, "an already covered scope is not re-requested");
  assert.equal(run.context.labelState.intentActionState, "done");
  assert.match(run.byId("btnToggleIntent").title, /已读取 2 条识别结果（跳过 1 条）/);
});
