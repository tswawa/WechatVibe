const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const root = path.join(__dirname, "../chatui");
const hostSource = readFileSync(path.join(root, "advisor.js"), "utf8");
const frameSource = readFileSync(path.join(root, "advisor-frame.js"), "utf8");
const shellSource = readFileSync(path.join(root, "advisor-window.js"), "utf8");
const frameHtml = readFileSync(path.join(root, "advisor-frame.html"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const json = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function node(tag = "div", id = "") {
  const element = { tag, id, className: "", textContent: "", value: "", style: {}, hidden: false,
    disabled: false, dataset: {}, children: [], listeners: {}, attributes: {}, parentNode: null,
    scrollTop: 0, scrollHeight: 200, clientHeight: 180, offsetWidth: 360, moves: 0 };
  element.classList = {
    contains: name => element.className.split(/\s+/).includes(name),
    add: name => { if (!element.classList.contains(name)) element.className += " " + name; },
    remove: name => { element.className = element.className.split(/\s+/).filter(item => item !== name).join(" "); },
    toggle: (name, enabled) => enabled ? element.classList.add(name) : element.classList.remove(name)
  };
  element.setAttribute = (name, value) => { element.attributes[name] = value; };
  element.addEventListener = (name, handler) => { (element.listeners[name] ||= []).push(handler); };
  element.appendChild = child => {
    element.moves++;
    child.remove(); child.parentNode = element; element.children.push(child); return child;
  };
  element.insertBefore = (child, reference) => {
    if (!reference) return element.appendChild(child);
    element.moves++;
    child.remove(); child.parentNode = element;
    const index = element.children.indexOf(reference);
    element.children.splice(index < 0 ? element.children.length : index, 0, child); return child;
  };
  element.remove = () => {
    if (element.parentNode) element.parentNode.children = element.parentNode.children.filter(child => child !== element);
    element.parentNode = null;
  };
  element.replaceChildren = (...children) => {
    for (const child of [...element.children]) child.remove();
    for (const child of children) element.appendChild(child);
  };
  element.dispatch = (name, event = {}) => Promise.all((element.listeners[name] || []).map(handler => handler(event)));
  return element;
}
function environment(ids) {
  const elements = new Map(ids.map(id => [id, node("div", id)]));
  const listeners = {}, storage = new Map(), storageWrites = new Map(), messages = [], timers = new Map();
  let nextTimer = 0;
  const document = { body: node("body"), readyState: "loading", getElementById: id => elements.get(id) || null,
    createElement: tag => node(tag), createTextNode: text => { const result = node("text"); result.textContent = text; return result; },
    addEventListener() {} };
  const window = { innerWidth: 1200, crypto: webcrypto, document,
    addEventListener: (name, handler) => { (listeners[name] ||= []).push(handler); },
    dispatchEvent: event => { for (const handler of listeners[event.type] || []) handler(event); return true; },
    postMessage: data => { messages.push(json(data)); } };
  const context = vm.createContext({ window, document, localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => {
      storageWrites.set(key, (storageWrites.get(key) || 0) + 1); storage.set(key, String(value));
    },
    removeItem: key => storage.delete(key) },
    setTimeout: handler => { const id = ++nextTimer; timers.set(id, handler); return id; },
    clearTimeout: id => timers.delete(id), URLSearchParams, Uint8Array, AbortController,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    alert() {}, confirm: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  return { elements, listeners, storage, storageWrites, messages, timers, window, context,
    emit: event => (listeners.message || []).forEach(handler => handler(event)),
    async flushTimers() { const batch = [...timers.values()]; timers.clear(); for (const handler of batch) await handler(); } };
}
function host() {
  const env = environment(["advisorRepoContainer", "btnToolbarAdvisor"]);
  env.frameWindow = { postMessage: data => env.messages.push(json(data)) };
  let nativeListener;
  env.window.desktopHost = {
    sendAdvisorEnvelope: data => { env.messages.push(json(data)); return Promise.resolve(); },
    onAdvisorEnvelope: listener => { nativeListener = listener; return () => {}; },
    toggleAdvisor: async force => ({ visible: typeof force === "boolean" ? force : !env.advisor.panelVisible })
  };
  env.nativeEmit = data => nativeListener?.(json(data));
  vm.runInContext(hostSource, env.context);
  env.advisor = env.window.Advisor; env.advisor.setupFrameCommunication();
  return env;
}
function frame() {
  const env = environment(["agentName", "agentMenu", "btnAgentMenu", "advisorWelcome", "welcomeText", "advisorTimeline", "timelineControls",
    "btnStopRun", "btnRetryRun", "advisorInput", "btnAdvisorSend", "btnModelMenu", "modelMenu", "modelName", "advisorComposerNote",
    "btnNewThread", "newThreadLabel", "btnHistory", "historyMenu"]);
  env.window.parent = { postMessage: data => env.messages.push(json(data)) };
  vm.runInContext(frameSource, env.context);
  return env;
}
function catalog(enabled = true) {
  return { agents: [{ id: "advisor", name: "军师", description: "", prompt: "沟通建议", skillIds: [], enabled,
    builtin: true, revision: 1 }], skills: [], engine: { state: "available" }, permissions: { readOnly: true } };
}
function thread(account = "account-a", user = "friend-a", agentId = "advisor", messages = []) {
  return { id: `${account}-${user}-${agentId}`, account, user, agentId, messages };
}
function ready(env, account = "account-a", user = "friend-a") {
  const advisor = env.advisor;
  advisor.catalog = catalog(); advisor.catalogReady = true; advisor.activeAgentId = "advisor";
  advisor.currentAccount = account; advisor.currentUser = user;
  advisor.setCachedThread(account, user, "advisor", thread(account, user));
  return advisor;
}
function request(env, type, payload = {}, overrides = {}) {
  return { source: env.frameWindow, data: { envelope: "advisor", nonce: env.advisor.handshakeNonce, type,
    payload, scope: json(env.advisor.captureScope()), ...overrides } };
}
function pair() {
  const hostEnv = host(), frameEnv = frame();
  frameEnv.window.parent = hostEnv.window;
  hostEnv.frameWindow = frameEnv.window;
  hostEnv.window.postMessage = data => hostEnv.nativeEmit(data);
  hostEnv.window.desktopHost.sendAdvisorEnvelope = data => {
    hostEnv.messages.push(json(data)); frameEnv.emit({ source: hostEnv.window, data: json(data) });
    return Promise.resolve();
  };
  return { hostEnv, frameEnv };
}
function shellPair() {
  const hostEnv = host(), frameEnv = frame(), shellEnv = environment(["advisorFrame"]);
  const iframe = shellEnv.elements.get("advisorFrame");
  const deliveries = [];
  let receiver;
  shellEnv.window.advisorWindow = {
    receive: callback => { receiver = callback; }, send: data => hostEnv.nativeEmit(data)
  };
  iframe.contentWindow = frameEnv.window;
  frameEnv.window.parent = shellEnv.window;
  shellEnv.window.postMessage = data => shellEnv.emit({ source: frameEnv.window, data: json(data) });
  frameEnv.window.postMessage = data => deliveries.push(json(data));
  hostEnv.window.desktopHost.sendAdvisorEnvelope = data => {
    hostEnv.messages.push(json(data)); receiver(json(data)); return Promise.resolve();
  };
  vm.runInContext(shellSource, shellEnv.context);
  return { hostEnv, frameEnv, shellEnv, iframe, async load() {
    await iframe.dispatch("load");
    while (deliveries.length) frameEnv.emit({ source: shellEnv.window, data: deliveries.shift() });
  } };
}
test("catalog failure cannot create presets, enabled relationships or an available engine", async () => {
  const env = host(), advisor = env.advisor;
  advisor.fetchJson = async () => ({ error: "目录服务不可用" });
  assert.equal(await advisor.loadCatalog(), false);
  assert.equal(advisor.catalogReady, false);
  assert.equal(advisor.getEnabledTemplates().length, 0);
  assert.equal(advisor.catalogError, "目录服务不可用");
  assert.equal(advisor.activeAgentId, "");
});
test("failed server mutation is not saved locally and the last enabled agent can be disabled", async () => {
  const env = host(), advisor = ready(env);
  advisor.fetchJson = async () => ({ error: "保存拒绝" });
  assert.equal(await advisor.saveTemplate({ id: "advisor", name: "别名", description: "", prompt: "test", skillIds: [] }), false);
  assert.equal(advisor.catalog.agents[0].name, "军师");
  advisor.fetchJson = async () => catalog(false);
  assert.equal(await advisor.enableTemplate("advisor", false), true);
  assert.equal(advisor.catalog.agents[0].enabled, false);
  assert.equal(advisor.getEnabledTemplates().length, 0);
  assert.equal(advisor.activeAgentId, "");
});
test("HTTP JSON reason survives fetchJson instead of becoming generic HTTP status", async () => {
  const env = host();
  env.context.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "当前账号已经变更" }) });
  const result = await env.advisor.fetchJson("/api/advisor/run");
  assert.equal(result.error, "当前账号已经变更"); assert.equal(result.status, 409);
});
test("native host bridge ignores DOM messages and rejects wrong nonce, scope, fields and oversized requests", () => {
  const env = host(), advisor = ready(env); let calls = 0;
  advisor.startRun = () => { calls++; };
  const good = request(env, "ADVISOR_SEND", { text: "建议", agentId: "advisor" });
  env.emit({ ...good, source: {} }); env.emit(good);
  env.nativeEmit(request(env, "ADVISOR_SEND", good.data.payload, { nonce: "fake" }).data);
  env.nativeEmit(request(env, "ADVISOR_SEND", good.data.payload, { scope: { ...good.data.scope, generation: 99 } }).data);
  env.nativeEmit(request(env, "ADVISOR_SEND", { text: "建议", agentId: "advisor", account: "other" }).data);
  env.nativeEmit(request(env, "ADVISOR_SEND", { text: 7, agentId: "advisor" }).data);
  env.nativeEmit(request(env, "ADVISOR_SEND", { text: "a".repeat(16001), agentId: "advisor" }).data);
  assert.equal(calls, 0); env.nativeEmit(good.data); assert.equal(calls, 1);
  assert.match(advisor.handshakeNonce, /^adv_[0-9a-f]{32}$/);
});
test("actual host/frame handshake and draft requests preserve selected identity", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake(); assert.equal(advisor.frameReady, true);
  const input = frameEnv.elements.get("advisorInput"); input.value = "这是一条草稿"; input.dispatch("input");
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "这是一条草稿");
  const scope = json(advisor.captureScope());
  advisor.onSessionChanged("account-b", "friend-b");
  hostEnv.nativeEmit({ envelope: "advisor", nonce: advisor.handshakeNonce,
    type: "ADVISOR_DRAFT_UPDATE", payload: { draft: "迟到草稿", agentId: "advisor" }, scope });
  assert.equal(advisor.getDraft("account-b", "friend-b", "advisor"), "");
});
test("late thread responses after a switch cannot overwrite new conversation", async () => {
  const env = host(), advisor = ready(env), threadResult = deferred();
  advisor.fetchJson = () => threadResult.promise;
  const scopeA = advisor.captureScope();
  const loading = advisor.loadThread(scopeA);
  advisor.generation++; advisor.currentAccount = "account-b"; advisor.currentUser = "friend-b";
  advisor.syncThreadToFrame(thread("account-b", "friend-b"));
  const count = env.messages.length;
  threadResult.resolve({ thread: thread("account-a", "friend-a", "advisor", [{ id: "late", role: "assistant", text: "A" }]) });
  await loading;
  assert.equal(env.messages.length, count);
  assert.equal(advisor.getCachedThread("account-b", "friend-b", "advisor").messages.length, 0);
});
test("late accepted start cannot change the new account run or clear an old draft", async () => {
  const env = host(), advisor = ready(env), response = deferred();
  advisor.fetchJson = () => response.promise;
  const starting = advisor.startRun("未提交完的消息");
  advisor.generation++; advisor.currentAccount = "account-b"; advisor.currentUser = "friend-b";
  advisor.submitPending = false; advisor.currentRunId = "new-run";
  response.resolve({ run: { id: "old-run", threadId: thread().id, state: "running" } }); await starting;
  assert.equal(advisor.currentRunId, "new-run");
  assert.equal(advisor.pendingRequests[advisor.scopeKey("account-a", "friend-a", "advisor")].message, "未提交完的消息");
});
test("late polling cannot contaminate another agent, even under same account/user", async () => {
  const env = host(), advisor = ready(env), response = deferred();
  advisor.fetchJson = () => response.promise;
  const polling = advisor.pollEvents("run-a", advisor.captureScope());
  advisor.generation++; advisor.activeAgentId = "empathy"; advisor.abortCurrentPoll();
  response.resolve({ events: [{ seq: 1, type: "text", text: "旧消息", messageId: "a" }],
    run: { id: "run-a", state: "done" } }); await polling;
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "empathy").messages.length, 0);
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages.length, 0);
});
test("failed start keeps draft, never invents output, and retries same requestId", async () => {
  const env = host(), advisor = ready(env), bodies = [];
  advisor.fetchJson = async (url, options) => { bodies.push(JSON.parse(options.body)); return { error: "连接超时" }; };
  await advisor.startRun("保留我的草稿"); await advisor.retryRun();
  assert.equal(bodies.length, 2); assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "保留我的草稿");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages.length, 0);
  assert.equal(advisor.currentRunId, null);
  assert.ok(env.messages.some(message => message.type === "ADVISOR_PROBLEM" && message.payload.error === "连接超时"));
});
test("stop is acknowledged by backend before terminal state; partial text survives failure", async () => {
  const env = host(), advisor = ready(env), response = deferred();
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor",
    [{ id: "partial", role: "assistant", text: "已经生成的片段" }]));
  advisor.currentRunId = "active-run"; advisor.fetchJson = () => response.promise;
  const stopping = advisor.stopRun();
  assert.equal(advisor.currentRunId, "active-run"); assert.equal(advisor.stopPending, true);
  assert.ok(!env.messages.some(message => message.payload.run?.state === "stopped"));
  response.resolve({ error: "停止请求失败" }); await stopping;
  assert.equal(advisor.currentRunId, "active-run");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages[0].text, "已经生成的片段");
});
test("confirmed stop preserves partial projection and terminal status", async () => {
  const env = host(), advisor = ready(env);
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor",
    [{ id: "partial", role: "assistant", text: "片段" }]));
  advisor.currentRunId = "active-run";
  advisor.fetchJson = async url => url === "/api/advisor/stop" ? { run: { id: "active-run", state: "stopped" } } : { error: "读取暂时失败" };
  await advisor.stopRun();
  assert.equal(advisor.currentRunId, null);
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages[0].text, "片段");
  assert.ok(env.messages.some(message => message.payload.run?.state === "stopped"));
});
test("account clearing erases only that account caches and blocks late writers", async () => {
  const env = host(), advisor = ready(env), stopped = [];
  advisor.setDraft("account-a", "friend-a", "advisor", "A"); advisor.setDraft("account-b", "friend-b", "advisor", "B");
  advisor.setCachedThread("account-b", "friend-b", "advisor", thread("account-b", "friend-b"));
  advisor.currentRunId = "run-a";
  advisor.fetchJson = async (url, options) => { stopped.push(JSON.parse(options.body)); return {}; };
  advisor.onAccountCleared("account-a");
  advisor.setDraft("account-a", "friend-a", "advisor", "迟到写入");
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread());
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "");
  assert.equal(advisor.getDraft("account-b", "friend-b", "advisor"), "B");
  assert.equal(Object.keys(JSON.parse(env.storage.get("advisor_threads_v1"))).length, 1);
  assert.equal(advisor.currentRunId, null); assert.equal(stopped[0].account, "account-a");
});
test("session changes and native open do not request or show context preparation", async () => {
  const env = host(), advisor = ready(env), calls = [];
  advisor.fetchJson = async url => { calls.push(url); return { thread: thread(advisor.currentAccount, advisor.currentUser, advisor.activeAgentId) }; };
  advisor.onSessionChanged("account-a", "friend-b"); await advisor.togglePanel(true);
  assert.ok(calls.every(url => (url.startsWith("/api/advisor/thread?") || url.startsWith("/api/advisor/threads")) || url === "/api/model-source"));
  assert.ok(!hostSource.includes("/api/advisor/context"));
  assert.ok(!frameSource.includes("readCount"));
});
test("frame validates parent init and rejects stale scopes without blanking current text", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor",
    [{ id: "safe", role: "assistant", text: "<script>bad()</script>" }]));
  advisor.initFrameHandshake();
  const timeline = frameEnv.elements.get("advisorTimeline");
  const bubble = timeline.children.find(child => child.dataset.msgId === "safe").children[0];
  assert.equal(bubble.textContent, "<script>bad()</script>");
  const init = hostEnv.messages.find(message => message.type === "ADVISOR_INIT");
  frameEnv.emit({ source: {}, data: init });
  frameEnv.emit({ source: hostEnv.window, data: { ...init, nonce: "fake", envelope: "unknown" } });
  assert.equal(bubble.textContent, "<script>bad()</script>");
  advisor.generation++;
  advisor.syncThreadToFrame(thread("account-a", "friend-a", "advisor", [{ id: "new", role: "assistant", text: "新结果" }]));
  frameEnv.emit({ source: hostEnv.window, data: { envelope: "advisor", nonce: advisor.handshakeNonce,
    type: "ADVISOR_SET_THREAD", scope: init.scope, payload: { thread: init.payload.thread, run: null,
      agentId: "advisor", draft: "" } } });
  assert.ok(timeline.children.some(child => child.dataset.msgId === "new"));
  assert.ok(!timeline.children.some(child => child.dataset.msgId === "safe"));
});
test("frame submit failure leaves input draft and relies on real host acknowledgement", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.fetchJson = async () => ({ error: "额度不足" }); advisor.initFrameHandshake();
  const input = frameEnv.elements.get("advisorInput"); input.value = "我要保留"; await input.dispatch("input");
  await frameEnv.elements.get("btnAdvisorSend").dispatch("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, "我要保留");
  assert.equal(frameEnv.elements.get("btnAdvisorSend").disabled, false);
  assert.ok(frameEnv.elements.get("advisorTimeline").children.some(child => child.children[0]?.textContent === "额度不足"));
});
test("isolated frame has no network, unsafe HTML rendering or header context pill", () => {
  assert.ok(frameHtml.includes("connect-src 'none'")); assert.ok(frameHtml.includes("object-src 'none'"));
  assert.ok(!indexHtml.includes('id="advisorPanel"')); assert.ok(!indexHtml.includes('id="advisorFrame"'));
  assert.ok(!frameSource.includes(".innerHTML")); assert.ok(!frameHtml.includes("contextStatusPill"));
  assert.ok(!frameHtml.includes("Shift+Enter")); assert.ok(frameSource.includes("AdvisorTimeline?.renderInto"));
});
test("different unloaded threads with empty IDs cannot retain the previous scope error", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.threadCache = {}; advisor.initFrameHandshake(); advisor.problem({ error: "旧会话错误" });
  advisor.generation++; advisor.currentUser = "friend-b";
  advisor.syncThreadToFrame(advisor.getCachedThread("account-a", "friend-b", "advisor"));
  assert.ok(!frameEnv.elements.get("advisorTimeline").children.some(child => child.children[0]?.textContent === "旧会话错误"));
});
test("native retry fields reach the optional timeline component and disposed nodes release timers", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv), received = [], disposed = [];
  frameEnv.window.AdvisorTimeline = {
    statusInto: (container, event) => { received.push(json(event)); container.textContent = event.text || event.state; },
    disposeInto: container => disposed.push(container), renderInto: (container, value) => { container.textContent = value; }
  };
  advisor.initFrameHandshake();
  const event = { seq: 1, type: "status", state: "retry", text: "正在重试", next: 1900000000000, attempt: 3 };
  advisor.syncThreadToFrame(thread(), { id: "retry-run", threadId: thread().id, state: "running", phaseEvent: event });
  assert.ok(received.some(value => value.next === event.next && value.attempt === 3));
  advisor.generation++; advisor.currentUser = "friend-b";
  advisor.syncThreadToFrame(advisor.getCachedThread("account-a", "friend-b", "advisor"));
  assert.ok(disposed.length > 0);
  const previous = received.length;
  advisor.syncThreadToFrame(thread("account-a", "friend-b", "advisor", [{ id: "invalid", role: "status", text: "fake",
    event: { ...event, next: "later" } }]));
  assert.equal(received.length, previous);
});
test("native visibility is confirmed by IPC and has no resize or width persistence", async () => {
  const env = host(), advisor = env.advisor;
  const result = deferred(); env.window.desktopHost.toggleAdvisor = () => result.promise;
  advisor.loadCatalog = async () => true; advisor.loadThread = async () => {};
  const opening = advisor.togglePanel(); assert.equal(advisor.panelVisible, false);
  result.resolve({ visible: true }); await opening; assert.equal(advisor.panelVisible, true);
  assert.ok(env.elements.get("btnToolbarAdvisor").classList.contains("active"));
  env.nativeEmit({ type: "ADVISOR_WINDOW_CLOSED" }); assert.equal(advisor.panelVisible, false);
  assert.ok(!hostSource.includes("advisor_panel_width")); assert.ok(!hostSource.includes("applyPanelWidth"));
  assert.ok(!hostSource.includes("setupResizer")); assert.ok(!indexHtml.includes("advisorResizer"));
});

test("conversation and template switches cancel the actual previous backend run", async () => {
  const env = host(), advisor = ready(env), stopped = [];
  env.context.fetch = async (url, options = {}) => {
    if (url === "/api/advisor/stop") {
      const body = JSON.parse(options.body); stopped.push(body);
      return { ok: true, status: 200, json: async () => ({ run: { id: body.runId, state: "stopped" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ thread: thread(advisor.currentAccount, advisor.currentUser, advisor.activeAgentId), context: { state: "ready" } }) };
  };
  advisor.currentRunId = "previous-conversation-run";
  advisor.onSessionChanged("account-a", "friend-b");
  await Promise.resolve();
  assert.deepEqual(stopped[0], { account: "account-a", user: "friend-a", runId: "previous-conversation-run" });
  advisor.catalog.agents.push({ ...advisor.catalog.agents[0], id: "empathy", name: "共情" });
  advisor.currentRunId = "previous-template-run";
  env.nativeEmit(request(env, "ADVISOR_SWITCH_TEMPLATE", { agentId: "empathy" }).data);
  assert.ok(stopped.some(value => value.runId === "previous-template-run" && value.user === "friend-b"));
});
test("native companion READY creates fresh handshake and untrusted DOM READY is ignored", () => {
  const env = host(), advisor = ready(env);
  const initial = advisor.handshakeNonce;
  env.emit({ source: {}, data: { type: "ADVISOR_WINDOW_READY" } });
  assert.equal(advisor.handshakeNonce, initial);
  env.nativeEmit({ type: "ADVISOR_WINDOW_READY" });
  assert.notEqual(advisor.handshakeNonce, initial);
  assert.equal(env.messages.at(-1).type, "ADVISOR_INIT");
  assert.equal(env.messages.at(-1).nonce, advisor.handshakeNonce);
});
test("plain browser refuses native feature without inventing a panel", async () => {
  const env = host(); delete env.window.desktopHost;
  let warning = ""; env.context.alert = value => { warning = value; };
  assert.equal(await env.advisor.togglePanel(), false);
  assert.equal(env.advisor.panelVisible, false);
  assert.equal(warning, "聊天助手需要在桌面客户端中使用");
  assert.equal(env.elements.has("advisorPanel"), false);
});
test("welcome text is saved by API and appears safely in empty companion", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  let payload;
  advisor.fetchJson = async (url, options) => {
    payload = JSON.parse(options.body);
    const updated = catalog(); updated.agents[0].welcome = payload.agent.welcome; return updated;
  };
  await advisor.saveTemplate({ id: "advisor", name: "军师", description: "", prompt: "test", welcome: "你好，朋友 <b>欢迎</b>", skillIds: [] });
  advisor.initFrameHandshake();
  assert.equal(payload.agent.welcome, "你好，朋友 <b>欢迎</b>");
  assert.equal(frameEnv.elements.get("welcomeText").textContent, "你好，朋友 <b>欢迎</b>");
  assert.equal(frameEnv.elements.get("advisorWelcome").hidden, false);
  assert.equal(frameEnv.elements.get("advisorTimeline").hidden, true);
  assert.ok(frameEnv.window.document.body.classList.contains("advisor-empty"));
  advisor.syncThreadToFrame(thread("account-a", "friend-a", "advisor", [{ id: "first", role: "user", text: "你好" }]));
  assert.equal(frameEnv.elements.get("advisorWelcome").hidden, true);
  assert.equal(frameEnv.elements.get("advisorTimeline").hidden, false);
  assert.ok(!frameEnv.window.document.body.classList.contains("advisor-empty"));
});
test("reset command only resets agent thread, bypasses model engine and preserves other draft", async () => {
  const env = host(), advisor = ready(env), calls = [];
  advisor.catalog.engine.state = "missing"; advisor.currentRunId = "old-run";
  advisor.setDraft("account-a", "friend-a", "advisor", "没有提交的普通草稿");
  advisor.fetchJson = async (url, options) => {
    if (String(url).startsWith("/api/advisor/threads")) return { threads: [] };
    calls.push({ url, body: JSON.parse(options.body) }); return { thread: { ...thread(), id: "fresh-thread" }, run: null };
  };
  await advisor.startRun("  /reset  ");
  assert.deepEqual(calls.map(call => call.url), ["/api/advisor/new-thread"]);
  assert.deepEqual(calls[0].body, { account: "account-a", user: "friend-a", agentId: "advisor" });
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "没有提交的普通草稿");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").id, "fresh-thread");
  assert.equal(advisor.currentRunId, null);
  // The composer now offers the same action as a button; the command must keep working too.
  assert.ok(frameHtml.includes('id="btnNewThread"'));
  assert.ok(!frameHtml.includes("reset"));
});
test("failed reset leaves command draft and previous content; successful reset clears only command", async () => {
  const env = host(), advisor = ready(env);
  advisor.setDraft("account-a", "friend-a", "advisor", "/reset");
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor",
    [{ id: "saved", role: "assistant", text: "旧结果" }]));
  advisor.fetchJson = async () => ({ error: "暂时失败" }); await advisor.startRun("/reset");
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "/reset");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages.length, 1);
  advisor.fetchJson = async () => ({ thread: { ...thread(), id: "new-thread" } }); await advisor.startRun("/reset");
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages.length, 0);
});
test("simple agent popover switches enabled template without management tabs or reset controls", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.catalog.agents.push({ ...advisor.catalog.agents[0], id: "empathy", name: "共情" });
  advisor.catalog.agents.push({ ...advisor.catalog.agents[0], id: "disabled", enabled: false, name: "停用" });
  advisor.fetchJson = async () => ({ thread: thread(advisor.currentAccount, advisor.currentUser, advisor.activeAgentId) });
  advisor.initFrameHandshake();
  const menu = frameEnv.elements.get("agentMenu");
  assert.equal(menu.children.length, 2);
  assert.ok(!frameHtml.includes("templateTabs"));
  assert.equal(frameEnv.elements.get("agentName").textContent, "军师");
  await frameEnv.elements.get("btnAgentMenu").dispatch("click"); assert.equal(menu.hidden, false);
  await menu.children[1].dispatch("click"); await Promise.resolve();
  assert.equal(advisor.activeAgentId, "empathy"); assert.equal(menu.hidden, true);
});
function modelProfiles() {
  return [{ id: "a".repeat(32), name: "档案甲", model: "model-a" },
    { id: "b".repeat(32), name: "档案乙", model: "model-b" }];
}
// Exactly what `ModelSourceStore.public()` returns: `api` carries no `name`, and the label
// lives in `profiles[].name`. Fixtures that invented `api.name` hid a validator bug.
function modelSourceDocument(overrides = {}) {
  const [first, second] = modelProfiles();
  const publicProfile = profile => ({ ...profile, label: profile.name, protocol: "chat_completions",
    baseUrl: "https://api.test/v1", contextTokens: 8192, hasKey: true });
  return { mode: "api", status: "active", sourceId: "source-a", label: "档案甲",
    api: { id: first.id, protocol: "chat_completions", baseUrl: "https://api.test/v1",
      model: "model-a", contextTokens: 8192, hasKey: true },
    profiles: [publicProfile(first), publicProfile(second)],
    assistantProfileId: null, ...overrides };
}
function modelRows(menu) {
  return Array.from(menu.children).filter(child => child.dataset && child.dataset.modelOption);
}
function modelRowText(row) {
  return [row.children[1].children[0].textContent, row.children[1].children[1].textContent];
}
test("composer picker lists follow-analysis and every saved model with its model id", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.modelProfiles = modelProfiles(); advisor.assistantProfileId = "b".repeat(32);
  advisor.analysisLabel = "本地 Laya";
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.initFrameHandshake(); advisor.syncModelsToFrame();
  const menu = frameEnv.elements.get("modelMenu"), chip = frameEnv.elements.get("modelName");
  const rows = modelRows(menu);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].dataset.modelOption, "follow");
  assert.deepEqual(modelRowText(rows[0]), ["跟随分析", "当前：本地 Laya"]);
  assert.equal(rows[0].attributes["aria-checked"], "false");
  assert.deepEqual(modelRowText(rows[1]), ["档案甲", "model-a"]);
  assert.deepEqual(modelRowText(rows[2]), ["档案乙", "model-b"]);
  assert.equal(rows[2].attributes["aria-checked"], "true");
  assert.equal(rows[2].children[0].textContent, "✓");
  assert.equal(chip.textContent, "档案乙");
  assert.equal(frameEnv.elements.get("btnModelMenu").dataset.mode, "profile");
  // The picker lives in the composer, not the title bar, so it is reachable while typing.
  assert.ok(frameHtml.indexOf('id="btnModelMenu"') > frameHtml.indexOf('class="advisor-input-bar"'));
  await frameEnv.elements.get("btnModelMenu").dispatch("click"); assert.equal(menu.hidden, false);
  await rows[2].dispatch("click"); assert.equal(menu.hidden, true);
  assert.equal(sent.filter(message => message.type === "ADVISOR_SELECT_MODEL").length, 0);
  await frameEnv.elements.get("btnModelMenu").dispatch("click");
  await modelRows(menu)[1].dispatch("click");
  const selected = sent.filter(message => message.type === "ADVISOR_SELECT_MODEL");
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].payload, { profileId: "a".repeat(32) });
});
test("profile switch posts select then refreshes the catalog and never touches the analysis mode", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.modelProfiles = modelProfiles(); advisor.assistantProfileId = "a".repeat(32);
  advisor.initFrameHandshake(); advisor.syncModelsToFrame();
  const calls = [];
  advisor.fetchJson = async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (url === "/api/model-source/select") return { profileId: "b".repeat(32), sourceId: "source-b", revision: 4 };
    return catalog();
  };
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_SELECT_MODEL", { profileId: "b".repeat(32) }).data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.url), ["/api/model-source/select", "/api/advisor/catalog"]);
  assert.deepEqual(calls[0].body, { profileId: "b".repeat(32) });
  assert.ok(!calls.some(call => call.url === "/api/model-source/activate"));
  assert.equal(advisor.assistantProfileId, "b".repeat(32));
  const rows = modelRows(frameEnv.elements.get("modelMenu"));
  assert.equal(rows[0].attributes["aria-checked"], "false");
  assert.equal(rows[1].attributes["aria-checked"], "false");
  assert.equal(rows[2].attributes["aria-checked"], "true");
  assert.equal(frameEnv.elements.get("modelName").textContent, "档案乙");
});
test("failed profile switch keeps the previous selection and reports a short error", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.modelProfiles = modelProfiles(); advisor.assistantProfileId = "a".repeat(32);
  advisor.initFrameHandshake(); advisor.syncModelsToFrame();
  const calls = [];
  advisor.fetchJson = async url => {
    calls.push(url);
    if (url === "/api/model-source/select") return { error: "invalid model source request", status: 400 };
    return catalog();
  };
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_SELECT_MODEL", { profileId: "b".repeat(32) }).data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["/api/model-source/select"]);
  assert.ok(!calls.includes("/api/model-source/activate"));
  assert.equal(advisor.assistantProfileId, "a".repeat(32));
  const rows = modelRows(frameEnv.elements.get("modelMenu"));
  assert.equal(rows[1].attributes["aria-checked"], "true");
  assert.equal(rows[2].attributes["aria-checked"], "false");
  assert.equal(frameEnv.elements.get("modelName").textContent, "档案甲");
  assert.ok(hostEnv.messages.some(message => message.type === "ADVISOR_PROBLEM" &&
    message.payload.error === "模型档案不存在或已更改" && message.payload.retryKind === "catalog"));
});
test("an unknown or malformed profile switch is rejected before any request", async () => {
  const env = host(), advisor = ready(env);
  advisor.modelProfiles = modelProfiles(); let calls = 0;
  advisor.fetchJson = async () => { calls++; return {}; };
  env.nativeEmit(request(env, "ADVISOR_SELECT_MODEL", { profileId: "f".repeat(32) }).data);
  env.nativeEmit(request(env, "ADVISOR_SELECT_MODEL", { profileId: "a".repeat(32), agentId: "advisor" }).data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(advisor.assistantProfileId, "");
});
test("the picker accepts the real model-source document and names the profile analysis would use", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.fetchJson = async () => modelSourceDocument();
  advisor.initFrameHandshake();
  assert.equal(await advisor.loadModelProfiles(), true);
  assert.equal(advisor.modelProfiles.length, 2);
  // `api` has no `name`; the label must come from the profile row with the same id.
  assert.equal(advisor.analysisLabel, "档案甲");
  const rows = modelRows(frameEnv.elements.get("modelMenu"));
  assert.equal(rows.length, 3);
  assert.deepEqual(modelRowText(rows[0]), ["跟随分析", "当前：档案甲"]);
  assert.equal(frameEnv.elements.get("modelName").textContent, "跟随分析 · 档案甲");
});
test("a profile name at the store's 64-character cap still reaches the picker", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const longName = "长".repeat(64);
  const document = modelSourceDocument();
  document.profiles[1].name = longName; document.profiles[1].label = longName;
  advisor.fetchJson = async () => document;
  advisor.initFrameHandshake();
  assert.equal(await advisor.loadModelProfiles(), true);
  assert.equal(advisor.modelProfiles.length, 2);
  assert.equal(modelRowText(modelRows(frameEnv.elements.get("modelMenu"))[2])[0], longName);
});
test("the model menu follows the analysis selection until a profile is pinned", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.fetchJson = async () => modelSourceDocument({ assistantProfileId: null });
  advisor.initFrameHandshake();
  assert.equal(await advisor.loadModelProfiles(), true);
  assert.equal(advisor.assistantProfileId, "");
  assert.equal(advisor.analysisLabel, "档案甲");
  const rows = modelRows(frameEnv.elements.get("modelMenu"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].attributes["aria-checked"], "true");
  assert.ok(rows.slice(1).every(row => row.attributes["aria-checked"] === "false"));
  assert.equal(frameEnv.elements.get("modelName").textContent, "跟随分析 · 档案甲");
  assert.equal(frameEnv.elements.get("btnModelMenu").dataset.mode, "follow");
});
test("an empty profile list keeps the picker usable and explains where models come from", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const calls = [];
  advisor.fetchJson = async url => { calls.push(url); return { mode: "local", api: null, label: "本地 Laya", profiles: [], assistantProfileId: null }; };
  advisor.initFrameHandshake();
  assert.equal(await advisor.loadModelProfiles(), true);
  assert.deepEqual(calls, ["/api/model-source"]);
  assert.equal(advisor.modelProfiles.length, 0);
  // The chip stays clickable: a disabled control would hide the only explanation of why the
  // list is empty and where the user adds models.
  assert.equal(frameEnv.elements.get("btnModelMenu").disabled, false);
  // Local analysis never becomes the assistant's model, so the chip must not claim "本地 Laya".
  assert.equal(frameEnv.elements.get("modelName").textContent, "未配置模型");
  const menu = frameEnv.elements.get("modelMenu");
  assert.equal(modelRows(menu).length, 0);
  assert.ok(Array.from(menu.children).some(child => /设置 → 模型配置/.test(child.textContent)));
});
test("a blocked composer explains itself instead of ignoring send", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.catalog.engine.state = "missing";
  advisor.initFrameHandshake();
  const note = frameEnv.elements.get("advisorComposerNote");
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /助手引擎不可用/);
  assert.match(note.textContent, /setup:advisor-engine/);
  assert.equal(frameEnv.elements.get("btnAdvisorSend").disabled, true);
  assert.match(frameEnv.elements.get("btnAdvisorSend").title, /助手引擎不可用/);
});
test("the composer asks for a conversation first and clears once everything is ready", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.currentAccount = ""; advisor.currentUser = "";
  advisor.initFrameHandshake();
  const note = frameEnv.elements.get("advisorComposerNote"), send = frameEnv.elements.get("btnAdvisorSend");
  assert.equal(note.textContent, "先在左侧选择一个微信会话");
  assert.equal(send.disabled, true);
  advisor.currentAccount = "account-a"; advisor.currentUser = "friend-a";
  advisor.initFrameHandshake();
  assert.equal(note.hidden, true);
  assert.equal(send.disabled, false);
  assert.equal(send.title, "发送");
});
test("new conversation asks for a second click before replacing an existing thread", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.initFrameHandshake();
  advisor.postToFrame("ADVISOR_SET_THREAD", { thread: thread("account-a", "friend-a", "advisor",
    [{ id: "m1", role: "user", text: "你好" }]), run: null, draft: "" });
  const button = frameEnv.elements.get("btnNewThread"), label = frameEnv.elements.get("newThreadLabel");
  assert.equal(label.textContent, "新建");
  await button.dispatch("click");
  assert.equal(label.textContent, "确认新建");
  assert.equal(button.dataset.confirm, "1");
  assert.equal(sent.filter(message => message.type === "ADVISOR_NEW_THREAD").length, 0);
  await button.dispatch("click");
  assert.equal(label.textContent, "新建");
  assert.equal(sent.filter(message => message.type === "ADVISOR_NEW_THREAD").length, 1);
});
test("an empty conversation starts a new thread on the first click", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.initFrameHandshake();
  await frameEnv.elements.get("btnNewThread").dispatch("click");
  assert.equal(sent.filter(message => message.type === "ADVISOR_NEW_THREAD").length, 1);
});
test("the host turns the new-conversation button into a fresh thread request", async () => {
  const { hostEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const calls = [];
  advisor.fetchJson = async url => {
    calls.push(url);
    if (url === "/api/advisor/new-thread") return { thread: thread("account-a", "friend-a", "advisor", []) };
    return catalog();
  };
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_NEW_THREAD").data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["/api/advisor/new-thread",
    "/api/advisor/threads?account=account-a&user=friend-a&agentId=advisor"]);
});
test("closing model settings refreshes the picker while the panel stays open", async () => {
  const env = host(), advisor = ready(env);
  advisor.panelVisible = true;
  let calls = 0;
  advisor.fetchJson = async url => { if (url === "/api/model-source") calls++; return modelSourceDocument(); };
  env.window.dispatchEvent({ type: "model-source-settings-closed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(advisor.modelProfiles.length, 2);
  advisor.panelVisible = false;
  env.window.dispatchEvent({ type: "model-source-settings-closed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
test("choosing follow analysis drops the assistant pin and reloads the catalog", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.modelProfiles = modelProfiles(); advisor.assistantProfileId = "a".repeat(32);
  advisor.initFrameHandshake(); advisor.syncModelsToFrame();
  const calls = [];
  advisor.fetchJson = async (url, options) => {
    if (String(url).startsWith("/api/advisor/threads")) return { threads: [] };
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (url === "/api/model-source/select") return { profileId: null, sourceId: "source-analysis", revision: 5 };
    return catalog();
  };
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_SELECT_MODEL", { profileId: null }).data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.url), ["/api/model-source/select", "/api/advisor/catalog"]);
  assert.deepEqual(calls[0].body, { profileId: null });
  assert.equal(advisor.assistantProfileId, "");
  const rows = modelRows(frameEnv.elements.get("modelMenu"));
  assert.equal(rows[0].attributes["aria-checked"], "true");
  assert.equal(frameEnv.elements.get("modelName").textContent, "跟随分析");
});
test("the chip shows a busy label until the host reports the new selection", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.modelProfiles = modelProfiles(); advisor.assistantProfileId = "";
  advisor.initFrameHandshake(); advisor.syncModelsToFrame();
  const menu = frameEnv.elements.get("modelMenu"), button = frameEnv.elements.get("btnModelMenu");
  await button.dispatch("click");
  await modelRows(menu)[1].dispatch("click");
  assert.equal(frameEnv.elements.get("modelName").textContent, "切换中…");
  assert.equal(button.disabled, true);
  assert.equal(button.attributes["aria-busy"], "true");
  advisor.assistantProfileId = "a".repeat(32); advisor.syncModelsToFrame();
  assert.equal(frameEnv.elements.get("modelName").textContent, "档案甲");
  assert.equal(button.disabled, false);
  assert.equal(button.attributes["aria-busy"], "false");
});
test("communication advice replaces the emoji entry while the adviser keeps its own command", () => {
  const appSource = readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(!appSource.includes('byId("btnEmoji")'));
  assert.ok(indexHtml.includes('id="btnToolbarGuidance"'));
  assert.ok(indexHtml.indexOf('id="btnToolbarGuidance"') < indexHtml.indexOf('id="btnToggleIntent"'));
  assert.ok(indexHtml.includes('class="toolbar-text-btn" id="btnToolbarAdvisor"'));
  assert.ok(indexHtml.indexOf('id="btnToolbarAdvisor"') > indexHtml.indexOf('id="btnToolbarPersona"'));
  assert.ok(indexHtml.indexOf('id="btnToolbarAdvisor"') < indexHtml.indexOf('id="btnRetryAnalysis"'));
});
test("switch during actual shell READY gap restores current scope and accepts actions after load", async () => {
  const { hostEnv, frameEnv, load } = shellPair(), advisor = ready(hostEnv);
  advisor.setDraft("account-a", "friend-a", "advisor", "A草稿");
  advisor.initFrameHandshake();
  advisor.setCachedThread("account-a", "friend-b", "advisor", thread("account-a", "friend-b", "advisor",
    [{ id: "b-message", role: "assistant", text: "B结果" }]));
  advisor.setDraft("account-a", "friend-b", "advisor", "B草稿");
  advisor.fetchJson = async () => ({ thread: advisor.getCachedThread("account-a", "friend-b", "advisor"), run: null });
  advisor.onSessionChanged("account-a", "friend-b");
  await new Promise(resolve => setImmediate(resolve));
  await load();
  assert.equal(advisor.frameReady, true);
  assert.equal(frameEnv.elements.get("advisorInput").value, "B草稿");
  assert.ok(frameEnv.elements.get("advisorTimeline").children.some(child => child.dataset.msgId === "b-message"));
  let accepted;
  advisor.startRun = message => { accepted = { message, scope: json(advisor.captureScope()) }; };
  await frameEnv.elements.get("btnAdvisorSend").dispatch("click");
  assert.equal(accepted.message, "B草稿"); assert.equal(accepted.scope.user, "friend-b");
  assert.equal(hostEnv.messages.filter(message => message.type === "ADVISOR_INIT").length, 1);
});
test("running handshake retains stop and disable send, including after cached-load failure", async () => {
  const { hostEnv, frameEnv, load } = shellPair(), advisor = ready(hostEnv);
  const partial = thread("account-a", "friend-a", "advisor", [{ id: "partial", role: "assistant", text: "已生成的内容" }]);
  const run = { id: "running-run", threadId: partial.id, state: "running" };
  advisor.setCachedThread("account-a", "friend-a", "advisor", partial);
  advisor.currentRunId = run.id; advisor.syncThreadToFrame(partial, run);
  advisor.fetchJson = async () => ({ error: "暂时断网" });
  await advisor.loadThread(); advisor.initFrameHandshake(); await load();
  const init = hostEnv.messages.find(message => message.type === "ADVISOR_INIT");
  assert.equal(init.payload.run.id, run.id);
  assert.equal(frameEnv.elements.get("btnStopRun").hidden, false);
  assert.equal(frameEnv.elements.get("btnAdvisorSend").disabled, true);
  assert.equal(frameEnv.elements.get("btnAdvisorSend").hidden, true);
  assert.ok(frameEnv.elements.get("advisorTimeline").children.some(child => child.dataset.msgId === "partial"));
  let stopped = false; advisor.stopRun = () => { stopped = true; };
  await frameEnv.elements.get("btnStopRun").dispatch("click"); assert.equal(stopped, true);
});
test("FRAME_READY resynchronizes actual submit, stop and error states without INIT loop", async () => {
  const { hostEnv, frameEnv, load } = shellPair(), advisor = ready(hostEnv);
  const run = { id: "running-run", threadId: thread().id, state: "running" };
  advisor.syncThreadToFrame(thread(), run); advisor.initFrameHandshake();
  advisor.submitPending = true; advisor.stopPending = true;
  advisor.problem({ error: "真实停止错误" }, advisor.captureScope(), "poll");
  await load();
  assert.equal(frameEnv.elements.get("btnStopRun").disabled, true);
  assert.equal(frameEnv.elements.get("btnStopRun").attributes["aria-label"], "正在停止");
  assert.equal(frameEnv.elements.get("btnAdvisorSend").disabled, true);
  assert.ok(frameEnv.elements.get("advisorTimeline").children.some(child => child.children[0]?.textContent === "真实停止错误"));
  assert.equal(hostEnv.messages.filter(message => message.type === "ADVISOR_INIT").length, 1);
  assert.ok(hostEnv.messages.some(message => message.type === "ADVISOR_SUBMIT_STATE" && message.payload.pending));
});
test("shell loading queue is bounded to latest state of the newest generation", async () => {
  const env = environment(["advisorFrame"]), sent = []; let receiver;
  env.window.advisorWindow = { receive: callback => { receiver = callback; }, send() {} };
  const iframe = env.elements.get("advisorFrame"); iframe.contentWindow = { postMessage: data => sent.push(json(data)) };
  vm.runInContext(shellSource, env.context);
  const init = { envelope: "advisor", nonce: "adv_" + "b".repeat(32), type: "ADVISOR_INIT",
    scope: { account: "synthetic", user: "A", agentId: "advisor", generation: 0 }, payload: { theme: "dark" } };
  receiver(init);
  for (let index = 0; index < 1000; index++) receiver({ ...init, type: "ADVISOR_SET_THREAD",
    scope: { ...init.scope, user: "B", generation: 1 }, payload: { index } });
  receiver({ ...init, type: "ADVISOR_PROBLEM", payload: { error: "A迟到错误" } });
  receiver({ ...init, type: "ADVISOR_PROBLEM", scope: { ...init.scope, user: "B", generation: 1 }, payload: { error: "B错误" } });
  await iframe.dispatch("load");
  assert.equal(sent.length, 3);
  assert.equal(sent[1].payload.index, 999);
  assert.equal(sent[2].payload.error, "B错误");
});
test("native geometry refusal displays its actual error and never marks companion as visible", async () => {
  const env = host(); let reason;
  env.context.alert = value => { reason = value; };
  env.window.desktopHost.toggleAdvisor = async () => ({ visible: false, error: "屏幕可用宽度不足" });
  assert.equal(await env.advisor.togglePanel(), false);
  assert.equal(env.advisor.panelVisible, false);
  assert.equal(reason, "屏幕可用宽度不足");
});
test("successful catalog and thread recovery clears only its corresponding stored error", async () => {
  const env = host(), advisor = ready(env);
  advisor.problem({ error: "旧目录错误" }, advisor.captureScope(), "catalog");
  advisor.fetchJson = async url => url === "/api/advisor/catalog" ? catalog() : { thread: thread(), run: null };
  await advisor.loadCatalog(); assert.equal(advisor.lastProblem, null);
  advisor.problem({ error: "旧会话错误" }, advisor.captureScope(), "load");
  await advisor.loadThread(); assert.equal(advisor.lastProblem, null);
  advisor.problem({ error: "未恢复的发送错误" }, advisor.captureScope(), "send");
  await advisor.loadThread(); assert.equal(advisor.lastProblem.payload.error, "未恢复的发送错误");
});
test("successful polling recovery does not replay resolved error on next FRAME_READY", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake(); advisor.problem({ error: "旧轮询错误" }, advisor.captureScope(), "poll");
  advisor.fetchJson = async () => ({ events: [], run: { id: "poll-run", threadId: thread().id, state: "done" }, thread: thread() });
  await advisor.pollEvents("poll-run");
  assert.equal(advisor.lastProblem, null);
  hostEnv.messages.length = 0;
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_FRAME_READY", {}).data);
  assert.ok(!hostEnv.messages.some(message => message.type === "ADVISOR_PROBLEM" && message.payload.error));
  assert.ok(!frameEnv.elements.get("advisorTimeline").children.some(child => child.children[0]?.textContent === "旧轮询错误"));
});
test("failed cache recovery retains actual error until successful reset clears it", async () => {
  const env = host(), advisor = ready(env);
  advisor.problem({ error: "真实读取错误" }, advisor.captureScope(), "load");
  advisor.fetchJson = async () => ({ error: "真实读取错误" }); await advisor.loadThread();
  assert.equal(advisor.lastProblem.payload.error, "真实读取错误");
  advisor.fetchJson = async () => ({ thread: { ...thread(), id: "fresh" }, run: null });
  await advisor.startRun("/reset"); assert.equal(advisor.lastProblem, null);
});
test("new submission clears send error but preserves unrelated failure", async () => {
  const env = host(), advisor = ready(env), pending = deferred();
  advisor.problem({ error: "旧发送失败" }, advisor.captureScope(), "send");
  advisor.fetchJson = () => pending.promise;
  const started = advisor.startRun("再次发送"); assert.equal(advisor.lastProblem, null);
  pending.resolve({ error: "新发送失败" }); await started;
  assert.equal(advisor.lastProblem.payload.error, "新发送失败");
  advisor.problem({ error: "未恢复的目录错误" }, advisor.captureScope(), "catalog");
  const second = deferred(); advisor.fetchJson = () => second.promise;
  const unrelated = advisor.startRun("另一个问题");
  assert.equal(advisor.lastProblem.payload.error, "未恢复的目录错误");
  second.resolve({ error: "新问题失败" }); await unrelated;
});
test("delayed backend submit immediately shows one pending user message and clears input", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv), response = deferred();
  const exact = "  用户原始内容  \n";
  advisor.fetchJson = url => url === "/api/advisor/run" ? response.promise : Promise.resolve({ error: "离线" });
  advisor.initFrameHandshake(); const input = frameEnv.elements.get("advisorInput");
  input.value = exact; await input.dispatch("input"); await frameEnv.elements.get("btnAdvisorSend").dispatch("click");
  const timeline = frameEnv.elements.get("advisorTimeline");
  const users = timeline.children.filter(child => child.className === "advisor-msg user");
  assert.equal(users.length, 1); assert.equal(users[0].children[0].textContent, exact);
  assert.equal(users[0].dataset.delivery, "pending"); assert.equal(input.value, "");
  assert.equal(advisor.currentRunId, null);
  assert.ok(timeline.children.at(-1).classList.contains("advisor-current-status"));
  response.resolve({ error: "真实发送失败" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, exact); assert.equal(users[0].dataset.delivery, "failed");
  assert.equal(timeline.children.filter(child => child.className === "advisor-msg user").length, 1);
  const requestId = advisor.pendingRequests[advisor.scopeKey("account-a", "friend-a", "advisor")].requestId;
  advisor.fetchJson = async () => ({ error: "再次失败" }); await advisor.retryRun();
  assert.equal(advisor.pendingRequests[advisor.scopeKey("account-a", "friend-a", "advisor")].requestId, requestId);
  assert.equal(timeline.children.filter(child => child.className === "advisor-msg user").length, 1);
});
test("accepted submit reconciles pending with backend messageId without duplicate user text", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv), response = deferred(); let runPayload;
  const exact = "测试提交";
  advisor.fetchJson = async (url, options) => {
    if (url === "/api/advisor/run") { runPayload = JSON.parse(options.body); return response.promise; }
    return { events: [], run: { id: "accepted", threadId: thread().id, messageId: "server-user", state: "done" },
      thread: thread("account-a", "friend-a", "advisor", [{ id: "server-user", role: "user", text: exact }]) };
  };
  advisor.initFrameHandshake(); const input = frameEnv.elements.get("advisorInput"); input.value = exact;
  await input.dispatch("input"); await frameEnv.elements.get("btnAdvisorSend").dispatch("click");
  response.resolve({ run: { id: "accepted", threadId: thread().id, messageId: "server-user", state: "running", phase: "preparing" } });
  await new Promise(resolve => setImmediate(resolve));
  const users = frameEnv.elements.get("advisorTimeline").children.filter(child => child.className === "advisor-msg user");
  assert.equal(users.length, 1); assert.equal(users[0].dataset.msgId, "server-user"); assert.equal(users[0].dataset.delivery, "");
  assert.ok(runPayload.requestId.startsWith("req_"));
  assert.equal(Object.keys(advisor.pendingRequests).length, 0);
});
test("stream updates only changing assistant, keeps static DOM and has one current state after messages", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv), paints = [];
  frameEnv.window.AdvisorTimeline = { renderInto: (container, value, live) => { paints.push({ value, live }); container.textContent = value; },
    statusInto: (container, event) => { container.textContent = event.text || event.state; }, disposeInto() {} };
  const old = { id: "old-answer", role: "assistant", text: "以前的答案" }, user = { id: "new-user", role: "user", text: "新问题" };
  const run = { id: "live", threadId: thread().id, state: "running", phase: "preparing" };
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor", [old, user]));
  advisor.syncThreadToFrame(advisor.getCachedThread("account-a", "friend-a", "advisor"), run); advisor.initFrameHandshake();
  const timeline = frameEnv.elements.get("advisorTimeline"), menu = frameEnv.elements.get("agentMenu");
  const oldNode = timeline.children.find(child => child.dataset.msgId === "old-answer"), menuNode = menu.children[0];
  const oldPaints = paints.filter(value => value.value === old.text).length;
  for (let i = 0; i < 25; i++) advisor.postToFrame("ADVISOR_STREAM_UPDATE", { threadId: thread().id,
    run: { ...run, phaseEvent: { state: i === 0 ? "thinking" : "answering" } },
    messages: [{ id: "live:assistant", runId: "live", role: "assistant", text: "x".repeat(i + 1) }] });
  assert.equal(timeline.children.filter(child => child.classList.contains("advisor-current-status")).length, 1);
  assert.equal(timeline.children.at(-1).dataset.msgId, "ui:run");
  assert.equal(timeline.children.find(child => child.dataset.msgId === "old-answer"), oldNode);
  assert.equal(menu.children[0], menuNode); assert.equal(paints.filter(value => value.value === old.text).length, oldPaints);
  const stableMoves = timeline.moves;
  advisor.postToFrame("ADVISOR_STREAM_UPDATE", { threadId: thread().id, run: { ...run, phaseEvent: { state: "answering" } },
    messages: [{ id: "live:assistant", runId: "live", role: "assistant", text: "x".repeat(26) }] });
  assert.equal(timeline.moves, stableMoves);
});
test("duplicate busy events are transient while reasoning creates only evidenced thinking indicator", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const run = { id: "native-run", threadId: thread().id, state: "running", phase: "preparing" };
  advisor.syncThreadToFrame(thread(), run); advisor.initFrameHandshake();
  let step = 0;
  advisor.fetchJson = async () => step++ === 0 ? { events: [
    { seq: 1, type: "status", state: "answering" }, { seq: 2, type: "status", state: "answering" },
    { seq: 3, type: "reasoning", text: "真实公开推理片段" }], run } :
    { events: [{ seq: 4, type: "done" }], run: { ...run, state: "done" }, thread: thread() };
  const polling = advisor.pollEvents(run.id); await new Promise(resolve => setImmediate(resolve));
  const state = frameEnv.elements.get("advisorTimeline").children.find(child => child.dataset.msgId === "ui:run");
  assert.equal(state.children[0].dataset.stateKey, JSON.stringify({ state: "thinking" }));
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages.filter(message => message.role === "status").length, 0);
  await hostEnv.flushTimers(); await polling;
  assert.ok(!frameEnv.elements.get("advisorTimeline").children.some(child => child.dataset.msgId === "ui:run"));
});
test("a saved terminal error is shown once and past errors remain in history", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  const problem = "合成模型错误";
  const history = thread("account-a", "friend-a", "advisor", [
    { id: "old-error", role: "status", status: "error", text: "生成失败：" + problem },
    { id: "current-user", role: "user", text: "新问题" },
    { id: "current-error", role: "status", status: "error", text: "生成失败：" + problem }
  ]);
  const run = { id: "failed-run", threadId: history.id, state: "error", error: problem };
  advisor.setCachedThread("account-a", "friend-a", "advisor", history);
  advisor.syncThreadToFrame(history, run); advisor.initFrameHandshake();
  const timeline = frameEnv.elements.get("advisorTimeline");
  assert.ok(timeline.children.some(child => child.dataset.msgId === "old-error"));
  assert.ok(timeline.children.some(child => child.dataset.msgId === "current-error"));
  assert.ok(!timeline.children.some(child => child.dataset.msgId === "ui:run"));
  advisor.syncThreadToFrame({ ...history, messages: history.messages.slice(0, -1) }, run);
  assert.ok(timeline.children.some(child => child.dataset.msgId === "ui:run"));
});

test("stream uses incremental IPC and throttled cache before authoritative terminal snapshot", async () => {
  const env = host(), advisor = ready(env); const run = { id: "stream-run", threadId: thread().id, state: "running", phase: "answering" };
  advisor.syncThreadToFrame(thread(), run); env.messages.length = 0;
  let step = 0;
  advisor.fetchJson = async () => step++ === 0 ? { events: [{ seq: 1, type: "text", text: "首段" }], run } :
    { events: [{ seq: 2, type: "text", text: "尾段" }, { seq: 3, type: "done" }], run: { ...run, state: "done" },
      thread: thread("account-a", "friend-a", "advisor", [{ id: "real-final", role: "assistant", text: "首段尾段" }]) };
  const polling = advisor.pollEvents(run.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.messages.filter(message => message.type === "ADVISOR_STREAM_UPDATE").length, 1);
  assert.equal(env.messages.filter(message => message.type === "ADVISOR_SET_THREAD").length, 0);
  assert.equal(env.storageWrites.get("advisor_threads_v1") || 0, 0);
  await env.flushTimers(); await polling;
  assert.equal(env.messages.filter(message => message.type === "ADVISOR_SET_THREAD").length, 1);
  assert.ok((env.storageWrites.get("advisor_threads_v1") || 0) <= 2);
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages[0].text, "首段尾段");
});
test("legacy persisted busy and reasoning rows do not become duplicated conversation messages", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor", [
    { id: "u", role: "user", text: "问题" }, { id: "old:1", role: "status", text: "正在回答", event: { type: "status", state: "answering" } },
    { id: "old:2", role: "status", text: "正在生成" }, { id: "old:3", role: "status", status: "reasoning", text: "旧推理" },
    { id: "a", role: "assistant", text: "回答" }]));
  advisor.initFrameHandshake(); const timeline = frameEnv.elements.get("advisorTimeline");
  assert.deepEqual(timeline.children.map(child => child.dataset.msgId), ["u", "a"]);
});
test("loading shell combines latest cumulative stream parts without dropping first content", async () => {
  const env = environment(["advisorFrame"]), sent = []; let receiver;
  env.window.advisorWindow = { receive: callback => { receiver = callback; }, send() {} };
  const iframe = env.elements.get("advisorFrame"); iframe.contentWindow = { postMessage: data => sent.push(json(data)) };
  vm.runInContext(shellSource, env.context);
  const init = { envelope: "advisor", nonce: "adv_" + "a".repeat(32), type: "ADVISOR_INIT",
    scope: { account: "synthetic", user: "A", agentId: "advisor", generation: 1 }, payload: { theme: "dark" } };
  receiver(init);
  const envelope = { ...init, type: "ADVISOR_STREAM_UPDATE", payload: { threadId: "thread", run: { id: "run", state: "running" },
    messages: [{ id: "answer", role: "assistant", text: "前缀" }] } };
  receiver(envelope); receiver({ ...envelope, payload: { ...envelope.payload,
    messages: [{ id: "answer", role: "assistant", text: "前缀和后缀" }, { id: "another", role: "assistant", text: "第二部分" }] } });
  await iframe.dispatch("load");
  assert.equal(sent.length, 2); assert.equal(sent[1].payload.messages.length, 2);
  assert.equal(sent[1].payload.messages[0].text, "前缀和后缀");
});

test("late real acknowledgement settles only its old pending conversation", async () => {
  const env = host(), advisor = ready(env), response = deferred(), stopped = [];
  advisor.fetchJson = url => url === "/api/advisor/run" ? response.promise : Promise.resolve({});
  advisor.stopForScope = (scope, runId) => { stopped.push({ scope, runId }); };
  const started = advisor.startRun("原会话的问题");
  advisor.setDraft("account-a", "friend-a", "advisor", "另外的草稿");
  advisor.generation++; advisor.currentAccount = "account-b"; advisor.currentUser = "friend-b";
  advisor.submitPending = false; advisor.currentRunId = "new-run";
  response.resolve({ run: { id: "old-run", threadId: thread().id, messageId: "actual-user", state: "running" } });
  await started;
  assert.equal(advisor.currentRunId, "new-run");
  assert.equal(advisor.pendingRequests[advisor.scopeKey("account-a", "friend-a", "advisor")], undefined);
  assert.equal(advisor.getDraft("account-a", "friend-a", "advisor"), "另外的草稿");
  assert.equal(advisor.getCachedThread("account-a", "friend-a", "advisor").messages[0].id, "actual-user");
  assert.equal(advisor.getCachedThread("account-b", "friend-b", "advisor").messages.length, 0);
  assert.equal(stopped[0].scope.account, "account-a");
});

test("recovered matching request uses the actual saved user message without a duplicate pending bubble", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv), key = advisor.scopeKey("account-a", "friend-a", "advisor");
  advisor.pendingRequests[key] = { account: "account-a", user: "friend-a", agentId: "advisor", threadId: thread().id,
    requestId: "req_" + "a".repeat(32), message: "已收到的问题", delivery: "pending" };
  const recovered = thread("account-a", "friend-a", "advisor", [{ id: "actual-user", role: "user", text: "已收到的问题" }]);
  advisor.fetchJson = async () => ({ thread: recovered, run: { id: "done-run", threadId: recovered.id, state: "done",
    requestId: advisor.pendingRequests[key].requestId, messageId: "actual-user" } });
  advisor.initFrameHandshake(); await advisor.loadThread();
  assert.equal(advisor.pendingRequests[key], undefined);
  const users = frameEnv.elements.get("advisorTimeline").children.filter(child => child.className === "advisor-msg user");
  assert.equal(users.length, 1); assert.equal(users[0].dataset.msgId, "actual-user");
});

test("portrait navigation preserves the assistant panel, scope and active generation", () => {
  const env = host(), advisor = ready(env), stopped = [], hidden = [];
  advisor.panelVisible = true; advisor.currentRunId = "same-run";
  advisor.stopForScope = (...args) => stopped.push(args);
  advisor.togglePanel = value => hidden.push(value);
  const scope = json(advisor.captureScope());
  advisor.onViewChanged("persona"); advisor.onViewChanged("chat");
  assert.equal(advisor.panelVisible, true); assert.equal(advisor.currentRunId, "same-run");
  assert.deepEqual(json(advisor.captureScope()), scope);
  assert.equal(stopped.length, 0); assert.equal(hidden.length, 0);
});

test("assistant responses have no copy command and navigation labels are distinct from template names", () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.setCachedThread("account-a", "friend-a", "advisor", thread("account-a", "friend-a", "advisor",
    [{ id: "answer", role: "assistant", text: "建议内容" }]));
  advisor.initFrameHandshake();
  const message = frameEnv.elements.get("advisorTimeline").children.find(item => item.dataset.msgId === "answer");
  assert.equal(message.children.length, 1);
  assert.ok(!frameSource.includes("advisor-copy-btn"));
  assert.match(indexHtml, /id="btnToolbarAdvisor"[^>]*>聊天助手<\/button>/);
  assert.match(indexHtml, /title="助手仓库"[^>]*id="navAdvisor"/);
  assert.ok(indexHtml.includes('class="advisor-nav-icon"'));
});

function descendants(element, predicate) {
  return [element, ...element.children.flatMap(child => descendants(child, () => true))].filter(predicate);
}
test("duplicate skill import is inline and the same modal can retry with a new name", async () => {
  const env = host(), advisor = ready(env);
  let attempts = 0;
  advisor.fetchJson = async () => ++attempts === 1 ? { error: "技能名称已存在", status: 400 } : {
    ...catalog(), skills: [{ id: "skill:new", name: "新名称" }] };
  advisor.showImportSkillModal();
  const modal = env.context.document.body.children.at(-1);
  const fields = descendants(modal, item => item.tag === "input" || item.tag === "textarea");
  fields[0].value = "重复名称"; fields[2].value = "合成技能内容";
  const submit = descendants(modal, item => item.tag === "button" && item.textContent === "导入")[0];
  await submit.dispatch("click");
  assert.equal(submit.disabled, false); assert.equal(advisor.catalogReady, true);
  assert.equal(fields[2].value, "合成技能内容"); assert(modal.parentNode);
  const error = descendants(modal, item => item.className === "advisor-modal-error")[0];
  assert.equal(error.hidden, false); assert.equal(error.textContent, "技能名称已存在");
  fields[0].value = "新名称"; await submit.dispatch("click");
  assert.equal(attempts, 2); assert.equal(modal.parentNode, null);
  assert.equal(advisor.catalog.skills[0].name, "新名称");
});

test("skills keep five-row bands and removal changes only the unsaved current assistant", async () => {
  const env = host(), advisor = ready(env);
  advisor.catalog.skills = Array.from({ length: 12 }, (_, index) => ({ id: `skill:${index}`, name: `技能${index}` }));
  advisor.catalog.agents[0].skillIds = ["skill:2"];
  advisor.showEditAgentModal(advisor.catalog.agents[0]);
  const modal = env.context.document.body.children.at(-1);
  assert.equal(modal.children[0].children[0].textContent, "编辑助手");
  const list = descendants(modal, item => item.className === "advisor-skill-list")[0];
  assert.equal(list.children[4].style.gridColumn, "1"); assert.equal(list.children[4].style.gridRow, "5");
  assert.equal(list.children[5].style.gridColumn, "2"); assert.equal(list.children[5].style.gridRow, "1");
  assert.equal(list.children[10].style.gridColumn, "1"); assert.equal(list.children[10].style.gridRow, "6");
  const toggle = descendants(modal, item => item.textContent === "移除技能")[0];
  assert.equal(descendants(list, item => item.className === "advisor-skill-remove").length, 0);
  await toggle.dispatch("click");
  assert.equal(descendants(list, item => item.className === "advisor-skill-remove").length, 12);
  let writes = 0; advisor.fetchJson = async () => { writes++; return {}; };
  await descendants(list, item => item.className === "advisor-skill-remove")[2].dispatch("click");
  assert.equal(list.children.length, 12); assert.deepEqual(advisor.catalog.agents[0].skillIds, ["skill:2"]);
  assert.equal(writes, 0);
  await toggle.dispatch("click");
  assert.equal(descendants(list, item => item.className === "advisor-skill-remove").length, 0);
});

test("new assistant imports preview metadata then creates atomically from its only repository entry", async () => {
  const env = host(), advisor = ready(env), calls = [];
  advisor.renderRepository();
  assert.equal(descendants(env.elements.get("advisorRepoContainer"), item => item.textContent === "导入技能").length, 0);
  advisor.fetchJson = async (url, options) => {
    if (!options) return { thread: thread("account-a", "friend-a", "imported") };
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith("/preview")) return { preview: { id: "imp_" + "a".repeat(32), name: "导入助手", description: "说明",
      defaultPrompt: "合成提示词", welcome: "你好", resourceCount: 3, sourceLabel: "synthetic", compatibility: { state: "readonly", warnings: [] } } };
    if (url.endsWith("/cancel")) return { cancelled: true };
    return { ...catalog(), agents: [{ ...catalog().agents[0], id: "imported", name: "导入助手" }], importedAgentId: "imported" };
  };
  await descendants(env.elements.get("advisorRepoContainer"), item => item.tag === "button" && item.textContent === "新建助手")[0].dispatch("click");
  const modal = env.context.document.body.children.at(-1);
  assert.equal(descendants(modal, item => item.tag === "button" && ["自定义", "导入"].includes(item.textContent)).length, 0);
  assert.equal(descendants(modal, item => item.className === "advisor-create-modes").length, 0);
  descendants(modal, item => item.tag === "input")[0].value = "https://github.com/synthetic/package";
  await descendants(modal, item => item.tag === "button" && item.textContent === "读取")[0].dispatch("click");
  const fields = descendants(modal, item => item.tag === "input" && item.type !== "checkbox");
  assert.equal(fields[1].value, "导入助手");
  const create = descendants(modal, item => item.tag === "button" && item.textContent === "导入并创建")[0];
  assert.equal(create.disabled, false); await create.dispatch("click");
  assert.equal(calls[1].url, "/api/advisor/import/commit");
  assert.equal(calls[1].body.agent.prompt, "合成提示词");
  assert.match(calls[1].body.requestId, /^req_[a-f0-9]{32}$/);
  assert.equal(modal.parentNode, null); assert.equal(advisor.catalog.agents[0].id, "imported");
});

test("cancel during preview cancels its late result without creating any assistant", async () => {
  const env = host(), advisor = ready(env), loading = deferred(), calls = [];
  advisor.fetchJson = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/preview")) return loading.promise;
    return { cancelled: true };
  };
  advisor.showImportAssistantModal();
  const modal = env.context.document.body.children.at(-1);
  const reading = descendants(modal, item => item.tag === "button" && item.textContent === "读取")[0].dispatch("click");
  const cancel = descendants(modal, item => item.tag === "button" && item.textContent === "取消")[0];
  assert.equal(cancel.disabled, false); await cancel.dispatch("click");
  loading.resolve({ preview: { id: "imp_" + "b".repeat(32) } }); await reading;
  assert.equal(calls[1].url, "/api/advisor/import/cancel");
  assert.equal(calls.length, 2); assert.equal(modal.parentNode, null);
});

test("one import command can preview and create a compatible GitHub package", async () => {
  const env = host(), advisor = ready(env), calls = [];
  advisor.fetchJson = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/preview")) return { preview: { id: "imp_" + "c".repeat(32), name: "单击助手", description: "",
      defaultPrompt: "使用已提供资料", welcome: "你好", resourceCount: 1, compatibility: { state: "readonly", warnings: [] } } };
    if (url.endsWith("/cancel")) return { cancelled: true };
    return { ...catalog(), importedAgentId: "advisor" };
  };
  advisor.showImportAssistantModal();
  const modal = env.context.document.body.children.at(-1), url = descendants(modal, item => item.tag === "input")[0];
  url.value = "https://github.com/synthetic/compatible"; await url.dispatch("input");
  const create = descendants(modal, item => item.tag === "button" && item.textContent === "导入并创建")[0];
  assert.equal(create.disabled, false); await create.dispatch("click");
  assert.deepEqual(calls.slice(0, 2), ["/api/advisor/import/preview", "/api/advisor/import/commit"]);
  assert.equal(modal.parentNode, null);
});

test("every assistant card can be deleted and repository omits engine and preset badges", async () => {
  const env = host(), advisor = ready(env);
  advisor.catalog.agents[0].builtin = true;
  advisor.renderRepository();
  const container = env.elements.get("advisorRepoContainer");
  assert.equal(descendants(container, item => item.className.includes("advisor-engine-badge")).length, 0);
  assert.equal(descendants(container, item => item.className === "advisor-pill").length, 0);
  const remove = descendants(container, item => item.tag === "button" && item.textContent === "删除");
  assert.equal(remove.length, advisor.catalog.agents.length);
  advisor.fetchJson = async (_url, options) => {
    const data = JSON.parse(options.body); assert.deepEqual(data, { action: "delete", id: "advisor" });
    return { ...catalog(), agents: [] };
  };
  await advisor.deleteTemplate("advisor");
  assert.equal(advisor.catalog.agents.length, 0); assert.equal(advisor.activeAgentId, "");
  assert.equal(descendants(container, item => item.className === "advisor-repo-empty").length, 1);
});

test("reply context uses only the selected enabled assistant and reports catalog readiness", () => {
  const env = host(), advisor = env.advisor;
  advisor.activeAgentId = "advisor";
  advisor.catalog = catalog();
  assert.deepEqual(json(advisor.getReplyContext()), { ready: false, agentId: "", agentRevision: 0 });
  ready(env);
  assert.deepEqual(json(advisor.getReplyContext()), { ready: true, agentId: "advisor", agentRevision: 1 });
  advisor.catalog.agents[0].enabled = false;
  assert.deepEqual(json(advisor.getReplyContext()), { ready: true, agentId: "", agentRevision: 0 });
});

test("native assistant switches notify reply choices once and include the selected revision", () => {
  const env = host(), advisor = ready(env), changes = [];
  advisor.catalog.agents.push({ ...catalog().agents[0], id: "second", revision: 7 });
  advisor.loadThread = async () => {};
  env.window.addEventListener("advisor-selection-changed", event => changes.push(json(event.detail)));
  advisor.syncTemplatesToFrame();
  env.nativeEmit(request(env, "ADVISOR_SWITCH_TEMPLATE", { agentId: "second" }).data);
  env.nativeEmit(request(env, "ADVISOR_SWITCH_TEMPLATE", { agentId: "second" }).data);
  assert.deepEqual(changes, [
    { ready: true, agentId: "advisor", agentRevision: 1 },
    { ready: true, agentId: "second", agentRevision: 7 },
  ]);
});

test("catalog edits, disabled fallbacks and deletion invalidate the reply context without extra model calls", async () => {
  const env = host(), advisor = ready(env), changes = [], calls = [];
  advisor.loadThread = async () => {};
  env.window.addEventListener("advisor-selection-changed", event => changes.push(json(event.detail)));
  advisor.syncTemplatesToFrame();
  const changed = catalog(); changed.agents[0].revision = 2;
  advisor.fetchJson = async url => { calls.push(url); return changed; };
  await advisor.saveTemplate({ id: "advisor", name: "助手", prompt: "新的提示词", skillIds: [] });
  const second = { ...changed.agents[0], id: "second", revision: 4 };
  advisor.fetchJson = async url => { calls.push(url); return { ...catalog(), agents: [{ ...changed.agents[0], enabled: false }, second] }; };
  await advisor.enableTemplate("advisor", false);
  advisor.fetchJson = async url => { calls.push(url); return { ...catalog(), agents: [] }; };
  await advisor.deleteTemplate("second");
  assert.deepEqual(changes, [
    { ready: true, agentId: "advisor", agentRevision: 1 },
    { ready: true, agentId: "advisor", agentRevision: 2 },
    { ready: true, agentId: "second", agentRevision: 4 },
    { ready: true, agentId: "", agentRevision: 0 },
  ]);
  assert.deepEqual(calls, ["/api/advisor/templates", "/api/advisor/templates", "/api/advisor/templates"]);
});

test("history menu asks the host for the list and renders each conversation", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  const button = frameEnv.elements.get("btnHistory"), menu = frameEnv.elements.get("historyMenu");
  // The real markup ships the menu hidden; the stub starts every node visible.
  menu.hidden = true;
  await button.dispatch("click");
  assert.equal(menu.hidden, false);
  assert.equal(button.attributes["aria-expanded"], "true");
  assert.equal(sent.filter(message => message.type === "ADVISOR_HISTORY_REQUEST").length, 1);

  advisor.postToFrame("ADVISOR_SET_THREADS", {
    threads: [
      { id: "t-now", title: "今天的对话", preview: "好的，我明白了", previewRole: "assistant",
        messageCount: 4, createdAtMs: Date.now() - 1000, updatedAtMs: Date.now() - 500 },
      { id: "t-old", title: "上周的对话", preview: "明天见", previewRole: "user",
        messageCount: 2, createdAtMs: Date.now() - 86400000, updatedAtMs: Date.now() - 86400000 },
    ],
    activeThreadId: "t-now",
  });
  assert.equal(button.title, "历史会话（2 段）");
  const rows = menu.children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.threadId, "t-now");
  assert.ok(rows[0].classList.contains("is-active"));
  assert.equal(rows[0].attributes["aria-current"], "true");
  assert.equal(rows[0].children[0].textContent, "今天的对话");
  assert.match(rows[0].children[1].textContent, /条消息/);
  assert.equal(rows[0].children[2].textContent, "助手：好的，我明白了");
  assert.equal(rows[1].children[2].textContent, "明天见");
  assert.equal(rows[1].attributes["aria-current"], undefined);
});

test("clicking an older conversation asks the host to open it; the current one stays put", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.postToFrame("ADVISOR_SET_THREADS", {
    threads: [
      { id: "t-now", title: "当前", preview: "", previewRole: "", messageCount: 1,
        createdAtMs: 1, updatedAtMs: 2 },
      { id: "t-old", title: "更早", preview: "", previewRole: "", messageCount: 1,
        createdAtMs: 1, updatedAtMs: 1 },
    ],
    activeThreadId: "t-now",
  });
  const menu = frameEnv.elements.get("historyMenu");
  await menu.children[0].dispatch("click");
  assert.equal(sent.filter(message => message.type === "ADVISOR_OPEN_THREAD").length, 0,
    "the conversation already open must not be requested again");
  await menu.children[1].dispatch("click");
  const opened = sent.filter(message => message.type === "ADVISOR_OPEN_THREAD");
  assert.equal(opened.length, 1);
  assert.deepEqual(json(opened[0].payload), { threadId: "t-old" });
  assert.equal(menu.hidden, true);
});

test("a malformed thread list is ignored instead of blanking the menu", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  advisor.postToFrame("ADVISOR_SET_THREADS", {
    threads: [{ id: "t-now", title: "保留", preview: "", previewRole: "", messageCount: 1,
      createdAtMs: 1, updatedAtMs: 2 }],
    activeThreadId: "t-now",
  });
  const button = frameEnv.elements.get("btnHistory"), menu = frameEnv.elements.get("historyMenu");
  assert.equal(button.title, "历史会话（1 段）");
  for (const bad of [{ threads: "nope" }, { threads: [{}] }, { threads: [{ id: "x" , title: "t" }] }]) {
    advisor.postToFrame("ADVISOR_SET_THREADS", { ...bad, activeThreadId: "t-now" });
    assert.equal(menu.children.length, 1);
  }
});

test("opening a conversation reloads it by id and then refreshes the list", async () => {
  const { hostEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const calls = [];
  advisor.fetchJson = async (url, options) => {
    calls.push(String(url));
    if (String(url).startsWith("/api/advisor/threads")) return { threads: [] };
    return { thread: thread(), run: null, draft: "" };
  };
  const generation = advisor.generation;
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_OPEN_THREAD", { threadId: "t-old" }).data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(calls[0], /^\/api\/advisor\/thread\?/);
  assert.match(calls[0], /threadId=t-old/);
  assert.equal(calls[1].startsWith("/api/advisor/threads"), true);
  assert.ok(advisor.generation > generation, "switching conversations must stop the old run");
});

test("a failed history load clears the rows and offers a retry", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.postToFrame("ADVISOR_SET_THREADS", {
    threads: [{ id: "t-now", title: "旧对话", preview: "", previewRole: "", messageCount: 1,
      createdAtMs: 1, updatedAtMs: 2 }],
    activeThreadId: "t-now",
  });
  const menu = frameEnv.elements.get("historyMenu");
  assert.equal(menu.children.length, 1);

  advisor.postToFrame("ADVISOR_SET_THREADS", { threads: [], activeThreadId: "t-now",
    error: "历史读取失败，点此重试" });
  assert.equal(menu.children.length, 1, "stale rows must not survive a failed refresh");
  assert.equal(menu.children[0].textContent, "历史读取失败，点此重试");
  assert.match(menu.children[0].className, /advisor-history-retry/);

  const before = sent.filter(message => message.type === "ADVISOR_HISTORY_REQUEST").length;
  await menu.children[0].dispatch("click");
  assert.equal(sent.filter(message => message.type === "ADVISOR_HISTORY_REQUEST").length, before + 1);
});

test("the host turns a transport failure into the retry state, not a lone banner", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  advisor.fetchJson = async () => { throw new Error("offline"); };
  await advisor.loadThreads();
  await new Promise(resolve => setImmediate(resolve));
  const menu = frameEnv.elements.get("historyMenu");
  assert.equal(menu.children.length, 1);
  assert.match(menu.children[0].textContent, /^历史读取失败/);
  assert.match(menu.children[0].textContent, /点此重试$/);
});

test("clicking the history button label keeps the menu open", () => {
  const source = readFileSync(path.join(root, "advisor-frame.js"), "utf8");
  // The click target is often the inner span/svg, so comparing it with the button node
  // closed the menu in the same click that opened it.
  assert.match(source, /if \(!historyButton\.contains\(target\) && !historyMenu\.contains\(target\)\) closeHistoryMenu\(\);/);
  assert.doesNotMatch(source, /target !== historyButton/);
});

test("deleting needs a second click and never opens the conversation", async () => {
  const { hostEnv, frameEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const sent = [];
  hostEnv.window.postMessage = data => { sent.push(json(data)); hostEnv.nativeEmit(data); };
  advisor.postToFrame("ADVISOR_SET_THREADS", {
    threads: [
      { id: "t-now", title: "当前", preview: "", previewRole: "", messageCount: 1,
        createdAtMs: 1, updatedAtMs: 2 },
      { id: "t-old", title: "更早", preview: "", previewRole: "", messageCount: 1,
        createdAtMs: 1, updatedAtMs: 1 },
    ],
    activeThreadId: "t-now",
  });
  const menu = frameEnv.elements.get("historyMenu");
  const row = menu.children[1];
  const remove = row.children[3];
  assert.equal(remove.className, "advisor-history-delete");
  assert.equal(remove.textContent, "删除");

  await remove.dispatch("click");
  assert.equal(row.dataset.confirmDelete, "1");
  assert.equal(remove.textContent, "确认删除");
  assert.equal(sent.filter(message => message.type === "ADVISOR_DELETE_THREAD").length, 0);
  assert.equal(sent.filter(message => message.type === "ADVISOR_OPEN_THREAD").length, 0,
    "arming the delete must not open the conversation");

  await remove.dispatch("click");
  const deleted = sent.filter(message => message.type === "ADVISOR_DELETE_THREAD");
  assert.equal(deleted.length, 1);
  assert.deepEqual(json(deleted[0].payload), { threadId: "t-old" });
  assert.equal(menu.hidden, true);
});

test("the host deletes through the endpoint and refreshes the list", async () => {
  const { hostEnv } = pair(), advisor = ready(hostEnv);
  advisor.initFrameHandshake();
  const calls = [];
  advisor.fetchJson = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).startsWith("/api/advisor/threads")) return { threads: [] };
    return { thread: thread(), run: null, draft: "" };
  };
  hostEnv.nativeEmit(request(hostEnv, "ADVISOR_DELETE_THREAD", { threadId: "t-old" }).data);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].url, "/api/advisor/threads/delete");
  assert.deepEqual(calls[0].body, { account: "account-a", user: "friend-a", agentId: "advisor", threadId: "t-old" });
  assert.ok(calls.some(call => call.url.startsWith("/api/advisor/threads?")));
});
