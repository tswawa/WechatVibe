"use strict";
// A4 test-only bridge: lets existing assertions keep referring to the old bare
// names while the real ViewState instances own the values. Production code never
// uses this; it exists only inside the vm test contexts.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const VIEW_STATE_SOURCE = readFileSync(path.join(__dirname, "..", "..", "chatui/view-state.js"), "utf8");

// The per-card analyse request gates every analysis path in app.js. Tests slice app.js by
// section markers, so ship the gate itself here: that keeps the rule in one place in
// production code and keeps `requestedConversations` authoritative in tests. Function
// declarations are redeclarable, so a slice that also carries them is harmless.
const APP_SOURCE = readFileSync(path.join(__dirname, "..", "..", "chatui/app.js"), "utf8");
const GATE_SOURCE = (() => {
  const start = APP_SOURCE.indexOf("function conversationAnalysisRequested(");
  const end = APP_SOURCE.indexOf("/** Analyse exactly the given conversations", start);
  if (start < 0 || end <= start) throw new Error("app.js is missing the analysis request gate");
  return APP_SOURCE.slice(start, end);
})();

const DOMAIN_FIELDS = {
  chat: ["sessions", "selectedConversations", "requestedConversations", "selectionLoadedAccount",
    "conversationSelectionBusy",
    "sessionCache", "historyState", "historyRequest", "historyController", "historySearchRequest",
    "historySearchController", "historySearchPending", "historySearchPage", "historySearchPageStarts",
    "historySearchQuery", "self", "sessionSignature", "sessionRequest", "sessionLoading",
    "sessionRefreshQueued", "windowRequestSerial", "preloadDone", "preloadTotal", "currentAccount",
    "currentUser", "currentHasMoreBefore", "messageSourceReady", "view", "generation", "controller",
    "messages", "messagePicking", "selectedMessageIds", "messagePending", "messageRequest",
    "messageRefreshQueued", "emptyMessagePolls",
    "conversationMood", "followLatest", "lastChatScrollTop"],
  labels: ["results", "currentRecentJob", "inlineIntentPending", "inlineIntentJobId", "recentFailed",
    "requestedRecentSignatures", "recentPending", "intentActionState", "intentFeedbackTimer",
    "manualRecentAwaitingPost", "manualRecentJobId", "manualRecentDeferred", "recentNetworkFailed",
    "selectedAnalysisTimer", "catalogReady", "intentDisplayAliases", "emotionDisplayAliases",
    "catalogLabelRevision", "messageLabels", "apiInsightCache", "apiInsightWork",
    "apiInsightViewportTimer", "apiInsightStatusRendered"],
  portrait: ["profileCache", "profileSnapshotsRequireRefresh", "profileGeneration", "analysisGeneration",
    "autoIncrementalState", "activeAnalysisScope", "currentAnalysisJob", "incrementalFailed",
    "analysisNetworkFailed", "activeMember", "profilePending", "groupMembers", "renderedProfileKey",
    "renderedProfileSignature", "memberRenderedScope", "storedProfileSnapshots",
    "storedProfileSelections", "profileRateSamples", "apiPortraitRequest", "apiPortraitPollTimer",
    "apiPortraitSnapshot", "apiPortraitBusy", "renderedApiPortraitKey", "apiPortraitLoadingKey",
    "apiPortraitSubmitErrors", "apiPortraitReadFailures", "renderedApiPortraitScopeKey",
    "renderedApiProfileScope", "renderedApiProfileSignature", "apiPortraitProgressNode"],
  settings: ["settings", "runtimeSnapshot", "runtimeRequest", "runtimeBusy", "runtimePollTimer", "localModelRequest",
    "localModelDownloadBusy", "localModelReady", "localModelResolved", "modelSourceSnapshot",
    "modelSourceResolved", "modelSourceReadRequest", "modelSourceLoadController", "modelSourceRevision",
    "modelListRequest", "modelListController", "modelTestRequest", "modelTestController",
    "modelSourceLoading", "modelSourceBusy", "modelListBusy", "modelTestBusy", "modelSourceDraftDirty",
    "suppressedApiSources", "suppressedLocalAccounts"],
};

const DOMAIN_FOR = {};
for (const [domain, fields] of Object.entries(DOMAIN_FIELDS)) {
  for (const field of fields) DOMAIN_FOR[field] = domain;
}

/**
 * Give every test context the status sinks the analysis gate writes to.
 *
 * The gate explains why it refused an analysis, which means it touches the strip and the
 * analysis status line. A context that already stubs those keeps its own version, so this
 * only fills gaps and never changes what an existing assertion observes.
 */
function installStatusSinks(context) {
  if (typeof context.byId !== "function") {
    const nodes = new Map();
    context.byId = (id) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, textContent: "", hidden: true, dataset: {}, style: {}, value: "", disabled: false,
          children: [], classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
          append() {}, appendChild() { return this; }, replaceChildren() {}, addEventListener() {},
          setAttribute() {}, removeAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        });
      }
      return nodes.get(id);
    };
  }
  if (typeof context.text !== "function") {
    context.text = (id, value) => { context.byId(id).textContent = String(value ?? ""); };
  }
  if (typeof context.setStripStatus !== "function") context.setStripStatus = () => {};
}

// Install the real ViewState into an existing vm context and alias old names.
function installViewState(context) {  if (context.__viewStateInstances) return context.__viewStateInstances;
  if (!context.window) context.window = context;
  vm.runInContext(VIEW_STATE_SOURCE, context);
  installStatusSinks(context);
  vm.runInContext(GATE_SOURCE, context);
  context.ViewState = context.window.ViewState;
  const states = {
    chat: vm.runInContext('ViewState.create("chat")', context),
    labels: vm.runInContext('ViewState.create("labels")', context),
    portrait: vm.runInContext('ViewState.create("portrait")', context),
    settings: vm.runInContext('ViewState.create("settings")', context),
  };
  context.chatState = states.chat;
  context.labelState = states.labels;
  context.portraitState = states.portrait;
  context.settingsState = states.settings;
  context.ViewState = vm.runInContext("ViewState", context);
  for (const [name, domain] of Object.entries(DOMAIN_FOR)) {
    const state = states[domain];
    if (Object.prototype.hasOwnProperty.call(context, name)) state[name] = context[name];
    // Alias reads/writes so a bare `currentUser` in the test maps to chatState.currentUser.
    Object.defineProperty(context, name, {
      configurable: true,
      enumerable: true,
      get() { return state[name]; },
      set(value) { state[name] = value; },
    });
  }
  context.__viewStateInstances = states;
  return states;
}

// Apply the values the test wants to seed, then alias; never two sources of truth.
function seed(context, values) {
  const states = installViewState(context);
  for (const [name, value] of Object.entries(values)) {
    const domain = DOMAIN_FOR[name];
    if (!domain) throw new Error(`unknown view-state seed: ${name}`);
    states[domain][name] = value;
  }
  return states;
}

module.exports = { installViewState, seed, DOMAIN_FIELDS, DOMAIN_FOR };
