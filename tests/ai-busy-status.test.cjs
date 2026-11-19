"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");
const { dom } = require("./helpers/synthetic-dom.cjs");

// Windows editors save these files with CRLF while Git stores LF, so source patterns below are
// matched against a normalised copy: the assertions describe the code, not the line endings.
const read = (...parts) => readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
const css = read("chatui", "style.css");

const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
function harness() {
  const ui = dom(), timers = new Map(), assistant = { ready: true, agentId: "helper", agentRevision: 1 };
  let timer = 0, insight = null;
  const context = vm.createContext({ ...ui, URLSearchParams,
    window: { Advisor: { getReplyContext: () => assistant }, addEventListener() {} },
    setTimeout: action => { timers.set(++timer, action); return timer; }, clearTimeout: id => timers.delete(id),
    setIntentActionState() {}, usingLocalFine: () => context.settingsState.modelSourceSnapshot.mode === "local",
    activeApiInsightEntry: () => insight, cachedProfileFor: () => null, apiPortraitHasContent: () => false,
    renderApiProfile() {}, updateApiProfileProgress() {}, apiPortraitContextReady: () => true,
    apiObservationCount: value => Number(value) || 0, apiCanReassessMbti: () => false,
    clearProfileView() {}, setStripStatus() {}, API_PORTRAIT_CONTEXT_HINT: "synthetic context hint",
  });
  seed(context, { currentAccount: "acct", currentUser: "friend", view: "persona", sessions: new Map(),
    requestedConversations: new Set(), settings: { intent: true }, modelSourceResolved: true,
    modelSourceSnapshot: { mode: "api", sourceId: "source-a" }, apiPortraitSubmitErrors: new Map() });
  vm.runInContext(section("function clearApiPortraitView()", "async function loadApiPortrait(") +
    section("const GUIDANCE_VERSION", "settingsState.runtimeSnapshot = null;") +
    section("function renderApiInsightStatus()", "function renderApiInsightResult(") +
    "\nthis.actions = { renderApiPortrait, clearApiPortraitView, cancelApiPortraitPoll, syncPortraitMode," +
    "renderApiInsightStatus, renderGuidance, syncGuidanceAction, syncGuidanceMode, clearGuidanceView };", context);
  return { ...ui, context, actions: context.actions, assistant, timers,
    setInsight(value) { insight = value; }, busy(id) { return ui.byId(id).classList.contains("ai-busy"); } };
}
function portrait(status, overrides = {}) {
  return { account: "acct", sourceId: "source-a", subject: "friend", portrait: null,
    inventoryReady: true, inventoryStatus: "ready", available: { textCount: 2, targetTextCount: 2 },
    progress: { complete: status === "done", processed: status === "done" ? 2 : 0 },
    job: { status }, ...overrides };
}
it("intent queued and running states spin, then completion, errors and a local switch clear it", () => {
  const run = harness();
  for (const status of ["queued", "running"]) {
    run.setInsight({ job: { status, total: 2, processed: 1 } }); run.actions.renderApiInsightStatus();
    assert.equal(run.busy("analysisStatus"), true, status);
    assert.match(run.byId("analysisStatus").textContent, /分析中/);
  }
  for (const entry of [{ job: { status: "done" } }, { error: "synthetic error" }, null]) {
    run.setInsight(entry); run.actions.renderApiInsightStatus();
    assert.equal(run.busy("analysisStatus"), false);
  }
  run.setInsight({ job: { status: "running" } }); run.actions.renderApiInsightStatus();
  run.context.settingsState.modelSourceSnapshot.mode = "local"; run.actions.renderApiInsightStatus();
  assert.equal(run.busy("analysisStatus"), false);
});
it("portrait reading, queued and running states spin without leaving motion on terminal or inactive states", () => {
  const run = harness();
  run.actions.clearApiPortraitView(); assert.equal(run.busy("apiPortraitStatus"), true);
  for (const data of [portrait("queued"), portrait("running"),
    portrait("idle", { inventoryReady: false })]) {
    run.actions.renderApiPortrait(data); assert.equal(run.busy("apiPortraitStatus"), true);
  }
  for (const data of [portrait("done"), portrait("error"),
    portrait("running", { suspended: true }), portrait("idle", { inventoryReady: false, inventoryStatus: "error" })]) {
    run.actions.renderApiPortrait(data); assert.equal(run.busy("apiPortraitStatus"), false);
  }
  run.actions.renderApiPortrait(portrait("running"));
  run.context.settingsState.modelSourceSnapshot.mode = "local"; run.actions.syncPortraitMode();
  assert.equal(run.busy("apiPortraitStatus"), false);
  assert.equal(run.byId("apiPortraitStatus").hidden, true);
});
it("reply generation keeps its spinner through the final action sync and clears on errors or missing assistant", () => {
  const run = harness(); run.context.chatState.view = "chat";
  for (const status of ["queued", "running"]) {
    run.actions.renderGuidance({ guidance: null, job: { status } });
    run.actions.syncGuidanceAction();
    assert.equal(run.busy("guidanceStatus"), true, status);
    assert.equal(run.byId("btnToolbarGuidance").disabled, true);
  }
  for (const status of ["done", "error", "insufficient"]) {
    run.actions.renderGuidance({ guidance: null, job: { status } });
    assert.equal(run.busy("guidanceStatus"), false, status);
  }
  run.context.portraitState.guidanceBusy = true;
  run.context.portraitState.guidanceStatusFailed = false;
  run.actions.syncGuidanceAction(); assert.equal(run.busy("guidanceStatus"), true);
  run.assistant.agentId = ""; run.actions.syncGuidanceAction();
  assert.equal(run.busy("guidanceStatus"), false);
  assert.match(run.byId("guidanceStatus").textContent, /启用助手/);
  run.assistant.agentId = "helper";
  run.actions.renderGuidance({ guidance: null, job: { status: "running" } });
  run.context.settingsState.modelSourceSnapshot.mode = "local"; run.actions.syncGuidanceMode();
  assert.equal(run.busy("guidanceStatus"), false);
});

it("the spinner is a css animation that respects reduced motion", () => {
  assert.match(css, /\.ai-busy::before \{[^}]*border-right-color: transparent[^}]*animation: ai-busy-spin \.8s linear infinite/);
  assert.match(css, /@keyframes ai-busy-spin \{ to \{ transform: rotate\(360deg\); \} \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\.ai-busy::before \{ animation: none;/);
});
