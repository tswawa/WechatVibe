"use strict";
// The settings modal is a sidebar plus panels: `.settings-tab-btn[data-tab]` picks the
// panel whose id the tab listener maps. Model configuration used to live inside the
// general panel, mixed with theme/zoom/session/account rows; this pins that it stays in
// its own panel, that the map covers every tab, and that the model badge's "管理配置"
// lands on that panel instead of focusing a field inside a hidden one.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const html = readFileSync(path.join(__dirname, "..", "chatui", "index.html"), "utf8").replace(/\r/gu, "");
const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");

function between(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing page section: ${start}`);
  return html.slice(first, last);
}
const general = between('id="panelGeneral"', "<!-- Panel 2: Model configuration -->");
const model = between('id="panelModel"', "<!-- Panel 3: About -->");

it("lists one sidebar tab per panel, in the documented order", () => {
  const tabs = [...html.matchAll(/class="settings-tab-btn[^"]*" data-tab="([a-z]+)"/gu)].map(match => match[1]);
  assert.deepEqual(tabs, ["general", "model", "about"]);
  const panels = [...html.matchAll(/class="settings-panel[^"]*" id="(panel[A-Za-z]+)"/gu)].map(match => match[1]);
  assert.deepEqual(panels, ["panelGeneral", "panelModel", "panelAbout"]);
  assert.match(html, /class="settings-panel active" id="panelGeneral"/u, "the modal still opens on 通用设置");
});

it("keeps every model row inside the model panel", () => {
  const modelIds = ["selectModelSource", "modelSourceActive", "selectRuntimeProvider", "runtimeStatus",
    "localModelStatus", "btnDownloadLocalModel", "btnChooseLocalModelDir", "btnActivateLocal",
    "btnWorkerMinus", "btnWorkerPlus", "btnToggleElasticWorkers", "apiModelSettings",
    "selectApiProfile", "inputApiProfileName", "selectApiProtocol", "inputApiBaseUrl",
    "inputApiKey", "btnFetchApiModels", "selectApiModel", "inputApiModelId",
    "inputApiContextTokens", "btnApiWorkerMinus", "btnApiWorkerPlus", "btnTestApiModel",
    "btnSaveApiProfile", "btnActivateApi", "btnDeleteApiProfile", "btnClearApiKey",
    "apiModelTestStatus", "modelSourceStatus", "btnReloadModelSource"];
  for (const id of modelIds) {
    assert.ok(model.includes(`id="${id}"`), `${id} belongs to the model panel`);
    assert.equal(general.includes(`id="${id}"`), false, `${id} must not be back in 通用设置`);
  }
});

it("leaves the non-model settings in the general panel", () => {
  for (const id of ["selectThemeMode", "selectZoomLevel", "btnToggleBackgroundAnalyze",
    "btnManageConversations", "conversationManager", "inputDataRoot", "dataRootStatus",
    "btnManageAccounts", "accountManager", "btnManageAnalysisCache", "analysisCacheManager"]) {
    assert.ok(general.includes(`id="${id}"`), `${id} stays in 通用设置`);
    assert.equal(model.includes(`id="${id}"`), false, `${id} must not move into the model panel`);
  }
  assert.match(general, /<div class="settings-title">通用设置<\/div>/u);
  assert.match(model, /<div class="settings-title">模型配置<\/div>/u);
});

it("maps every tab to its panel and sends 管理配置 to the model tab", () => {
  assert.match(app, /\{ general: "panelGeneral", model: "panelModel", about: "panelAbout" \}/u);
  const manage = app.slice(app.indexOf('if (event.target.closest("[data-manage]"))'));
  const branch = manage.slice(0, manage.indexOf("return;"));
  assert.match(branch, /byId\("btnSettings"\)\.click\(\)/u);
  assert.match(branch, /\.settings-tab-btn\[data-tab="model"\]'\)\?\.click\(\)/u);
  assert.match(branch, /byId\("selectApiProfile"\)\.focus\(\)/u);
  // Opening the modal refreshes every panel's data, so a tab switch never shows stale values.
  const opener = app.slice(app.indexOf('byId("btnSettings").addEventListener'));
  const listener = opener.slice(0, opener.indexOf("});"));
  for (const call of ["loadRuntime()", "loadModelSource()", "loadLocalModel()", "loadDataRoot()"])
    assert.ok(listener.includes(call), `opening the settings must call ${call}`);
});
