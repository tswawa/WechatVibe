"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

// Windows editors save these files with CRLF while Git stores LF, so source patterns below are
// matched against a normalised copy: the assertions describe the code, not the line endings.
const read = (...parts) => readFileSync(path.join(__dirname, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
const app = read("chatui", "app.js");
const css = read("chatui", "style.css");

const toggle = target => `byId("${target}")?.classList?.toggle?.("ai-busy"`;
const count = fragment => app.split(fragment).length - 1;

it("keeps the phase text and rides the marker on the status node", () => {
  // The spinner is a class on the node the text already lives in, so no extra element has to be
  // kept in sync and every existing text write keeps working.
  assert.equal(count(toggle("apiPortraitStatus")), 6);
  assert.equal(count(toggle("guidanceStatus")), 3);
  assert.ok(app.includes('text("apiPortraitStatus", state);\n' + toggle("apiPortraitStatus")));
  assert.ok(app.includes('text("guidanceStatus", state);\n' + toggle("guidanceStatus")));
});

it("spins for portrait work and reply options, and stops on errors or hints", () => {
  assert.ok(app.includes('text("apiPortraitStatus", "正在读取会话消息");\n' + toggle("apiPortraitStatus") + ', !!(true));'));
  assert.ok(app.includes(toggle("apiPortraitStatus") + ', !!(running || job.status === "queued"'));
  assert.ok(app.includes('text("apiPortraitStatus", "画像读取失败，请稍后重试");\n' + toggle("apiPortraitStatus") + ', !!(false));'));
  assert.ok(app.includes(toggle("guidanceStatus") + ', !!(portraitState.guidanceRunning'));
  // syncGuidanceAction() runs immediately after renderGuidance(), so it must follow the run
  // instead of clearing the ring; only the hint text (no enabled assistant) turns it off.
  assert.ok(app.includes(toggle("guidanceStatus") + ', !!busy);'));
  assert.ok(app.includes('text("guidanceStatus", button.title);\n    ' + toggle("guidanceStatus") + ', !!(false));'));
});

it("marks intent recognition while a job runs and clears it otherwise", () => {
  assert.ok(app.includes("let statusBusy = false;"));
  assert.ok(app.includes("statusBusy = true;"));
  assert.ok(app.includes('node.classList?.toggle?.("ai-busy", statusBusy);'));
  assert.ok(app.includes('node.classList?.remove?.("ai-busy");'));
});

it("the spinner is a css animation that respects reduced motion", () => {
  assert.match(css, /\.ai-busy::before \{[^}]*border-right-color: transparent[^}]*animation: ai-busy-spin \.8s linear infinite/);
  assert.match(css, /@keyframes ai-busy-spin \{ to \{ transform: rotate\(360deg\); \} \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\.ai-busy::before \{ animation: none;/);
});
