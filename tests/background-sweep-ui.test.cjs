const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");

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

it("keeps hardware workers local and exposes the requested-conversation sweep for both sources", () => {
  const html = read("chatui", "index.html").replace(/\r/gu, "");
  const start = html.indexOf('id="localModelSettings"');
  const local = html.slice(start, html.indexOf("</section>", start));
  for (const id of ["btnWorkerMinus", "btnWorkerPlus",
                    "btnToggleElasticWorkers", "workerLimitHint"]) {
    assert.ok(local.includes(`id="${id}"`), `#${id} must sit in the local model settings`);
  }
  assert.ok(!local.includes('id="btnToggleBackgroundAnalyze"'));
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
  assert.match(app, /backgroundAnalyze: false[, }]/u, "background analysis is off by default");
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

it("shows and announces local setting state without adding candidate or probability controls", () => {
  const html = read("chatui", "index.html");
  for (const [id, hint] of [["btnToggleBackgroundAnalyze", "backgroundAnalyzeHint"],
    ["btnToggleElasticWorkers", "workerLimitHint"]]) {
    const button = html.match(new RegExp(`<button[^>]+id="${id}"[^>]*>`))?.[0];
    assert.match(button, /aria-label="[^"]+"/u);
    assert.match(button, new RegExp(`aria-describedby="${hint}"`));
    const status = html.match(new RegExp(`<span[^>]+id="${hint}"[^>]*>`))?.[0];
    assert.match(status, /role="status"/u);
    assert.match(status, /aria-live="polite"/u);
  }
  assert.doesNotMatch(html, /btnLabelOptions|labelOptionsHint/u);
  const css = read("chatui", "style.css");
  assert.match(css, /\.settings-action-btn\.active\s*\{[^}]*border-color:\s*var\(--color-green\)[^}]*background:/u);
  assert.match(css, /body\.theme-light \.settings-action-btn\.active/u);

  const app = read("chatui", "app.js");
  const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const nodes = new Map();
  const classList = () => {
    const classes = new Set();
    return { toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, has: name => classes.has(name) };
  };
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, { attributes: {}, classList: classList(),
      parentElement: { classList: classList() }, setAttribute(name, value) { this.attributes[name] = value; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ byId, window: {}, refreshLabels() {}, setIntentActionState() {},
    text: (id, value) => { byId(id).textContent = value; },
    document: { body: { classList: classList() },
      documentElement: { classList: classList(), style: { setProperty() {} } } } });
  seed(context, { settings: { theme: "dark", zoom: 1, intent: false, backgroundAnalyze: false } });
  context.settingsState.workerSettings = { workers: 2, max: 4, limit: 1, elastic: false };
  vm.runInContext(section("function applySettings(", "const GUIDANCE_VERSION") +
    section("function renderWorkerSettings(", "async function changeWorkerSettings("), context);
  for (const enabled of [false, true, false]) {
    context.settings.backgroundAnalyze = enabled;
    context.settingsState.workerSettings.elastic = enabled;
    vm.runInContext("applySettings(); renderWorkerSettings();", context);
    for (const id of ["btnToggleBackgroundAnalyze", "btnToggleElasticWorkers"]) {
      assert.equal(byId(id).classList.has("active"), enabled);
      assert.equal(byId(id).attributes["aria-pressed"], String(enabled));
    }
    assert.match(byId("backgroundAnalyzeHint").textContent, enabled ? /已开启.*定期/ : /已关闭.*不会自动/);
    assert.match(byId("workerLimitHint").textContent, enabled ? /负载高时自动降档/ : /固定 2 路并行/);
    assert.match(byId("workerLimitHint").textContent, /仅本地分析生效/);
    assert.match(byId("backgroundAnalyzeHint").textContent, /API/);
  }
});
