"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const css = readFileSync(path.join(root, "chatui", "style.css"), "utf8");
const app = readFileSync(path.join(root, "chatui", "app.js"), "utf8");
const contextSource = readFileSync(path.join(root, "electron", "laya", "context.ts"), "utf8");

function rule(selector) {
  const start = css.indexOf("\n" + selector + " {");
  if (start < 0) throw new Error("missing CSS rule: " + selector);
  return css.slice(start + 1, css.indexOf("}", start));
}

test("chat bubbles and history search results render newlines instead of collapsing them", () => {
  assert.match(rule(".msg-bubble"), /white-space:\s*pre-wrap/);
  assert.match(rule(".history-result-text"), /white-space:\s*pre-wrap/);
});

test("message rendering hands the original text to the DOM verbatim", () => {
  const node = app.slice(app.indexOf("function messageNode("), app.indexOf("function renderMessages("));
  assert.match(node, /element\("div", "msg-bubble"/);
  assert.doesNotMatch(node, /\.replace\(|\.trim\(\)|\.split\(/);
});

test("model output normalizers keep tabs, line breaks and blank lines", () => {
  const files = ["electron/api-guidance.ts", "electron/api-portrait.ts",
    "electron/api-reply-options.ts", "electron/api-portrait-evidence.ts",
    "electron/api-message-insights.ts", "chatui/app.js"];
  const allowed = String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`;
  const swallowed = String.raw`value.replace(/[\u0000-\u001f\u007f]/gu, " ")`;
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.ok(source.includes(allowed), file + " must allow tab/LF/CR");
    assert.ok(!source.includes(swallowed), file + " must not replace newlines with spaces");
  }
  const frame = readFileSync(path.join(root, "chatui", "advisor-frame.js"), "utf8");
  assert.ok(!frame.includes("welcome?.trim()"), "welcome text must not be trimmed");
});

test("model context preserves blank lines, indentation and leading/trailing newlines", async () => {
  assert.doesNotMatch(contextSource, /\\n\{3,\}/, "blank-line runs must not be collapsed");
  const { sanitizeContextText } = await import("../electron/laya/context.ts");
  assert.equal(sanitizeContextText("a\n\n\n\nb"), "a\n\n\n\nb");
  assert.equal(sanitizeContextText("\n\na\n\n"), "\n\na\n\n");
  assert.equal(sanitizeContextText("  indented\n  line"), "  indented\n  line");
  assert.equal(sanitizeContextText("a\r\nb\rc"), "a\nb\nc", "only the line-ending form is normalized");
});
