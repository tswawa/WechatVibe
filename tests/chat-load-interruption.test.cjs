"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8");

function helpers(state) {
  const from = app.indexOf("const MESSAGE_LOAD_STUCK_MS");
  const to = app.indexOf("async function loadMessages(", from);
  if (from < 0 || to < 0) throw new Error("app.js is missing the message load helpers");
  const context = vm.createContext({ chatState: state, console: { warn() {} } });
  vm.runInContext(app.slice(from, to), context);
  return context;
}

test("a load releases its own pending flag even after another action advances the generation", () => {
  const state = { messageRequest: 7, messagePending: true, messagePendingSince: 123 };
  const context = helpers(state);
  assert.equal(context.releaseMessagePending(7), true);
  assert.equal(state.messagePending, false);
  assert.equal(state.messagePendingSince, 0);
});

test("a stale load never clears the flag owned by a newer request", () => {
  const state = { messageRequest: 8, messagePending: true, messagePendingSince: 123 };
  const context = helpers(state);
  assert.equal(context.releaseMessagePending(7), false);
  assert.equal(state.messagePending, true);
});

test("the 4s poll recovers a load that never settled", () => {
  const state = { messagePending: true, messagePendingSince: 1000, messageRequest: 1 };
  const context = helpers(state);
  assert.equal(context.recoverStuckMessageLoad(1000 + 14999), false, "not stuck yet");
  assert.equal(context.recoverStuckMessageLoad(1000 + 15000), true);
  assert.equal(state.messagePending, false);
  assert.equal(context.recoverStuckMessageLoad(40000), false, "idle state is not a stalled load");
});

test("reply generation and chat loading no longer share an abort controller", () => {
  const guidance = app.slice(app.indexOf("function cancelGuidancePoll("), app.indexOf("async function startGuidance("));
  assert.match(guidance, /portraitState\.guidanceController\?\.abort\(\);/);
  assert.match(guidance, /const controller = new AbortController\(\);/);
  assert.match(guidance, /\{\}, controller\.signal, true\)/);
  assert.doesNotMatch(guidance, /chatState\.controller\?\.signal/);
  const poll = app.slice(app.indexOf("}, 4000);") - 220, app.indexOf("}, 4000);") + 9);
  assert.match(poll, /recoverStuckMessageLoad\(\);/);
});
