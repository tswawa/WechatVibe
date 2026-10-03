const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

it("ships the sidebar progress bar plus the settings rows it drives", () => {
  const html = read("chatui", "index.html");
  for (const id of ["sweepProgress", "sweepProgressLabel", "sweepProgressValue", "sweepProgressFill",
                    "btnToggleBackgroundAnalyze", "btnWorkerMinus", "btnWorkerPlus",
                    "btnToggleElasticWorkers", "workerLimitValue", "workerLimitHint"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html must ship #${id}`);
  }
  const css = read("chatui", "style.css");
  assert.match(css, /\.sweep-progress-fill \{/u);
  assert.match(css, /\.worker-hint-row\.show \{ display: flex; \}/u);
});

it("defines the sweep, overview and worker-settings entry points", () => {
  const app = read("chatui", "app.js");
  for (const name of ["backgroundAnalyzeAll", "renderAnalysisOverview", "loadAnalysisOverview",
                      "loadWorkerSettings", "changeWorkerSettings"]) {
    assert.match(app, new RegExp(`(?:async )?function ${name}\\(`), `app.js must define ${name}`);
  }
  assert.match(app, /backgroundAnalyze: true/u, "background analysis is on by default");
  assert.match(app, /void backgroundAnalyzeAll\(\)/u);
  assert.match(app, /"\/api\/analysis-overview"/u);
  assert.match(app, /"\/api\/analysis-workers"/u);
});

it("keeps the switch, the stepper and the periodic refresh wired up", () => {
  const app = read("chatui", "app.js");
  assert.match(app, /byId\("btnToggleBackgroundAnalyze"\)\.addEventListener\("click"/u);
  assert.match(app, /byId\("btnWorkerMinus"\)\.addEventListener\("click"/u);
  assert.match(app, /byId\("btnToggleElasticWorkers"\)\.addEventListener\("click"/u);
  assert.match(app, /setInterval\(\(\) => \{ if \(updateCommitReady\) void backgroundAnalyzeAll\(\); \}, 600000\);/u);
  assert.match(app, /void loadAnalysisOverview\(\); \}, 60000\);/u);
});
