"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const read = (...parts) => readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const app = read("chatui", "app.js");
const html = read("chatui", "index.html");
const css = read("chatui", "style.css");

it("defaults to one day and clamps anything outside one hour .. thirty days", () => {
  assert.match(app, /guidanceWindowMinutes: 1440 \};/);
  assert.match(app, /const GUIDANCE_WINDOW_MIN = 60, GUIDANCE_WINDOW_MAX = 43200;/);
  assert.match(app, /return Math\.min\(GUIDANCE_WINDOW_MAX, Math\.max\(GUIDANCE_WINDOW_MIN, value\)\);/);
});

it("labels any amount in hours, days or minutes", () => {
  assert.match(app, /if \(minutes % 1440 === 0\) return `最近 \$\{minutes \/ 1440\} 天`;/);
  assert.match(app, /if \(minutes % 60 === 0\) return `最近 \$\{minutes \/ 60\} 小时`;/);
  assert.match(app, /return `最近 \$\{minutes\} 分钟`;/);
});

it("sends the typed window with the reply request", () => {
  assert.match(app, /windowMinutes: guidanceWindowMinutes\(\) \}\) \}, undefined, true\);/);
  assert.match(app, /正在生成回复 · \$\{guidanceWindowLabel\(\)\}/);
});

it("offers a number field plus an hours/days unit in the general settings panel", () => {
  assert.match(html, /<label for="inputGuidanceWindow">生成回复的聊天范围<\/label>/);
  assert.match(html, /<input type="number" id="inputGuidanceWindow" min="1" max="720" step="0\.5"/);
  assert.match(html, /<select id="selectGuidanceWindowUnit" aria-label="时间单位">/);
  assert.match(html, /<option value="hours">小时<\/option>/);
  assert.match(html, /<option value="days" selected>天<\/option>/);
  assert.match(html, /id="guidanceWindowHint" class="model-source-status" role="status" aria-live="polite"/);
  // Typing in either control is persisted and reflected in the hint.
  assert.match(app, /for \(const id of \["inputGuidanceWindow", "selectGuidanceWindowUnit"\]\)/);
  assert.match(app, /settingsState\.settings\.guidanceWindowMinutes = readGuidanceWindow\(\);/);
  assert.match(app, /const minutes = Math\.round\(amount \* \(unit && unit\.value === "days" \? 1440 : 60\)\);/);
  assert.match(app, /if \(typeof applyGuidanceWindow === "function"\) applyGuidanceWindow\(\);/);
});

it("makes the generating state read as working rather than as a hint", () => {
  assert.match(css, /\.guidance-status\.ai-busy \{[^}]*font-size: 13px[^}]*font-weight: 500/);
  assert.match(css, /\.guidance-status\.ai-busy \{[^}]*white-space: normal/);
});
