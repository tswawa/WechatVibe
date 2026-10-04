const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");
const START = "// Right-click a bubble to recompute that one message.";
const END = 'byId("chatMessages").addEventListener("scroll", closeMessageMenu);';

it("ships the per-message menu and the on-demand request", () => {
  const html = read("chatui", "index.html");
  assert.match(html, /id="msgMenu"[\s\S]{0,220}id="btnRegenerateMessage"/u);
  assert.match(html, /id="btnRegenerateMessage"[^>]*>\u91cd\u65b0\u751f\u6210\u6d4b\u8bc4<\/button>/u);
  const http = read("bridge", "real_http.py");
  assert.match(http, /mode not in \("recent", "history", "incremental", "message"\)/u);
  assert.match(http, /message_id = user_value\(request\.get\("messageId"\)\)/u);
  const backend = read("bridge", "backend_service.py");
  assert.match(backend, /def start\(self, user, mode, limit, expected_account=None, message_id=None\):/u);
  assert.match(backend, /def _run_fine_message\(self, key, store, job, scope, message_id\):/u);
});

// Runs the menu and re-generation code from app.js against a fake bridge.
function harness({ fail = false } = {}) {
  const app = read("chatui", "app.js");
  const first = app.indexOf(START);
  const last = app.indexOf(END, first);
  assert.ok(first >= 0 && last > first, "the message menu code must stay together in app.js");
  const nodes = new Map();
  const posts = [];
  const toasts = [];
  const loadCalls = [];
  const labelState = { results: { m2: { state: "done", labelSchema: "generic-v9", intentLabel: "\u65e7" } } };
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: true, disabled: false, dataset: {}, style: {},
      offsetWidth: 132, offsetHeight: 36, addEventListener() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    chatState: { currentAccount: "acct", currentUser: "friend", generation: 1, historyState: null,
      messages: [{ id: "m1" }, { id: "m2" }], controller: { signal: null } },
    labelState, byId, refreshLabels() {},
    document: { addEventListener() {} },
    window: { innerWidth: 1200, innerHeight: 800 },
    toast: value => toasts.push(value),
    setTimeout: callback => { callback(); return 1; },
    clearTimeout() {},
    async api(url, options = {}) {
      if (fail) throw new Error("synthetic failure");
      if (options.method === "POST") {
        posts.push(JSON.parse(options.body));
        labelState.results.m2 = { state: "done", labelSchema: "generic-v9", intentLabel: "\u65b0" };
        return { job: { id: "job-1", status: "queued", total: 1, processed: 0 } };
      }
      return {};
    },
    async loadAnalysis(user, token, signal) { loadCalls.push({ user, token, signal }); },
  });
  vm.runInContext(app.slice(first, last + END.length) +
    "\nglobalThis.fns = { openMessageMenu, closeMessageMenu, regenerateMessage };", context);
  return { fns: context.fns, byId, posts, toasts, loadCalls };
}

it("opens the menu on the clicked bubble and closes it again", () => {
  const run = harness();
  run.fns.openMessageMenu({ clientX: 40, clientY: 60 }, 42);
  assert.equal(run.byId("msgMenu").hidden, false);
  assert.equal(run.byId("msgMenu").dataset.messageId, "42");
  assert.equal(run.byId("msgMenu").style.left, "40px");
  assert.equal(run.byId("msgMenu").style.top, "60px");
  run.fns.closeMessageMenu();
  assert.equal(run.byId("msgMenu").hidden, true);
});

it("asks the bridge to recompute exactly that message and waits for the new label", async () => {
  const run = harness();
  await run.fns.regenerateMessage("m2");
  assert.equal(run.posts.length, 1);
  assert.equal(run.posts[0].mode, "message");
  assert.equal(run.posts[0].messageId, "m2");
  assert.equal(run.posts[0].account, "acct");
  assert.equal(run.posts[0].user, "friend");
  assert.equal(run.posts[0].limit, 80);
  assert.equal(run.toasts[0], "\u5df2\u8bf7\u6c42\u91cd\u65b0\u751f\u6210\uff0c\u6b63\u5728\u91cd\u7b97\u8fd9\u6761\u6d88\u606f");
  assert.equal(run.loadCalls.length, 1);
  assert.equal(run.byId("btnRegenerateMessage").disabled, false);
});

it("reports a failed request instead of leaving the entry disabled", async () => {
  const run = harness({ fail: true });
  await run.fns.regenerateMessage("m2");
  assert.equal(run.posts.length, 0);
  assert.equal(run.toasts[0], "\u91cd\u65b0\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
  assert.equal(run.byId("btnRegenerateMessage").disabled, false);
});