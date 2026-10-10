const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

it("ships one entry beside the conversation search that adds everything at once", () => {
  const html = read("chatui", "index.html");
  assert.match(html, /id="conversationSearch"[\s\S]{0,400}id="btnAddAllConversations"/u);
  const app = read("chatui", "app.js");
  assert.match(app, /async function addAllConversations\(/u);
  assert.match(app, /byId\("btnAddAllConversations"\)\.addEventListener\("click"/u);
});

// Runs the selection, follow and add-all code from app.js against a fake bridge.
function harness(selected = [], { initialized = true } = {}) {
  const app = read("chatui", "app.js");
  const first = app.indexOf("async function loadConversationSelection(");
  const last = app.indexOf("settingsState.sweepBusy = false;", first);
  assert.ok(first >= 0 && last > first, "selection code must stay together in app.js");
  const session = id => ({ username: id, name: id });
  const chatState = {
    sessions: new Map(["a", "b", "c"].map(id => [id, session(id)])),
    selectedConversations: new Set(), requestedConversations: new Set(),
    currentAccount: "acct", selectionLoadedAccount: null,
    sessionRequest: 1, conversationSelectionBusy: false, currentUser: "a",
  };
  const server = { selected: new Set(selected), initialized };
  const posts = [];
  const storage = new Map();
  const reply = () => ({ account: "acct", initialized: server.initialized,
    selectedSessions: [...server.selected], requestedSessions: [] });
  const context = vm.createContext({
    chatState, accountClearedExiting: false,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    byId: () => ({ hidden: true }), text() {}, renderSessions() {}, renderConversationManager() {},
    switchSession() {},
    async api(_url, options = {}) {
      if (!options.method) return reply();
      const body = JSON.parse(options.body);
      posts.push(body);
      server.initialized = true;
      if (body.all) for (const id of chatState.sessions.keys()) server.selected.add(id);
      else if (body.selected) server.selected.add(body.session);
      else server.selected.delete(body.session);
      return reply();
    },
  });
  vm.runInContext(app.slice(first, last) +
    "\nglobalThis.fns = { loadConversationSelection, trackNewConversations, addAllConversations };",
    context);
  return {
    chatState, server, posts, fns: context.fns,
    selected: () => [...chatState.selectedConversations].sort(),
    removeByHand(id) { server.selected.delete(id); chatState.selectedConversations.delete(id); },
    async reload() { chatState.selectionLoadedAccount = null; await context.fns.loadConversationSelection("acct", 1); },
  };
}

it("never fills the sidebar or follows new chats on its own", async () => {
  const run = harness([], { initialized: false });
  await run.reload();
  run.chatState.sessions.set("d", { username: "d", name: "d" });
  await run.fns.trackNewConversations("acct");
  assert.equal(run.posts.length, 0);
  assert.deepEqual(run.selected(), []);
});

it("after adding everything, only never-seen chats join and removed ones stay out", async () => {
  const run = harness(["a"]);
  await run.reload();
  await run.fns.addAllConversations();
  assert.deepEqual(run.selected(), ["a", "b", "c"]);
  run.removeByHand("b");
  run.chatState.sessions.set("d", { username: "d", name: "d" });
  await run.fns.trackNewConversations("acct");
  assert.deepEqual(run.selected(), ["a", "c", "d"]);
  assert.deepEqual(run.posts.slice(1), [{ expectedAccount: "acct", session: "d", selected: true }]);
  // Following survives a restart and still leaves the removed chat alone.
  await run.reload();
  await run.fns.trackNewConversations("acct");
  assert.equal(run.posts.length, 2);
  assert.deepEqual(run.selected(), ["a", "c", "d"]);
});

it("stops following once the account's selection starts over", async () => {
  const run = harness(["a"]);
  await run.reload();
  await run.fns.addAllConversations();
  run.server.selected.clear();
  run.server.initialized = false;
  await run.reload();
  run.chatState.sessions.set("e", { username: "e", name: "e" });
  await run.fns.trackNewConversations("acct");
  assert.equal(run.posts.length, 1);
  assert.deepEqual(run.selected(), []);
});

it("keeps the existing two-field selection request working", () => {
  const http = read("bridge", "real_http.py");
  assert.match(http, /set\(request\) == \{"expectedAccount", "all"\} and request\["all"\] is True/u);
  assert.match(http, /set\(request\) != \{"expectedAccount", "session", "selected"\}/u);
  assert.match(read("bridge", "conversation_selection.py"),
    /def set_all_selected\(self, account, sessions\):/u);
});
