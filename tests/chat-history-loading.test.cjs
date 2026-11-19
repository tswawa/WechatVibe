"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8");


function slice(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("app.js section missing: " + start);
  return app.slice(from, to);
}

function autoLoader(state) {
  const calls = [];
  const context = vm.createContext({
    chatState: state,
    loadOlderHistory: () => { calls.push(true); return Promise.resolve(); },
  });
  vm.runInContext(slice("function maybeAutoLoadOlder(", "function updateHistoryNavigation("), context);
  return {
    run: (scrollTop, previousTop = scrollTop + 200) =>
      context.maybeAutoLoadOlder({ scrollTop }, previousTop),
    calls,
  };
}

function baseState() {
  return {
    currentUser: "friend",
    historyController: null,
    historyState: null,
    currentHasMoreBefore: true,
    messages: [{ id: "m1", historyCursor: "cursor-1" }],
  };
}

test("scrolling to the top loads the next older page", () => {
  const { run, calls } = autoLoader(baseState());
  run(80);
  assert.equal(calls.length, 1);
  run(0);
  assert.equal(calls.length, 2, "reaching the top again after a completed page loads another");
});

test("auto loading is gated by scroll position, in-flight request and exhaustion", () => {
  let state = baseState();
  let loader = autoLoader(state);
  loader.run(81);
  assert.equal(loader.calls.length, 0, "only the top of the list triggers a page");

  state = baseState();
  loader = autoLoader(state);
  loader.run(0, 0);
  assert.equal(loader.calls.length, 0,
    "a layout-driven scroll event must not enter history mode and stop the live poll");

  state = baseState();
  state.historyController = { abort() {} };
  loader = autoLoader(state);
  loader.run(0);
  assert.equal(loader.calls.length, 0, "never overlap history requests");

  state = baseState();
  state.currentHasMoreBefore = false;
  loader = autoLoader(state);
  loader.run(0);
  assert.equal(loader.calls.length, 0, "backend said there is nothing older");

  state = baseState();
  state.historyState = { hasMoreBefore: false };
  loader = autoLoader(state);
  loader.run(0);
  assert.equal(loader.calls.length, 0, "history browsing already reached the oldest page");

  state = baseState();
  state.messages = [{ id: "m1" }];
  loader = autoLoader(state);
  loader.run(0);
  assert.equal(loader.calls.length, 0, "without a cursor there is no page to request");
});

test("loaded history windows are kept and restored instead of being capped at 80", () => {
  assert.match(app, /const historyWindowLimit = 600;/);
  assert.match(app, /const historyWindowCache = new Map\(\);/);
  assert.equal((app.match(/maybeAutoLoadOlder\(container, previousTop\);/g) || []).length, 2,
    "both the normal and the history-mode scroll branches must auto load");
  assert.match(app, /function maybeAutoLoadOlder\(container, previousTop\)[\s\S]{0,320}previousTop <= container\.scrollTop \+ 1/);
  assert.match(app, /chatState\.historyState\.hasMoreBefore = !!data\.hasMoreBefore && older\.length > 0;/,
    "an all-duplicate page must stop the auto loader");
  assert.match(app, /rememberHistoryWindow\(account, user, next, chatState\.historyState\);/);
  assert.match(app, /cached\.messages = remembered\.messages;/);
});
