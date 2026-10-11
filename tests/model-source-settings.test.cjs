const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");

const root = path.join(__dirname, "..");
const script = readFileSync(path.join(root, "chatui/app.js"), "utf8");
const html = readFileSync(path.join(root, "chatui/index.html"), "utf8");
function section(start, end) {
  const first = script.indexOf(start);
  const last = script.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing section: ${start}`);
  return script.slice(first, last);
}
const settingsCode = section("async function api(", "function status(") +
  section("const MODEL_SOURCE_PROTOCOLS", "let managedAccounts = [];") +
  "globalThis.ui = { showModelSource, loadModelSource, fetchApiModels, testApiModel, " +
  "activateModelSource, activateModelProfile, saveApiProfile, deleteApiProfile, " +
  "loadApiProfileDraft, showApiProfileDeleteConfirm, toggleModelBadgeMenu, " +
  "clearStoredApiKey, invalidateModelDiscovery, invalidateModelTest, " +
  "syncRuntimeControl, syncSavedApiKeyHint, getSnapshot: () => settingsState.modelSourceSnapshot, " +
  "getProfileId: () => settingsState.apiProfileId, " +
  "markDirty: () => { settingsState.modelSourceDraftDirty = true; } };";

function makeNode() {
  const node = {
    textContent: "", hidden: false, disabled: false, options: [], dataset: {},
    attributes: {}, storedValue: "",
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    append(...children) { this.options.push(...children); },
    replaceChildren(...children) { this.options = children; },
    appendChild(child) { this.options.push(child); },
  };
  // The DOM always reports input.value as a string, whatever was assigned to it.
  Object.defineProperty(node, "value", {
    get() { return this.storedValue; },
    set(input) { this.storedValue = input == null ? "" : String(input); },
  });
  return node;
}
function harness(fetchImpl) {
  const nodes = new Map();
  const cardClasses = new Set();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const card = { classList: { toggle(name, enabled) {
    if (enabled) cardClasses.add(name);
    else cardClasses.delete(name);
  } } };
  byId("settingsModal").querySelector = () => card;
  const context = vm.createContext({
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    document: { createElement: () => makeNode() },
    byId,
    text: (id, value) => { byId(id).textContent = value == null ? "" : String(value); },
    settings: { intent: true },
    syncPortraitMode() {},
    cancelApiPortraitPoll() {},
    clearApiPortraitView() {},
    loadProfile() {},
    clearInlineIntentPending() {},
    setIntentActionState() {},
    refreshLabels() {},
    submitManualRecent() {},
    fetch: fetchImpl,
    localStorage: { setItem() { throw new Error("provider settings must not use browser storage"); } },
  });
  seed(context, {
    runtimeSnapshot: { requestedProvider: "gpu" }, runtimeBusy: false,
    currentAccount: null, currentUser: null, view: "chat", controller: null, generation: 0,
    apiPortraitSnapshot: null, incrementalFailed: false, recentFailed: false,
    localModelResolved: false, localModelReady: false,
  });
  vm.runInContext(settingsCode, context);
  return { ui: context.ui, byId, cardClasses, context };
}
const response = body => ({ ok: true, json: async () => body });
const id = letter => letter.repeat(32);
const profile = (letter, name, model) => ({
  id: id(letter), name, label: name, protocol: "responses",
  baseUrl: `https://${letter}.test/v1`, model, contextTokens: 128000, hasKey: true,
});
const localState = { mode: "local", api: null, profiles: [], label: "本地 Laya", sourceId: "local", status: "ready" };
const apiState = {
  mode: "api", sourceId: id("b"), status: "ready", label: "线路 B",
  api: { id: id("b"), protocol: "responses", baseUrl: "https://b.test/v1", model: "model-b", contextTokens: 128000, hasKey: true },
  profiles: [profile("a", "线路 A", "model-a"), profile("b", "线路 B", "model-b")],
};

it("shows both deployment paths and keeps the key in a password field", () => {
  for (const id of ["selectModelSource", "localModelSettings", "apiModelSettings", "btnFetchApiModels", "apiModelCount",
    "selectApiModel", "inputApiModelId", "inputApiContextTokens", "btnTestApiModel", "btnActivateApi", "btnClearApiKey"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /本地模型<\/span>[\s\S]*?>Laya<\/span>/);
  assert.match(html, /id="inputApiKey" type="password"/);
  for (const protocol of ["anthropic", "responses", "chat_completions", "gemini", "ollama"])
    assert.match(html, new RegExp(`value="${protocol}"`));
});

it("loads the active source and disables local device changes while API is active", async () => {
  const { ui, byId } = harness(async () => response(apiState));
  await ui.loadModelSource();
  assert.equal(byId("selectModelSource").value, "api");
  assert.equal(byId("modelSourceActive").textContent, "当前 API");
  assert.equal(byId("inputApiKey").value, "");
  assert.equal(byId("inputApiContextTokens").value, "128000");
  assert.equal(byId("apiKeySaved").hidden, false);
  assert.equal(byId("selectRuntimeProvider").disabled, true);
  assert.equal(byId("localModelSettings").hidden, true);
});

it("keeps the settings window the same size for local and API sources", async () => {
  const css = readFileSync(path.join(root, "chatui/style.css"), "utf8");
  const card = css.match(/(?:^|\n)\.settings-modal-card \{([^}]*)\}/);
  assert.ok(card, "base settings card rule");
  assert.match(card[1], /width: min\(650px, calc\(100vw - 32px\)\);/);
  assert.match(card[1], /height: min\(680px, calc\(100vh - 40px\)\);/);
  assert.doesNotMatch(css, /\.settings-modal-card\.[\w-]+[^{]*\{[^}]*\b(?:width|height)\s*:/,
    "no mode or manager class may resize the card");
  for (const state of [localState, apiState]) {
    const { ui, byId, cardClasses } = harness(async () => response(state));
    await ui.loadModelSource();
    assert.equal(byId("localModelSettings").hidden, state.mode === "api");
    assert.equal(byId("apiModelSettings").hidden, state.mode !== "api");
    assert.deepEqual([...cardClasses], [], state.mode);
  }
});

it("only offers reuse of a saved key for its original protocol and Base URL", () => {
  const { ui, byId } = harness(async () => response(localState));
  ui.showModelSource(apiState);
  assert.equal(byId("apiKeySaved").hidden, false);
  byId("inputApiBaseUrl").value = "https://different.test/v1";
  ui.syncSavedApiKeyHint();
  assert.equal(byId("apiKeySaved").hidden, true);
  assert.equal(byId("btnClearApiKey").hidden, false);
  assert.equal(byId("inputApiKey").placeholder, "按服务要求填写 API Key");
});

it("refreshes active status without overwriting a draft after service recovery", async () => {
  const { ui, byId } = harness(async () => response(localState));
  ui.showModelSource(apiState);
  byId("inputApiModelId").value = "unsaved-model";
  ui.markDirty();
  await ui.loadModelSource(true);
  assert.equal(ui.getSnapshot().mode, "local");
  assert.equal(byId("modelSourceActive").textContent, "当前本地");
  assert.equal(byId("selectModelSource").value, "api");
  assert.equal(byId("inputApiModelId").value, "unsaved-model");
});

it("fetches a model list, allows manual IDs, and resets stale discovery on configuration edit", async () => {
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, options });
    return response({ supported: true, models: [{ id: "model-a", name: "Model A" },
      { id: "model-b", contextTokens: 65536 }] });
  });
  ui.showModelSource(localState);
  byId("selectApiProtocol").value = "responses";
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  byId("inputApiKey").value = "SYNTHETIC_KEY";
  byId("inputApiModelId").value = "model-b";
  await ui.fetchApiModels();
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    protocol: "responses", baseUrl: "https://example.test/v1", apiKey: "SYNTHETIC_KEY",
  });
  assert.equal(byId("apiModelCount").textContent, "2 个模型可用");
  assert.equal(byId("selectApiModel").options.length, 3);
  assert.equal(byId("selectApiModel").disabled, false);
  assert.equal(byId("inputApiContextTokens").value, "65536");
  byId("apiModelTestStatus").textContent = "连接成功";
  ui.invalidateModelDiscovery();
  assert.equal(byId("apiModelCount").textContent, "");
  assert.equal(byId("apiModelTestStatus").textContent, "");
  assert.equal(byId("selectApiModel").options.length, 1);
});

it("ignores a late model list after the user edits its connection settings", async () => {
  let resolveFetch;
  const { ui, byId } = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  ui.showModelSource(localState);
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  const pending = ui.fetchApiModels();
  ui.invalidateModelDiscovery();
  resolveFetch(response({ supported: true, models: [{ id: "obsolete" }] }));
  await pending;
  assert.equal(byId("apiModelCount").textContent, "");
  assert.equal(byId("selectApiModel").options.length, 1);
});

it("cancels discovery when connection settings change", async () => {
  let cancelled = false;
  const { ui, byId } = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      cancelled = true;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }));
  ui.showModelSource(localState);
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  const pending = ui.fetchApiModels();
  ui.invalidateModelDiscovery();
  await pending;
  assert.equal(cancelled, true);
  assert.equal(byId("apiModelCount").textContent, "");
});

it("uses a manual model when listing is unsupported, tests it, and activates only on success", async () => {
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/list")) return response({ supported: false, models: [] });
    if (url.endsWith("/test")) return response({ ok: true, latencyMs: 37.6 });
    if (url.endsWith("/profiles")) return response({ ...apiState, profile: id("c") });
    if (url.endsWith("/activate")) return response(apiState);
    throw new Error("unexpected fetch");
  });
  ui.showModelSource(localState);
  byId("selectModelSource").value = "api";
  byId("selectApiProtocol").value = "responses";
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  byId("inputApiModelId").value = "model-b";
  byId("inputApiContextTokens").value = "128000";
  byId("inputApiKey").value = "SYNTHETIC_KEY";
  await ui.fetchApiModels();
  assert.equal(byId("apiModelCount").textContent, "此接口不提供模型列表，可手动填写模型 ID");
  await ui.testApiModel();
  assert.equal(byId("apiModelTestStatus").textContent, "连接成功 · 38 ms");
  await ui.activateModelSource("api");
  assert.equal(requests[1].body.model, "model-b");
  assert.equal(requests[2].url, "/api/model-source/profiles");
  assert.equal(requests[2].body.contextTokens, 128000);
  assert.equal(requests[3].body.mode, "api");
  assert.equal(byId("inputApiKey").value, "");
  assert.equal(ui.getSnapshot().mode, "api");
});

it("keeps the previous active mode when activation fails", async () => {
  // Saving alone never switches, so the save response still reports the local selection.
  const savedState = { ...localState, profile: id("c"), profiles: [{ id: id("c"), name: "线路 B",
    label: "线路 B", protocol: "responses", baseUrl: "https://example.test/v1", model: "model-b",
    contextTokens: 4096, hasKey: true }] };
  const { ui, byId } = harness(async url => url.endsWith("/activate")
    ? { ok: false, status: 401 } : response(savedState));
  ui.showModelSource(localState);
  byId("selectModelSource").value = "api";
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  byId("inputApiModelId").value = "model-b";
  byId("inputApiContextTokens").value = "4096";
  await ui.activateModelSource("api");
  assert.equal(ui.getSnapshot().mode, "local");
  assert.match(byId("modelSourceStatus").textContent, /启用失败（HTTP 401），当前仍为本地/);
  assert.equal(byId("inputApiModelId").value, "model-b");
});

it("requires a bounded context size before sending API activation", async () => {
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/profiles") ? { ...apiState, profile: id("c") } : apiState);
  });
  ui.showModelSource(localState);
  byId("selectApiProtocol").value = "responses";
  byId("inputApiBaseUrl").value = "https://example.test/v1";
  byId("inputApiModelId").value = "model-b";
  for (const value of ["", "4095", "1000001", "8192.5"]) {
    byId("inputApiContextTokens").value = value;
    await ui.activateModelSource("api");
  }
  assert.equal(requests.length, 0);
  byId("inputApiContextTokens").value = "4096";
  await ui.activateModelSource("api");
  assert.deepEqual(requests.map(item => item.url),
    ["/api/model-source/profiles", "/api/model-source/activate"]);
  assert.equal(requests[0].body.contextTokens, 4096);
});

it("clears the saved key of the edited profile and refreshes the active source", async () => {
  const requests = [];
  const cleared = { ...apiState, api: { ...apiState.api, hasKey: false },
    profiles: apiState.profiles.map(item => item.id === id("b") ? { ...item, hasKey: false } : item) };
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/clear-key") ? cleared : localState);
  });
  ui.showModelSource(apiState);
  await ui.clearStoredApiKey();
  assert.deepEqual(requests, [{ url: "/api/model-source/clear-key", body: { profileId: id("b") } }]);
  assert.equal(byId("apiKeySaved").hidden, true);
  assert.equal(byId("btnClearApiKey").hidden, true);
  assert.equal(byId("inputApiKey").value, "");
  assert.equal(ui.getSnapshot().mode, "api");
});

it("shows the current model beside the chat title and lists every profile in its menu", async () => {
  const { ui, byId } = harness(async () => response(apiState));
  await ui.loadModelSource();
  assert.equal(byId("modelBadgeWrap").hidden, false);
  assert.equal(byId("modelBadgeLabel").textContent, "线路 B");
  ui.toggleModelBadgeMenu();
  const options = byId("modelBadgeMenu").options;
  assert.deepEqual(options.slice(0, 2).map(item => item.dataset.profileId), [id("a"), id("b")]);
  assert.deepEqual(options.slice(0, 2).map(item => item.getAttribute("aria-checked")), ["false", "true"]);
  assert.equal(options[2].dataset.profileId, "");
  assert.equal(options[2].getAttribute("aria-checked"), "false");
  assert.equal(options[3].dataset.manage, "1");
  assert.equal(byId("modelBadge").getAttribute("aria-expanded"), "true");
  ui.toggleModelBadgeMenu();
  assert.equal(byId("modelBadgeMenu").hidden, true);
  assert.equal(byId("modelBadge").getAttribute("aria-expanded"), "false");
});

it("hides the model badge until the active source is known", () => {
  // The wrapper also carries the shared marker the outside-click rule looks for, so this
  // asserts the attribute rather than its position.
  assert.match(html, /id="modelBadgeWrap"[^>]*\bhidden/);
  const { ui, byId } = harness(async () => response(localState));
  ui.showModelSource(localState);
  assert.equal(byId("modelBadgeLabel").textContent, "本地 Laya");
});

it("switches the conversation model from the header without touching the settings form", async () => {
  const requests = [];
  const switched = { ...apiState, sourceId: id("a"), label: "线路 A",
    api: { ...apiState.api, id: id("a"), model: "model-a" } };
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/activate") ? switched : apiState);
  });
  ui.showModelSource(apiState);
  byId("inputApiModelId").value = "unsaved-model";
  ui.markDirty();
  await ui.activateModelProfile(id("a"));
  assert.deepEqual(requests, [{ url: "/api/model-source/activate", body: { mode: "api", profileId: id("a") } }]);
  assert.equal(ui.getSnapshot().sourceId, id("a"));
  assert.equal(byId("modelBadgeLabel").textContent, "线路 A");
  // The unsaved draft survives the switch.
  assert.equal(byId("inputApiModelId").value, "unsaved-model");
});

it("skips a redundant switch request when the header model is already active", async () => {
  const requests = [];
  const { ui } = harness(async (url) => {
    requests.push(url);
    return response(apiState);
  });
  ui.showModelSource(apiState);
  await ui.activateModelProfile(id("b"));
  assert.deepEqual(requests, []);
  await ui.activateModelProfile("");
  assert.deepEqual(requests, ["/api/model-source/activate"]);
});

it("saves a new profile without activating it and keeps editing that profile", async () => {
  const requests = [];
  const saved = { ...localState, sourceId: "local",
    profiles: [...apiState.profiles, profile("c", "线路 C", "model-c")] };
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/profiles") ? { ...saved, profile: id("c") } : saved);
  });
  ui.showModelSource(localState);
  byId("selectModelSource").value = "api";
  byId("inputApiProfileName").value = "线路 C";
  byId("inputApiBaseUrl").value = "https://c.test/v1";
  byId("inputApiModelId").value = "model-c";
  byId("inputApiContextTokens").value = "128000";
  byId("inputApiKey").value = "SYNTHETIC_KEY";
  await ui.saveApiProfile();
  assert.deepEqual(requests[0], { url: "/api/model-source/profiles",
    body: { protocol: "responses", baseUrl: "https://c.test/v1", model: "model-c",
      contextTokens: 128000, apiKey: "SYNTHETIC_KEY", name: "线路 C" } });
  assert.equal(byId("modelSourceStatus").textContent, "配置已保存");
  // Saving alone must leave the conversation on the local model.
  assert.equal(ui.getSnapshot().mode, "local");
  assert.equal(ui.getProfileId(), id("c"));
  assert.equal(byId("inputApiKey").value, "");
  assert.equal(byId("inputApiProfileName").value, "线路 C");
});

it("updates the selected profile in place and names the request with its id", async () => {
  // 「保存并启用」on a saved profile is save-then-switch: `/api/model-source/activate` takes
  // either the connection fields or `{mode, profileId}`, and a mixed body is a 400
  // `invalid model source request` that the form reported as 启用失败 even though 测试连接
  // had just succeeded.
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response({ ...apiState, profile: id("a") });
  });
  ui.showModelSource(apiState);
  ui.loadApiProfileDraft(id("a"));
  assert.equal(byId("inputApiProfileName").value, "线路 A");
  assert.equal(byId("inputApiModelId").value, "model-a");
  assert.equal(byId("inputApiBaseUrl").value, "https://a.test/v1");
  assert.equal(byId("apiKeySaved").hidden, false);
  byId("inputApiModelId").value = "model-a2";
  await ui.activateModelSource("api");
  assert.deepEqual(requests.map(item => item.url),
    ["/api/model-source/profiles", "/api/model-source/activate"]);
  assert.equal(requests[0].body.profileId, id("a"));
  assert.equal(requests[0].body.name, "线路 A");
  assert.equal(requests[0].body.model, "model-a2");
  // The switch itself must stay the two-key form: no fields, so no second probe.
  assert.deepEqual(requests[1].body, { mode: "api", profileId: id("a") });
  assert.equal(byId("modelSourceStatus").textContent, "API 模型已启用");
});

it("never sends connection fields together with a profile id to activate", async () => {
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/profiles") ? { ...apiState, profile: id("c") } : apiState);
  });
  ui.showModelSource(apiState);
  ui.loadApiProfileDraft(id("a"));
  await ui.activateModelSource("api");
  for (const request of requests)
    assert.equal(request.url.endsWith("/activate") && Object.keys(request.body).length > 2, false,
      `activate body must be {mode, profileId}: ${JSON.stringify(request.body)}`);
  // A brand-new profile goes through the same two steps: `/profiles` appends it — posting the
  // fields to `activate` instead matches the existing profile for that connection and updates
  // it, so the new entry never appears in the model list.
  byId("selectApiProfile").value = "";
  ui.loadApiProfileDraft("");
  byId("inputApiBaseUrl").value = "https://c.test/v1";
  byId("inputApiModelId").value = "model-c";
  byId("inputApiContextTokens").value = "128000";
  await ui.activateModelSource("api");
  const tail = requests.slice(-2);
  assert.deepEqual(tail.map(item => item.url),
    ["/api/model-source/profiles", "/api/model-source/activate"]);
  assert.deepEqual(tail[0].body, { protocol: "responses", baseUrl: "https://c.test/v1",
    model: "model-c", contextTokens: 128000 });
  assert.deepEqual(tail[1].body, { mode: "api", profileId: id("c") });
});

it("deletes only after an explicit confirmation and then falls back to the remaining model", async () => {
  assert.match(html, /id="apiProfileDeleteConfirm" hidden/);
  const requests = [];
  const { ui, byId } = harness(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(url.endsWith("/delete") ? { ...localState, profiles: [apiState.profiles[1]] } : apiState);
  });
  ui.showModelSource(apiState);
  ui.loadApiProfileDraft(id("a"));
  assert.equal(byId("btnDeleteApiProfile").hidden, false);
  ui.showApiProfileDeleteConfirm(true);
  assert.match(byId("apiProfileDeleteQuestion").textContent, /线路 A/);
  await ui.deleteApiProfile();
  assert.deepEqual(requests, [{ url: "/api/model-source/profiles/delete", body: { profileId: id("a") } }]);
  assert.equal(byId("apiProfileDeleteConfirm").hidden, true);
  assert.equal(byId("modelBadgeLabel").textContent, "本地 Laya");
});

it("marks the profile the user is editing as current in the settings picker", () => {
  const { ui, byId } = harness(async () => response(apiState));
  ui.showModelSource(apiState);
  const options = byId("selectApiProfile").options;
  assert.deepEqual(options.map(item => item.value), ["", id("a"), id("b")]);
  assert.equal(options[0].textContent, "新建配置");
  assert.deepEqual([options[1].textContent, options[2].textContent], ["线路 A", "线路 B（当前）"]);
  assert.equal(byId("selectApiProfile").value, id("b"));
  assert.equal(byId("btnDeleteApiProfile").hidden, false);
});
