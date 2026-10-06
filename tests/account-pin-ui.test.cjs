// Account-pin copy: which setup message a locked window shows when its account is not ready.
// No DOM and no bridge: the two pure helpers are sliced out of app.js, like the other UI tests.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return source.slice(start, end);
}

const pinHelpers = slice("function accountPinNeedsChoice(", "function formatBytes(");
const labelHelper = slice("function accountPinLabel(", "function renderAccountPin(");

const context = vm.createContext({});
vm.runInContext(`${labelHelper}\n${pinHelpers}\nthis.api = { accountPinNeedsChoice, accountUnavailableMessage, accountPinLabel };`,
  context);
const { accountPinNeedsChoice, accountUnavailableMessage } = context.api;

const pinned = {
  state: "pinned-missing",
  pinned: { accountDir: "C:\\xwechat_files\\wxid_locked", account: "wxid_locked",
    wechatId: "wxid_locked", label: "nickname-locked" },
  live: [],
};

test("several live accounts are offered as a choice", () => {
  const data = { state: "unpinned-ambiguous", pinned: null, live: [{}] };
  assert.equal(accountPinNeedsChoice(data), true);
  assert.equal(accountUnavailableMessage(data), "检测到多个微信账号，请选择本窗口使用的账号");
});

test("a logged-out locked account is never described as several accounts", () => {
  // The pinned account can be the only one logged out; telling the user that several accounts
  // were detected invites them to switch, which must stay an explicit decision.
  assert.equal(accountPinNeedsChoice(pinned), true);
  const message = accountUnavailableMessage(pinned);
  assert.doesNotMatch(message, /多个微信账号/);
  assert.match(message, /未登录/);
  // The locked account is named, so the user can tell which login is missing.
  assert.match(message, /nickname-locked/);
});

test("an ordinary not-ready state keeps the neutral message", () => {
  for (const state of ["unpinned-none", "invalid", undefined]) {
    const data = state === undefined ? null : { state, pinned: null, live: [] };
    assert.equal(accountPinNeedsChoice(data), false, String(state));
    assert.equal(accountUnavailableMessage(data), "当前微信账号未就绪", String(state));
  }
});
