"use strict";
// The per-card "开始分析" button is the only way a conversation gets analysed: it persists the
// request, the background sweep walks that list, and every other analysis path refuses an
// unrequested conversation. These assertions read the real app.js and view-state.js, so they
// break if any of that stops being true.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");
const viewState = readFileSync(path.join(__dirname, "..", "chatui", "view-state.js"), "utf8").replace(/\r/gu, "");

// app.js formats top-level functions with the closing brace in column 0, so this returns the
// whole function and not a nested block inside it.
function body(signature) {
  const first = app.indexOf(signature);
  assert.ok(first >= 0, `Missing function: ${signature}`);
  const end = app.indexOf("\n}\n", first);
  assert.ok(end > first, `Unterminated function: ${signature}`);
  return app.slice(first, end + 3);
}

const renderSessions = body("function renderSessions() {");
const request = body("async function requestConversationAnalysis(");
const gate = body("function analysisBlockedWithoutRequest(");
const analyseMany = body("async function analyzeConversations(");
const sweep = body("async function backgroundAnalyzeAll(");

it("keeps the analyse request list separate from the added-conversation list", () => {
  // Adding a conversation to the sidebar is not a request to analyse it, so the two live in
  // different collections and only the button writes to the requested one.
  assert.match(viewState, /requestedConversations: new Set\(\)/u);
  assert.match(renderSessions, /selectedConversations\.has\(session\.username\)/u);
  assert.doesNotMatch(renderSessions, /selectedConversations\.add\(session\.username\)/u);
  // A request is persisted before anything is analysed, so a restart cannot lose it.
  assert.match(request, /requested: next/u);
  assert.ok(
    request.indexOf("/api/conversation-selection") < request.indexOf("analyzeConversations(["),
    "the request must be saved before the conversation is analysed",
  );
});

it("puts a per-card analyse button left of the contact name", () => {
  assert.match(renderSessions, /top\.append\(analyseBtn, element\("span", "session-name"\)/u);
  assert.match(renderSessions,
    /analyseBtn\.addEventListener\("click", \(event\) => \{\s*\n\s*event\.stopPropagation\(\);/u);
  // A click asks for analysis; it must not also switch conversations.
  const click = renderSessions.slice(renderSessions.indexOf("analyseBtn.addEventListener"),
    renderSessions.indexOf("switchSession"));
  assert.doesNotMatch(click, /switchSession/u);
});

it("gives the button two distinguishable states", () => {
  assert.match(renderSessions, /const requested = chatState\.requestedConversations\.has\(session\.username\)/u);
  assert.match(renderSessions, /requested \? "已加入分析" : "开始分析"/u);
  assert.match(renderSessions, /analyseBtn\.classList\.toggle\("requested", requested\)/u);
  assert.match(renderSessions, /analyseBtn\.ariaPressed = String\(requested\)/u);
});

it("refuses every analysis path for a conversation nobody requested", () => {
  // The gate is the single choke point: local incremental, the recent-window pass and the API
  // inline labelling all consult it before reaching the model.
  for (const signature of ["async function startIncremental(", "async function analyzeRecent(",
    "function ensureApiInsights("]) {
    assert.match(body(signature), /analysisBlockedWithoutRequest\(/u,
      `${signature} must consult the analysis request gate`);
  }
  // The gate must run before the availability checks, otherwise an unrequested conversation
  // looks like a broken model when no model is installed.
  const incremental = body("async function startIncremental(");
  assert.ok(incremental.indexOf("analysisBlockedWithoutRequest(") < incremental.indexOf("canAnalyzeLocal()"),
    "the gate has to run before canAnalyzeLocal()");
});

it("explains the refusal instead of failing silently", () => {
  assert.match(gate, /尚未加入分析/u);
  assert.match(gate, /setStripStatus\(hint\)/u);
  assert.match(gate, /if \(conversationAnalysisRequested\(user\)\) return false;/u);
});

it("analyses the clicked conversation immediately, not only via the background switch", () => {
  assert.match(request, /if \(next\) \{/u);
  // The open conversation goes through the normal entry point, which picks the API or local
  // branch and clears the refusal hint.
  assert.match(request, /username === chatState\.currentUser\) retryAnalysis\(\)/u);
  // The button is the request; the switch only governs the sweep that walks the list later.
  assert.doesNotMatch(request, /backgroundAnalyze/u);
});

it("sweeps only the conversations that were requested", () => {
  assert.match(sweep, /const order = \[\.\.\.chatState\.requestedConversations\]/u);
  assert.match(analyseMany, /if \(!chatState\.requestedConversations\.has\(id\)\) continue;/u);
});

it("loads the persisted request list on start-up", () => {
  const load = body("async function loadConversationSelection(");
  assert.match(load, /chatState\.requestedConversations\.clear\(\)/u);
  assert.match(load, /for \(const id of state\.requestedSessions\) chatState\.requestedConversations\.add\(id\)/u);
  // A response without the field is a broken contract, not an empty list.
  assert.match(body("function validConversationSelection("), /Array\.isArray\(state\.requestedSessions\)/u);
});
