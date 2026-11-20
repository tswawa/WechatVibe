"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const app = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8").replace(/\r/g, "");
const start = app.indexOf("function messageNode(");
const end = app.indexOf("function historyAnchor(", start);
assert.ok(start >= 0 && end > start);

function expand(child) {
  return child && child.className === "fragment" ? child.children.slice() : [child];
}
function node(tag = "div", className = "", textContent = "") {
  const item = { tag, className, textContent, children: [], dataset: {}, parent: null,
    hidden: true, scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    classList: { contains(name) { return this._owner.className.split(/\s+/).includes(name); } },
    appendChild(child) {
      for (const entry of expand(child)) { entry.remove(); entry.parent = this; this.children.push(entry); }
      return child;
    },
    insertBefore(child, before) {
      for (const entry of expand(child)) {
        entry.remove(); entry.parent = this;
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index < 0 ? this.children.length : index, 0, entry);
      }
      return child;
    },
    replaceChildren(...items) { this.children = []; for (const child of items) this.appendChild(child); },
    replaceWith(child) {
      const index = this.parent.children.indexOf(this);
      this.parent.children[index] = child; child.parent = this.parent; this.parent = null;
    },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    querySelectorAll(selector) {
      const want = selector.replace(".", "");
      return this.children.filter(child => child.className.split(/\s+/).includes(want));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    get firstChild() { return this.children[0] || null; },
    get childNodes() { return this.children; },
    get previousElementSibling() {
      if (!this.parent) return null;
      const index = this.parent.children.indexOf(this);
      return index > 0 ? this.parent.children[index - 1] : null;
    },
    getBoundingClientRect() { return { top: 0, bottom: 0 }; },
  };
  item.classList._owner = item;
  return item;
}

function harness() {
  const container = node("div", "chatMessages");
  const byId = id => id === "chatMessages" ? container : node("div", id);
  const chatState = { messages: [], sessions: new Map(), self: null, currentUser: "friend",
    currentAccount: "acct", generation: 1, view: "chat", followLatest: true,
    lastChatScrollTop: 0, currentHasMoreBefore: true, historyState: null };
  const context = vm.createContext({
    byId, chatState, settingsState: {},
    document: { createDocumentFragment: () => node("div", "fragment") },
    element: node, time: value => String(value), avatar: () => node("span", "avatar"),
    updateLabel() {}, attachPickControl() {}, status() {}, scrollToLatest() {},
    updatePredictReplyAvailability() {}, clearReplyPrediction() {}, renderMood() {},
    updateHistoryNavigation() {}, ensureApiInsights() {}, syncPickControls() {}, renderPickBar() {},
    requestAnimationFrame() {},
  });
  vm.runInContext(app.slice(start, end), context);
  return {
    render: messages => context.renderMessages(messages),
    items: () => container.querySelectorAll(".msg-item"),
  };
}

const message = (id, time, text) => ({ id, time, text, side: "other", kind: "text" });

it("paging the history window reuses rows and replaces only changed ones", () => {
  const view = harness();
  view.render([message("m2", 1000, "二"), message("m3", 2000, "三")]);
  assert.deepEqual(view.items().map(item => item.dataset.messageId), ["m2", "m3"]);
  const oldFirst = view.items()[0];
  const oldSecond = view.items()[1];

  view.render([message("m1", 500, "一"), message("m2", 1000, "二"), message("m3", 2000, "三")]);
  assert.deepEqual(view.items().map(item => item.dataset.messageId), ["m1", "m2", "m3"]);
  assert.equal(view.items()[1], oldFirst, "prepending must reuse existing rows");
  assert.equal(view.items()[2], oldSecond, "prepending must reuse existing rows");

  view.render([message("m1", 500, "一"), message("m2", 1000, "二改"), message("m3", 2000, "三")]);
  assert.deepEqual(view.items().map(item => item.dataset.messageId), ["m1", "m2", "m3"]);
  assert.notEqual(view.items()[1], oldFirst, "changed content must replace only its row");
  assert.equal(view.items()[2], oldSecond, "unchanged rows stay untouched");

  view.render([message("m1", 500, "一"), message("m2", 1000, "二改"),
    message("m3", 2000, "三"), message("m4", 3000, "四")]);
  assert.deepEqual(view.items().map(item => item.dataset.messageId), ["m1", "m2", "m3", "m4"]);
});
