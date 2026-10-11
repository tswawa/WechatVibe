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

it("keeps both local-only switches inside the local model settings", () => {
  // In the general settings they read as if they also applied to API mode.
  const html = read("chatui", "index.html").replace(/\r/gu, "");
  const start = html.indexOf('id="localModelSettings"');
  const local = html.slice(start, html.indexOf("</section>", start));
  for (const id of ["btnWorkerMinus", "btnWorkerPlus", "btnToggleElasticWorkers", "workerLimitHint"]) {
    assert.ok(local.includes(`id="${id}"`), `#${id} must sit in the local model settings`);
  }
  // The sweep switch drives the API analyzers too, so it must NOT live in a section that
  // API mode hides. It sits after the API panel and stays visible in both modes.
  const apiStart = html.indexOf('id="apiModelSettings"');
  const api = html.slice(apiStart, html.indexOf("</section>", apiStart));
  const sweepAt = html.indexOf('id="btnToggleBackgroundAnalyze"');
  assert.ok(sweepAt > 0, "the sweep switch must exist");
  assert.ok(sweepAt > api.indexOf("</section>"), "the sweep switch must follow the API panel");
  assert.ok(!local.includes('id="btnToggleBackgroundAnalyze"'),
    "the sweep switch must not stay inside the local-only panel");
  assert.ok(!api.includes('id="btnToggleBackgroundAnalyze"'),
    "the sweep switch must not sit inside the API panel either");
  // The section's own row rule would otherwise keep the hint row visible all the time.
  assert.match(read("chatui", "style.css"), /#localModelSettings \.worker-hint-row \{ display: none; \}/u);
});

it("defines the sweep, overview and worker-settings entry points", () => {
  const app = read("chatui", "app.js");
  for (const name of ["backgroundAnalyzeAll", "analyzeConversations", "renderAnalysisOverview",
                      "loadAnalysisOverview", "loadWorkerSettings", "changeWorkerSettings"]) {
    assert.match(app, new RegExp(`(?:async )?function ${name}\\(`), `app.js must define ${name}`);
  }
  // Opt-in: on a large account the sweep keeps the CPU or GPU busy for hours.
  // (`analyzeSelfStyle` used to follow it in `defaults`, hence the comma this asserts around.)
  assert.match(app, /backgroundAnalyze: false\s*[,}]/u, "background analysis is off by default");
  assert.match(app, /settingsState\.settings\.backgroundAnalyze = false;/u,
    "settings saved before the switch existed also start with it off");
  assert.match(app, /void backgroundAnalyzeAll\(\)/u);
  assert.match(app, /"\/api\/analysis-overview"/u);
  assert.match(app, /"\/api\/analysis-workers"/u);
  // API mode sweeps conversations, not messages: one POST per conversation, and the
  // window is a ceiling rather than a slice of a single conversation.
  assert.match(app, /user: id, limit: API_SWEEP_WINDOW/u);
  // One shared entry point posts a conversation for either model source, so the API and the
  // local pool cannot drift apart.
  assert.match(app, /if \(usingApiInsights\(\)\) \{/u);
  assert.match(app, /user: id, limit: API_SWEEP_WINDOW/u);
  assert.match(app, /mode: "incremental"/u);
});

it("keeps the switch, the stepper and the periodic refresh wired up", () => {
  const app = read("chatui", "app.js");
  assert.match(app, /byId\("btnToggleBackgroundAnalyze"\)\.addEventListener\("click"/u);
  assert.match(app, /byId\("btnWorkerMinus"\)\.addEventListener\("click"/u);
  assert.match(app, /byId\("btnToggleElasticWorkers"\)\.addEventListener\("click"/u);
  assert.match(app, /setInterval\(\(\) => \{ if \(updateCommitReady\) void backgroundAnalyzeAll\(\); \}, 600000\);/u);
  assert.match(app, /void loadAnalysisOverview\(\); \}, 60000\);/u);
});
