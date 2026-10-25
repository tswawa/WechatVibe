"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { dom } = require("./helpers/synthetic-dom.cjs");

const app = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
const start = app.indexOf('const GUIDANCE_VERSION'), end = app.indexOf('settingsState.runtimeSnapshot = null;', start);
assert.ok(start >= 0 && end > start);
const settle = () => new Promise(resolve => setImmediate(resolve));
const choices = (prefix = "合成回复") => ({
  kind: "reply-options", version: "api-reply-options-v2",
  replies: [{ text: prefix + "一" }, { text: prefix + "二" }, { text: prefix + "三" }],
});
function response(overrides = {}) {
  return { account: "acct", sourceId: "source-v1", subject: "friend", version: "api-reply-options-v2",
    agentId: "advisor", agentRevision: 1,
    guidance: choices(), job: { status: "done", replyOptions: true }, ...overrides };
}
function harness(fetcher) {
  const ui = dom(), calls = [], clipboard = [], timers = new Map();
  const assistant = { ready: true, agentId: "advisor", agentRevision: 1 }, listeners = new Map();
  const window = { Advisor: { getReplyContext: () => ({ ...assistant }) },
    addEventListener: (name, handler) => listeners.set(name, handler) };
  let timer = 0;
  const context = vm.createContext({
    ...ui, URLSearchParams, window,
    chatState: { currentAccount: "acct", currentUser: "friend", view: "chat", controller: null },
    portraitState: {},
    settingsState: { modelSourceResolved: true, modelSourceSnapshot: { mode: "api", sourceId: "source-v1" } },
    copyText: async text => { clipboard.push(text); return true; },
    modelSourceRequestError: () => "合成错误",
    setTimeout: fn => { timers.set(++timer, fn); return timer; },
    clearTimeout: id => timers.delete(id),
    api: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      return fetcher ? fetcher(url, body) : response();
    },
  });
  vm.runInContext(app.slice(start, end) +
    "\nthis.actions={loadGuidance,startGuidance,syncGuidanceMode,clearGuidanceView,copyReplyChoice};", context);
  context.actions.syncGuidanceMode();
  return { ...ui, context, actions: context.actions, calls, clipboard, timers, assistant,
    changeAssistant(value) { Object.assign(assistant, value); listeners.get("advisor-selection-changed")?.(); } };
}
it("shows exactly three disabled empty choices before generation with no input field", () => {
  const run = harness();
  for (let i = 0; i < 3; i++) {
    assert.equal(run.byId("replyChoice" + i).disabled, true);
    assert.equal(run.byId("replyChoiceText" + i).textContent, "");
  }
  const html = readFileSync(path.join(__dirname, "../chatui/index.html"), "utf8");
  assert.equal([...html.matchAll(/data-reply-index="/g)].length, 3);
  assert.doesNotMatch(html, /id="(?:chatInput|btnSend|guidanceView|guidanceBody|replyDraftEditor)"/);
  assert.doesNotMatch(app, /byId\("(?:chatInput|btnSend|guidanceView|guidanceBody)"\)/);
});
it("the actual icon generates from context without a draft, portrait target or extra analysis", async () => {
  const run = harness();
  run.context.portraitState.activeMember = "unrelated-person";
  run.byId("btnToolbarGuidance").fire("click");
  await settle();
  assert.deepEqual(run.calls[0], { url: "/api/model-guidance", body: {
    account: "acct", user: "friend", sourceId: "source-v1", replyOptions: true, agentId: "advisor", agentRevision: 1,
    windowMinutes: 1440,
  } });
  assert.equal(run.calls[1].url, "/api/model-guidance?user=friend&replyOptions=true&agentId=advisor&agentRevision=1");
  for (let i = 0; i < 3; i++) {
    assert.equal(run.byId("replyChoiceText" + i).textContent, "合成回复" + ["一","二","三"][i]);
    assert.equal(run.byId("replyChoice" + i).disabled, false);
  }
  assert.deepEqual(run.clipboard, []);
  assert.equal(run.byId("guidanceStatus").textContent, "");
});
it("clicking each choice copies only that text and never creates another model request", async () => {
  const run = harness();
  await run.actions.loadGuidance();
  const count = run.calls.length;
  for (let i = 0; i < 3; i++) run.byId("replyChoice" + i).fire("click");
  await settle();
  assert.deepEqual(run.clipboard, ["合成回复一", "合成回复二", "合成回复三"]);
  assert.equal(run.calls.length, count);
});
it("a second explicit click generates again and replaces all three choices", async () => {
  let turn = 0;
  const run = harness((_url, body) => {
    if (body) { turn++; return response({ job: { status: "queued", replyOptions: true } }); }
    return response({ guidance: choices(turn > 1 ? "新回复" : "旧回复") });
  });
  run.byId("btnToolbarGuidance").fire("click"); await settle();
  assert.equal(run.byId("replyChoiceText0").textContent, "旧回复一");
  run.byId("btnToolbarGuidance").fire("click"); await settle();
  assert.equal(run.calls.filter(call => call.body).length, 2);
  for (let i = 0; i < 3; i++) assert.match(run.byId("replyChoiceText" + i).textContent, /^新回复/);
});
it("loading a saved set restores it without generating or charging a new request", async () => {
  const run = harness();
  await run.actions.loadGuidance(); await run.actions.loadGuidance();
  assert.equal(run.calls.filter(call => call.body).length, 0);
  assert.equal(run.byId("replyChoiceText0").textContent, "合成回复一");
});
it("double clicks cannot create multiple pending submissions", async () => {
  let finish;
  const run = harness((_url, body) => body
    ? new Promise(resolve => { finish = resolve; }) : response());
  const first = run.actions.startGuidance();
  assert.equal(run.byId("btnToolbarGuidance").disabled, true);
  run.byId("btnToolbarGuidance").fire("click");
  await settle();
  assert.equal(run.calls.length, 1);
  finish(response({ job: { status: "queued", replyOptions: true } }));
  await first;
  assert.equal(run.calls.filter(call => call.body).length, 1);
  assert.equal(run.byId("btnToolbarGuidance").disabled, false);
});
it("polling ends at completion and permits another explicit generation", async () => {
  let done = false;
  const run = harness((_url, body) => body ? response({ guidance: null, job: { status: "queued" } }) :
    done ? response() : response({ guidance: null, job: { status: "running" } }));
  await run.actions.startGuidance();
  assert.equal(run.timers.size, 1);
  assert.equal(run.byId("btnToolbarGuidance").disabled, true);
  done = true;
  const [id, poll] = [...run.timers][0]; run.timers.delete(id); poll(); await settle();
  assert.equal(run.timers.size, 0);
  assert.equal(run.byId("btnToolbarGuidance").disabled, false);
  assert.equal(run.byId("replyChoice0").disabled, false);
  assert.equal(run.calls.filter(call => call.body).length, 1);
});

it("reports automatic retries instead of leaving an indistinguishable running state", async () => {
  const run = harness(() => response({ guidance: null, job: { status: "running", retry: {
    reason: "rate-limit", attempt: 2, max: 10, nextAtMs: Date.now() + 3000 } } }));
  await run.actions.loadGuidance();
  assert.match(run.byId("guidanceStatus").textContent, /接口请求受限/);
  assert.match(run.byId("guidanceStatus").textContent, /秒后重试 2\/10/);
  assert.equal(run.timers.size, 1);
});
it("account, conversation, model and assistant ABA transitions reject late GET and POST responses", async () => {
  for (const field of ["account", "conversation", "model", "assistant", "revision"]) for (const method of ["get", "post"]) {
    let finish;
    const run = harness(() => new Promise(resolve => { finish = resolve; }));
    const pending = method === "get" ? run.actions.loadGuidance() : run.actions.startGuidance();
    const object = ["assistant", "revision"].includes(field) ? run.assistant :
      field === "model" ? run.context.settingsState.modelSourceSnapshot : run.context.chatState;
    const key = field === "assistant" ? "agentId" : field === "revision" ? "agentRevision" :
      field === "model" ? "sourceId" : field === "account" ? "currentAccount" : "currentUser";
    const previous = object[key];
    object[key] = "other"; run.actions.syncGuidanceMode();
    object[key] = previous; run.actions.syncGuidanceMode();
    finish(response()); await pending;
    assert.equal(run.context.portraitState.guidanceSnapshot, null);
    assert.equal(run.byId("replyChoice0").disabled, true);
    assert.equal(run.calls.length, 1);
  }
});
it("changing scopes disables old choice text and blocks copying stale results", async () => {
  const run = harness(); await run.actions.loadGuidance();
  run.context.chatState.currentUser = "other"; run.actions.syncGuidanceMode();
  run.byId("replyChoice0").fire("click"); await settle();
  assert.deepEqual(run.clipboard, []);
  assert.equal(run.byId("replyChoiceText0").textContent, "");
  assert.equal(run.byId("replyChoice0").disabled, true);
});
it("local mode and an unresolved model cannot submit or copy API choices", async () => {
  for (const state of ["local", "unresolved", "view"]) {
    const run = harness(); await run.actions.loadGuidance();
    if (state === "local") run.context.settingsState.modelSourceSnapshot.mode = "local";
    if (state === "unresolved") run.context.settingsState.modelSourceResolved = false;
    if (state === "view") run.context.chatState.view = "persona";
    run.actions.syncGuidanceMode();
    const count = run.calls.length;
    await run.actions.startGuidance(); await run.actions.loadGuidance();
    run.byId("replyChoice0").fire("click"); await settle();
    assert.equal(run.calls.length, count);
    assert.deepEqual(run.clipboard, []);
  }
});
it("invalid counts, duplicates, legacy analysis and foreign metadata cannot become reply options", async () => {
  for (const invalid of [
    { guidance: { ...choices(), replies: [{ text: "只有一条" }] } },
    { guidance: { ...choices(), replies: [{ text: "重复" }, { text: "重复" }, { text: "另一条" }] } },
    { guidance: { ...choices(), kind: "analysis" } },
    { guidance: { ...choices(), version: "api-guidance-v5" } },
    { subject: "other" }, { account: "other" }, { sourceId: "other" }, { version: "old" },
    { agentId: "other" }, { agentRevision: 2 }, { agentRevision: "1" },
  ]) {
    const run = harness(() => response(invalid));
    await run.actions.loadGuidance();
    assert.equal(run.context.portraitState.guidanceSnapshot, null);
    assert.equal(run.byId("replyChoice0").disabled, true);
    assert.match(run.byId("guidanceStatus").textContent, /读取失败/);
  }
});
it("rendering treats model output as plain text", async () => {
  const data = choices();
  data.replies[0].text = "<img src=x onerror=alert(1)>";
  const run = harness(() => response({ guidance: data }));
  await run.actions.loadGuidance();
  assert.equal(run.byId("replyChoiceText0").textContent, data.replies[0].text);
  assert.equal(run.byId("replyChoiceText0").children.length, 0);
});
it("generation failure keeps the last usable three replies and restores retry", async () => {
  const run = harness((_url, body) => { if (body) throw new Error("synthetic failure"); return response(); });
  await run.actions.loadGuidance();
  await run.actions.startGuidance();
  assert.equal(run.byId("replyChoiceText0").textContent, "合成回复一");
  assert.equal(run.byId("btnToolbarGuidance").disabled, false);
  assert.equal(run.calls.filter(call => call.body).length, 1);
  assert.deepEqual(run.clipboard, []);
});
it("no-target and paused-cache terminal states end generation without inventing replies", async () => {
  for (const state of ["insufficient", "suspended"]) {
    const run = harness(() => response({ guidance: null, job: { status: state } }));
    await run.actions.startGuidance();
    assert.equal(run.byId("btnToolbarGuidance").disabled, false);
    assert.equal(run.byId("replyChoice0").disabled, true);
    assert.equal(run.calls.filter(call => call.body).length, 1);
  }
});
it("waits for the assistant catalog and disables generation when no assistant is enabled", async () => {
  for (const ready of [false, true]) {
    const run = harness();
    run.changeAssistant({ ready, agentId: "", agentRevision: 0 });
    await run.actions.startGuidance(); await run.actions.loadGuidance();
    assert.equal(run.calls.length, 0);
    assert.equal(run.byId("btnToolbarGuidance").disabled, true);
    assert.match(run.byId("guidanceStatus").textContent, ready ? /启用助手/ : /加载助手/);
  }
});
it("catalog readiness restores only the selected assistant cache without generating", async () => {
  const run = harness();
  run.changeAssistant({ ready: false, agentId: "", agentRevision: 0 });
  run.changeAssistant({ ready: true, agentId: "advisor", agentRevision: 1 });
  await settle();
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].body, null);
  assert.equal(run.byId("replyChoiceText0").textContent, "合成回复一");
});
it("switching assistants or editing its prompt immediately clears old choices and ignores their late results", async () => {
  for (const next of [{ agentId: "second" }, { agentRevision: 2 }]) {
    let finishOld;
    let pendingOld = false;
    const run = harness((url, body) => {
      if (body) return response({ agentId: body.agentId, agentRevision: body.agentRevision,
        guidance: null, job: { status: "queued" } });
      const query = new URLSearchParams(url.split("?")[1]);
      const agentId = query.get("agentId"), agentRevision = Number(query.get("agentRevision"));
      if (pendingOld && agentId === "advisor" && agentRevision === 1)
        return new Promise(resolve => { finishOld = resolve; });
      return response({ agentId, agentRevision, guidance: choices(agentId === "advisor" && agentRevision === 1 ? "旧助手" : "新助手") });
    });
    await run.actions.loadGuidance();
    pendingOld = true;
    const oldRead = run.actions.loadGuidance();
    run.changeAssistant(next);
    assert.equal(run.byId("replyChoiceText0").textContent, "");
    assert.equal(run.byId("replyChoice0").disabled, true);
    await settle();
    assert.equal(run.byId("replyChoiceText0").textContent, "新助手一");
    finishOld(response({ guidance: choices("迟到旧助手") })); await oldRead;
    assert.equal(run.byId("replyChoiceText0").textContent, "新助手一");
    assert.equal(run.calls.filter(call => call.body).length, 0);
    await run.actions.startGuidance();
    const submitted = run.calls.find(call => call.body).body;
    assert.equal(submitted.agentId, next.agentId || "advisor");
    assert.equal(submitted.agentRevision, next.agentRevision || 1);
  }
});
it("actual guidance HTTP failures preserve the assistant reason in GET and POST", async () => {
  const apiStart = app.indexOf("async function api("), apiEnd = app.indexOf("\nfunction status(", apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  for (const [code, status, expected] of [
    ["agent-changed", 409, /助手设置已变更/], ["agent-disabled", 409, /所选助手已停用/],
    ["agent-unknown", 404, /所选助手已不存在/], ["skill-unknown", 400, /助手技能已不存在/],
  ]) for (const method of ["get", "post"]) {
    const run = harness();
    run.context.fetch = async () => ({ ok: false, status, json: async () => ({ error: code }) });
    vm.runInContext(app.slice(apiStart, apiEnd), run.context);
    await (method === "get" ? run.actions.loadGuidance() : run.actions.startGuidance());
    assert.match(run.byId("guidanceStatus").textContent, expected);
    assert.equal(run.byId("btnToolbarGuidance").disabled, false);
    assert.equal(run.byId("replyChoice0").disabled, true);
  }
});
