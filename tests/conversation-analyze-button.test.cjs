"use strict";
// Explicit sidebar buttons persist cumulative analysis requests. The background sweep
// walks that list, and unrequested full-conversation paths refuse an
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

it("puts the analyse toggle on the session avatar instead of the name row", () => {
  // The control moved from a text button left of the name onto the avatar frame itself.
  assert.match(renderSessions, /element\("button", "session-avatar-action"\)/u);
  assert.match(renderSessions, /avatarWrap\.appendChild\(analyseBtn\)/u);
  assert.match(renderSessions, /top\.append\(element\("span", "session-name"\)/u);
  assert.doesNotMatch(renderSessions, /top\.append\(analyseBtn/u);
  assert.doesNotMatch(renderSessions, /session-analyze-btn/u);
  assert.match(renderSessions,
    /analyseBtn\.addEventListener\("click", \(event\) => \{\s*\n\s*event\.stopPropagation\(\);/u);
  // A click asks for analysis; it must not also switch conversations.
  const click = renderSessions.slice(renderSessions.indexOf("analyseBtn.addEventListener"),
    renderSessions.indexOf("switchSession"));
  assert.doesNotMatch(click, /switchSession/u);
});

it("draws the requested state on the avatar and keeps both states announced", () => {
  assert.match(renderSessions, /const requested = chatState\.requestedConversations\.has\(session\.username\)/u);
  // The ring is drawn on the wrap, which is where the avatar box is; the button has no text.
  assert.match(renderSessions, /avatarWrap\.classList\.toggle\("requested", requested\)/u);
  assert.match(renderSessions, /analyseBtn\.ariaPressed = String\(requested\)/u);
  assert.match(renderSessions, /analyseBtn\.ariaLabel = requested \? "已加入分析" : "开始分析"/u);
  assert.doesNotMatch(renderSessions, /analyseBtn\.textContent = label/u);
});

it("styles the requested ring without touching the row geometry", () => {
  const css = readFileSync(path.join(__dirname, "..", "chatui", "style.css"), "utf8").replace(/\r/gu, "");
  // The ring is drawn by a pseudo element inside the avatar box: a border would add 2px per side
  // and shift every neighbour, and an outside ring would sit on the card background, which the
  // open conversation already colours.
  const requested = css.slice(css.indexOf(".session-avatar-wrap.requested::after"));
  const rule = requested.slice(0, requested.indexOf("}"));
  assert.match(rule, /box-shadow: inset 0 0 0 2px var\(--color-green\)/u);
  assert.doesNotMatch(rule, /border:/u);
  // The hit area covers whatever size the wrap is given, instead of a fixed pixel box.
  const action = css.slice(css.indexOf(".session-avatar-action"), css.indexOf(".session-avatar-action") + 260);
  assert.match(action, /inset: 0/u);
  assert.match(action, /position: absolute/u);
  // The hint ring is thinner than the requested one, so the two states stay distinguishable.
  const hint = css.slice(css.indexOf(".session-avatar-wrap:hover::after"),
    css.indexOf(".session-avatar-wrap:hover::after") + 220);
  assert.match(hint, /inset 0 0 0 1px var\(--color-green\)/u);
  // The unread badge shares the corner with the ring; it has to paint above it, and its click
  // must reach the card (open the conversation) instead of the analyse toggle underneath.
  const dot = css.slice(css.indexOf(".session-unread-dot {"), css.indexOf(".session-unread-dot {") + 420);
  assert.match(dot, /z-index: 3/u);
  assert.doesNotMatch(dot, /pointer-events: none/u);
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
  assert.match(gate, /尚未加入会话分析/u);
  assert.match(gate, /setStripStatus\(hint\)/u);
  // The gate opens for the sidebar grant and for the header scope, which only authorizes
  // the loaded window; everything else is still refused with the hint above.
  assert.match(gate, /if \(conversationAnalysisRequested\(user\) \|\| currentIntentRequestScope\(\)\) return false;/u);
});

it("analyses the clicked conversation immediately, not only via the background switch", () => {
  assert.match(request, /if \(next\) \{/u);
  // The open conversation goes through the normal entry point, which picks the API or local
  // branch and clears the refusal hint.
  assert.match(request, /username === chatState\.currentUser\) retryAnalysis\(\)/u);
  // The button is the request; the switch only governs the sweep that walks the list later.
  assert.doesNotMatch(request, /backgroundAnalyze/u);
});

it("stops the backend job when the conversation is toggled off", () => {
  // Persisting a shorter list only suppresses *future* passes. The job that is already
  // queued or decoding has to be stopped explicitly, or the contact keeps being analysed.
  assert.match(request, /\/api\/analysis-cancel/u);
  assert.ok(
    request.indexOf("/api/conversation-selection") < request.indexOf("/api/analysis-cancel"),
    "the stop request must come after the list is persisted",
  );
});

it("marks sweep passes so the background switch can stop exactly those", () => {
  // A sweep pass and a hand click both reach /api/analyze. Marking the sweep is the only way
  // the switch can stop background work without killing an explicit request.
  assert.match(analyseMany, /background: true/u);
  const toggle = app.slice(app.indexOf('btnToggleBackgroundAnalyze").addEventListener'),
    app.indexOf('btnToggleBackgroundAnalyze").addEventListener') + 380);
  assert.match(toggle, /stopBackgroundAnalysis\(\)/u);
  const stop = body("async function stopBackgroundAnalysis(");
  assert.match(stop, /allBackground: true/u);
  assert.match(stop, /\/api\/analysis-cancel/u);
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
