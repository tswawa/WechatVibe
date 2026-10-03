const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

it("ships one entry beside the conversation search that adds everything at once", () => {
  const html = read("chatui", "index.html");
  assert.match(html, /id="conversationSearch"[\s\S]{0,400}id="btnAddAllConversations"/u);
  const app = read("chatui", "app.js");
  assert.match(app, /async function addAllConversations\(/u);
  assert.match(app, /byId\("btnAddAllConversations"\)\.addEventListener\("click"/u);
});

it("fills an empty sidebar on first launch and keeps later conversations in sync", () => {
  const app = read("chatui", "app.js");
  assert.match(app, /if \(state\.initialized === false\) \{/u);
  assert.match(app, /async function trackNewConversations\(account\)/u);
  assert.match(app, /if \(chatState\.allConversationsTracked\) void trackNewConversations\(/u);
});

it("only re-adds everything when a never-seen conversation appears", () => {
  // Re-posting on every refresh would put back a conversation the user removed by hand.
  const app = read("chatui", "app.js");
  assert.match(app, /chatState\.seenConversations = new Set\(\);/u);
  assert.match(app, /let fresh = false;/u);
  assert.match(app, /if \(!fresh\) return;/u);
});

it("keeps the existing two-field selection request working", () => {
  const http = read("bridge", "real_http.py");
  assert.match(http, /set\(request\) == \{"expectedAccount", "all"\} and request\["all"\] is True/u);
  assert.match(http, /set\(request\) != \{"expectedAccount", "session", "selected"\}/u);
  assert.match(read("bridge", "conversation_selection.py"),
    /def set_all_selected\(self, account, sessions\):/u);
});
