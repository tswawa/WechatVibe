"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const app = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8").replace(/\r/g, "");
function section(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return app.slice(first, last);
}
function harness(api) {
  const effects = [];
  const context = vm.createContext({ api, chatState: { currentAccount: "acct", currentUser: "friend",
    sessions: new Map([["friend", {}], ["other", {}]]), selectedConversations: new Set(["friend", "other"]),
    requestedConversations: new Set(), conversationSelectionBusy: false, conversationSelectionGeneration: 0 },
    labelState: { intentActionState: "idle" }, setIntentActionState() {},
    conversationAnalysisRequested: username => context.chatState.requestedConversations.has(username),
    setStripStatus: text => effects.push(text), renderSessions: () => effects.push("render"),
    retryAnalysis: () => effects.push("current"), analyzeConversations: ids => effects.push([...ids]),
    loadAnalysisOverview: () => effects.push("overview"),
  });
  vm.runInContext(section("function validConversationSelection(", "function applyRequestedConversations(") +
    section("async function requestConversationAnalysis(", "/**\n *"), context);
  return { context, effects, request: username => context.requestConversationAnalysis(username) };
}
const selection = requestedSessions => ({ account: "acct", selectedSessions: ["friend", "other"], requestedSessions });
it("persists first, immediately analyzes exactly one requested conversation, and toggles it off", async () => {
  const posts = [];
  const run = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    posts.push({ url, body });
    if (url === "/api/analysis-cancel") return { cancelled: 1 };
    return selection(body.requested ? [body.session] : []);
  });
  await run.request("friend");
  assert.deepEqual(posts[0], { url: "/api/conversation-selection", body: { expectedAccount: "acct", session: "friend", requested: true } });
  assert.deepEqual(run.effects, ["render", "current"]);
  await run.request("friend");
  assert.equal(run.context.chatState.requestedConversations.size, 0);
  assert.equal(run.effects.filter(item => item === "current").length, 1);
  // Taking the contact off the list must also stop the job that is already running;
  // persisting the shorter list alone leaves the backend decoding that conversation.
  assert.deepEqual(posts.at(-1), { url: "/api/analysis-cancel", body: { account: "acct", user: "friend" } });
  await run.request("other");
  assert.deepEqual(run.effects.at(-1), ["other"]);
});
it("does not re-add a cancelled conversation when the stop request fails", async () => {
  const run = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === "/api/analysis-cancel") throw new Error("bridge busy");
    return selection(body.requested ? [body.session] : []);
  });
  await run.request("friend");
  await run.request("friend");
  assert.equal(run.context.chatState.requestedConversations.size, 0);
  assert.equal(run.context.chatState.conversationSelectionBusy, false);
  assert.match(run.effects.at(-1), /取消分析失败：bridge busy/);
});
it("failed or malformed persistence never starts analysis", async () => {
  for (const response of [() => { throw new Error("synthetic"); }, () => selection(["unselected"])]) {
    const run = harness(async () => response());
    await run.request("friend");
    assert.equal(run.context.chatState.requestedConversations.size, 0);
    assert.equal(run.context.chatState.conversationSelectionBusy, false);
    assert.match(run.effects[0], /保存分析请求失败/);
    assert.equal(run.effects.length, 1);
  }
});
it("does not carry an old account's request or its finally across an A-to-B-to-A reset", async () => {
  let finish;
  const run = harness(() => new Promise(resolve => { finish = resolve; }));
  const pending = run.request("friend");
  run.context.chatState.conversationSelectionGeneration += 2;
  run.context.chatState.conversationSelectionBusy = true; // a new visit is saving its own choice
  finish(selection(["friend"]));
  await pending;
  assert.equal(run.context.chatState.requestedConversations.size, 0);
  assert.equal(run.context.chatState.conversationSelectionBusy, true);
  assert.equal(run.effects.length, 0);
});
