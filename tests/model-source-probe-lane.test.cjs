const assert = require("node:assert/strict");

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");

function body(name, next) {
  const first = app.indexOf(`async function ${name}(`);
  assert.ok(first >= 0, `app.js must define ${name}`);
  const last = app.indexOf(next, first);
  assert.ok(last > first, `missing boundary after ${name}`);
  return app.slice(first, last);
}

it("never lets model discovery and the connection probe share one API worker lane", () => {
  // Both commands land in the same `probeTasks` lane, and the node worker refuses the
  // second one with "rate-limit" before any provider call. The UI showed that local refusal
  // as the provider's throttle message, which sent users hunting for a quota that was never
  // touched. Whichever probe starts first must lock the other one out.
  const list = body("fetchApiModels", "async function testApiModel");
  for (const flag of ["modelListBusy", "modelTestBusy", "modelSourceBusy"]) {
    assert.ok(list.includes(`settingsState.${flag}`), `fetchApiModels must check ${flag}`);
  }
  const test = body("testApiModel", "async function postApiModelSource");
  assert.ok(test.includes("settingsState.modelListBusy"),
    "testApiModel must respect an in-flight model list request");
});

it("keeps the throttle wording mapped for real provider 429s", () => {
  // The message stays: a provider 429 still has to read as a throttle. Only the local
  // refusal is removed, so the remaining "rate-limit" really is the provider.
  assert.match(app, /"rate-limit": "请求过于频繁"/u);
});