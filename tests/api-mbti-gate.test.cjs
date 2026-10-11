"use strict";
// The API portrait withholds the MBTI axes until the observation ledger reaches its
// threshold. The UI used to test the analysed-text count instead, so a run that stalled
// before observing reported itself unlocked and rendered a blank "待判断" card.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");
const store = readFileSync(path.join(__dirname, "..", "bridge", "result_store.py"), "utf8").replace(/\r/gu, "");

function body(signature) {
  const first = app.indexOf(signature);
  assert.ok(first >= 0, `Missing function: ${signature}`);
  const end = app.indexOf("\n}\n", first);
  assert.ok(end > first, `Unterminated function: ${signature}`);
  return app.slice(first, end + 3);
}

it("gates the API MBTI card on the observation count, not the analysed-text count", () => {
  assert.match(app, /const eligible = Number\(profile\.apiMbtiEvidenceCount\) \|\| 0;/u);
  // The analysed-text count must not decide whether the axes are shown.
  assert.doesNotMatch(app, /const eligible = Number\(profile\.apiTargetTexts\) \|\| 0;/u);
});

it("reads the backend gate count from available", () => {
  assert.match(store, /available\["mbtiEvidenceCount"\] = /u);
  // Read after the validity pops, so a rejected ledger counts as zero rather than as
  // whatever the row claimed.
  const get = store.slice(store.indexOf("def api_portrait_get("), store.indexOf("def api_portrait_begin("));
  assert.ok(get.indexOf('resume["portraitEvidence"]') < get.indexOf('available["mbtiEvidenceCount"]'));
  assert.match(get, /"available": available/u);
  assert.match(app, /apiMbtiEvidenceCount: Number\(data\.available\?\.mbtiEvidenceCount\) \|\| 0/u);
});

it("reports the real per-axis evidence count", () => {
  // It was hardcoded to 1, so every API axis said "1 条证据".
  assert.doesNotMatch(app, /evidenceCount: 1 \}/u);
  assert.match(app, /evidenceCount: Number\(basis\?\.evidenceCount\) \|\| 0/u);
  assert.match(app, /const basis = profile\.apiMbtiBasis\?\.\[axis\.key\]/u);
});

it("explains the lock instead of asking for more messages", () => {
  // "Analyse more messages" is wrong advice for a run that never observed anything.
  assert.match(app, /观察阶段未运行/u);
  assert.match(app, /需完成聊天观察/u);
  // The local path keeps its own wording.
  assert.match(app, /需积累 \$\{minMessages\} 条该人物有效文本/u);
});

it("does not report a stalled run as preparing for ever", () => {
  assert.match(app, /API \u753b\u50cf\u672a\u5f00\u59cb[\s\S]{0,40}请重新分析/u);
  assert.match(app, /Number\(progress\?\.processedTargetTexts\) === 0/u);
});