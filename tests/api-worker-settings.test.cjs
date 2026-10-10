const assert = require("node:assert/strict");

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
function read(...parts) {
  return readFileSync(path.join(root, ...parts), "utf8").replace(/\r/gu, "");
}

it("keeps the API parallelism row inside the API model settings", () => {
  // The local row must not grow an API twin: API mode hides #localModelSettings entirely,
  // so a control placed there would be unreachable in the mode that needs it.
  const html = read("chatui", "index.html");
  const start = html.indexOf('id="apiModelSettings"');
  const api = html.slice(start, html.indexOf("</section>", start));
  for (const id of ["btnApiWorkerMinus", "btnApiWorkerPlus", "apiWorkerValue", "apiWorkerLimitHint"]) {
    assert.ok(api.includes(`id="${id}"`), `#${id} must sit in the API model settings`);
  }
  // No "follow the load" toggle: the limit here follows provider rate limits, not the
  // machine's GPU/CPU, so reusing #btnToggleElasticWorkers would misdescribe it.
  assert.ok(!api.includes("btnToggleElasticWorkers"), "the API row must not offer load following");
  const localStart = html.indexOf('id="localModelSettings"');
  const local = html.slice(localStart, html.indexOf("</section>", localStart));
  assert.ok(!local.includes("btnApiWorkerMinus"), "the API row must not leak into local settings");
});

it("defines the API worker settings entry points and talks to the new endpoint", () => {
  const app = read("chatui", "app.js");
  for (const name of ["loadApiWorkerSettings", "renderApiWorkerSettings", "changeApiWorkerSettings"]) {
    assert.match(app, new RegExp(`(?:async )?function ${name}\\(`), `app.js must define ${name}`);
  }
  assert.match(app, /"\/api\/api-workers"/u, "the API row posts to /api/api-workers");
  assert.match(app, /byId\("btnApiWorkerMinus"\)\.addEventListener/u);
  assert.match(app, /byId\("btnApiWorkerPlus"\)\.addEventListener/u);
  assert.match(app, /void loadApiWorkerSettings\(\)/u, "the row is loaded on startup like the local one");
  // The API source is chosen after the panel renders; a stale ceiling would hide the row.
  assert.match(app, /renderApiWorkerSettings\(\);/u);
});