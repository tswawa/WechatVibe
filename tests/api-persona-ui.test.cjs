const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");

const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
const html = readFileSync(path.join(__dirname, "../chatui/index.html"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
const personaCode = section("function profileCacheKey(", "async function clearStoredProfilesForAccount(") +
  section("function updateProfileProgress(", "function renderMembers(") +
  section("function renderProfile(", "portraitState.apiPortraitRequest =") +
  section("portraitState.apiPortraitRequest =", "function applySettings(") +
  section("function switchSession(", '\nportraitState.activeMember = "";') +
  "globalThis.ui = { loadProfile, renderApiPortrait, renderMbti, syncPortraitMode, clearProfileView, " +
  "switchSession, switchView, apiProfileRendered: () => portraitState.renderedApiProfileScope !== null };";
const incrementalCode = section("function incrementalState(", "async function analyzeRecent(") +
  section("function usingLocalFine(", "function applyActiveModelSource(") +
  "globalThis.ui = { startIncremental, scheduleIncremental, loadAnalysis, canAnalyzeLocal };";

function node(tag = "div", className = "", textContent = "") {
  const value = {
    tag, className, textContent, hidden: false, style: {}, dataset: {}, children: [],
    listeners: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; this.textContent = ""; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    setAttribute() {},
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
  };
  Object.defineProperty(value, "childNodes", { get: () => value.children });
  return value;
}
function fire(target, type) {
  for (const handler of target.listeners?.[type] || []) handler({ type });
}
function textOf(value) {
  return [value.textContent, ...value.children.map(textOf)].join(" ");
}
function portrait(summary) {
  return {
    summary, communication: "表达直接", emotionExpression: "常表达期待",
    interactionPreferences: "偏好提前约定", topics: ["见面", "时间"],
    patterns: ["先确认日程"], boundaries: ["不喜欢临时改期"], uncertain: ["长期偏好待确认"],
    affinity: 72, mbtiAxes: { EI: 65, SN: 40, TF: 55, JP: 70 },
    traits: { socialEnergy: 60, humor: 45, composure: 70, initiative: 75, care: 65, affection: 55 },
  };
}
// The card only shows a verdict for an axis the classifier actually backed: `validAxis`
// requires a positive per-axis `evidenceCount`, and that count now comes from this basis
// instead of the old hardcoded 1.
function mbtiBasis(evidenceCount = 2) {
  return Object.fromEntries(["EI", "SN", "TF", "JP"].map(axis =>
    [axis, { status: "supported", kind: "pattern", reason: `${axis} 合成依据`, evidenceCount }]));
}
function payload(sourceId, summary, identity = { username: "friend", name: "合成联系人",
  avatar: "", avatarCandidates: [], isGroup: false, members: [] }) {
  return { account: "acct", sourceId, subject: identity.username, identity,
    portrait: portrait(summary), mbtiBasis: mbtiBasis(),
    available: { messageCount: 9, textCount: 8,
      // `mbtiEvidenceCount` is the observation ledger the MBTI gate counts
      // (`api-portrait.ts`: `evidence.targetCount < 100` withholds every axis);
      // `targetTextCount` is the analysed-text count, which only drives progress.
      targetTextCount: 5, mbtiEvidenceCount: 5, totalChars: 120 },
    inventoryReady: true, inventoryStatus: "ready",
    progress: { processed: 8, total: 8, complete: true },
    job: { id: null, status: "done" } };
}
function apiPortraitPayload(user, sourceId = "api-a") {
  return {
    account: "acct", sourceId, subject: user,
    identity: { username: user, name: user + "名", avatar: "", avatarCandidates: [], isGroup: false, members: [] },
    portrait: { summary: `${sourceId}:${user}摘要`, communication: "", emotionExpression: "",
      interactionPreferences: "", topics: [], patterns: [], boundaries: [], uncertain: [],
      affinity: 60, mbtiAxes: { EI: null, SN: null, TF: null, JP: null },
      traits: { socialEnergy: null, humor: null, composure: null, initiative: null, care: null, affection: null } },
    available: { messageCount: 9, textCount: 8, targetTextCount: 5, totalChars: 120 },
    inventoryReady: true, inventoryStatus: "ready",
    progress: { processed: 8, total: 8, complete: true },
    job: { id: null, status: "done" },
  };
}
function nativePayload(user = "friend", sourceId = "api-a") {
  const data = apiPortraitPayload(user, sourceId);
  data.available = { messageCount: 350, textCount: 300, targetTextCount: 240, totalChars: 2000 };
  data.progress = { processed: 300, total: 300, processedTargetTexts: 240, totalTargetTexts: 240, complete: true };
  data.nativeProfile = {
    account: "acct", ...data.identity,
    stats: { messageCount: 240, textCount: 240, analyzedCount: 120, participantCount: 1 },
    affinity: 38, traits: ["socialEnergy", "humor", "composure", "initiative", "care", "affection"]
      .map((key, index) => ({ key, label: key, val: 20 + index * 10, sampleCount: 120 })),
    keywords: [{ word: "散步", count: 8 }], summary: "依据累计行为信号生成的摘要", traitsBasis: "chat-behaviour",
    mbtiInference: { eligibleMessages: 120, minMessages: 100, minAxisMargin: .2,
      axes: Object.fromEntries([['EI', .2], ['SN', .75], ['TF', .25], ['JP', .3]].map(([axis, share]) =>
        [axis, { leftShare: share, rightShare: 1 - share, evidenceCount: 40, insufficientCount: 80 }])) },
    dataStatus: "partial", analysisUnit: "batch", job: { status: "done" },
  };
  return data;
}
function personaHarness(apiImpl, storage) {
  const nodes = new Map();
  const members = [];
  const avatars = [];
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const context = vm.createContext({
    ...(storage ? { localStorage: storage } : {}),
    URLSearchParams, AbortController, byId,
    document: { createElementNS: (_ns, tag) => node(tag) },
    text: (id, value) => { byId(id).textContent = String(value ?? ""); },
    element: (tag, className, textContent) => node(tag, className, textContent),
    setAvatar: (...args) => {
      avatars.push(args);
      byId(args[0]).replaceChildren(node("img"));
    },
    renderMembers: value => {
      members.push(value);
      byId("groupMemberTabs").replaceChildren(node("button"));
    },
    setStripStatus: value => { byId("stripStatusText").textContent = value; },
    modelSourceRequestError: () => "连接失败",
    svgIcon: () => node("svg"), isMbtiUnlocked: () => false, unlockMbti: () => {},
    api: apiImpl,
    profileCacheKey: (...args) => JSON.stringify(args),
    sessionCacheKey: (...args) => JSON.stringify(args),
    TextEncoder,
    rememberProfileMember() {},
    setTimeout: () => 1, clearTimeout() {},
  });
  seed(context, {
    sessions: new Map([["friend", { name: "合成联系人", isGroup: false }]]),
    currentAccount: "acct", currentUser: "friend", activeMember: "",
    view: "persona", modelSourceResolved: true,
    modelSourceSnapshot: { mode: "api", sourceId: "api-a", api: { model: "synthetic", contextTokens: 16384 } },
    controller: new AbortController(), profileGeneration: 0, profilePending: false,
    profileCache: new Map(), profileSnapshotsRequireRefresh: new Set(),
    renderedProfileKey: null, renderedProfileSignature: null, memberRenderedScope: null,
  });
  vm.runInContext(personaCode, context);
  return { ui: context.ui, context, byId, members, avatars };
}
function navigationHarness(apiImpl, storage) {
  const harness = personaHarness(apiImpl, storage);
  seed(harness.context, {
    messageSourceReady: true, sessionCache: new Map(), historyState: null,
    followLatest: true, generation: 0, analysisGeneration: 0, selectedAnalysisTimer: null,
    messagePending: false, messageRefreshQueued: false, emptyMessagePolls: 0,
    manualRecentAwaitingPost: false, manualRecentJobId: null, manualRecentDeferred: false,
    recentPending: false, incrementalFailed: false, recentFailed: false,
    analysisNetworkFailed: false, recentNetworkFailed: false,
    requestedRecentSignatures: new Set(), activeAnalysisScope: null,
    currentAnalysisJob: null, currentRecentJob: null, messages: [], results: {},
    conversationMood: null, lastChatScrollTop: 0,
  });
  Object.assign(harness.context, {
    markSessionAsRead() {}, cacheCurrentSession() {}, cancelApiInsightWork() {},
    clearInlineIntentPending() {}, cancelHistoryRequest() {}, resetHistorySearch() {},
    clearReplyPrediction() {}, setIntentActionState() {}, renderSessions() {},
    renderMessages() {}, renderPickBar() {}, syncPickControls() {},
    updateHistoryNavigation() {}, scrollToLatest() {},
    loadMessages() {}, sessionWindowReady: () => false, canAnalyzeLocal: () => false,
    usingLocalFine: () => false, visibleResults: value => value,
    status: (target, value) => { target.textContent = value; },
  });
  return harness;
}
function installApiCacheClear(harness, sourceId = "api-a") {
  Object.assign(harness.context, {
    pendingAnalysisCacheClear: { account: "acct", sourceId, kind: "api" },
    analysisCacheBusy: false, loadAnalysisCache: async () => {},
    cancelApiInsightWork() {}, renderMessages() {},
  });
  vm.runInContext(section('byId("btnConfirmAnalysisCacheClear").addEventListener(', "function closeSettingsModal("), harness.context);
}
const tick = () => new Promise(resolve => setImmediate(resolve));

it("uses the existing Laya dashboard/cards for a source-scoped API portrait without local profile", async () => {
  assert.match(html, /id="personaDashboard"/);
  assert.doesNotMatch(html, /id="apiPersonaDashboard"/);
  const calls = [];
  const { ui, byId, members, avatars } = personaHarness(async url => {
    calls.push(url);
    const data = payload("api-a", "常讨论周末见面");
    data.available.targetTextCount = 120;
    data.available.mbtiEvidenceCount = 120;
    return data;
  });
  await ui.loadProfile();
  await tick();
  assert.deepEqual(calls, ["/api/model-portrait?user=friend"]);
  assert.equal(byId("personaDashboard").hidden, false);
  assert.equal(byId("portraitSourceBadge").textContent, "API synthetic");
  assert.equal(byId("heroName").textContent, "合成联系人");
  assert.equal(byId("stripMessageLabel").textContent, "会话消息：");
  assert.equal(byId("stripAnalysisLabel").textContent, "已分析：");
  assert.equal(byId("heroRelationBadge").textContent, "好感 72");
  assert.match(textOf(byId("heroMetricBox")), /好感度等级.*72/);
  assert.equal(byId("heroMbti").textContent, "EN?J");
  assert.equal(byId("mbtiScalesList").children.length, 4);
  assert.ok(byId("radarContainer").children.some(item => item.tag === "svg"));
  assert.equal(byId("tagCardTitle").textContent, "常见话题");
  assert.match(textOf(byId("tagCloud")), /见面.*时间/);
  assert.doesNotMatch(textOf(byId("tagCloud")), /undefined/);
  assert.equal(byId("botSummaryText").textContent, "常讨论周末见面");
  assert.equal(byId("apiPortraitDetails").hidden, true);
  assert.equal(members[0].username, "friend");
  assert.equal(avatars[0][0], "heroAvatar");
});

it("prefers native profile evidence and scores over the legacy API portrait and hides axis-only reassessment", async () => {
  const data = nativePayload();
  data.portrait = portrait("旧的自由生成摘要");
  data.mbtiBasis = { EI: { status: "supported", reason: "不应显示的旧解释" } };
  const calls = [];
  const { ui, byId, members } = personaHarness(async url => { calls.push(url); return data; });
  await ui.loadProfile(); await tick();
  assert.deepEqual(calls, ["/api/model-portrait?user=friend"]);
  assert.equal(byId("heroMbti").textContent, "ISFP");
  assert.equal(byId("heroRelationBadge").textContent, "好感 38");
  assert.equal(byId("stripMessageLabel").textContent, "对方消息：");
  assert.equal(byId("stripDbPath").textContent, "240 条");
  assert.equal(byId("tagCardTitle").textContent, "高频词");
  assert.match(textOf(byId("tagCloud")), /散步.*8/);
  assert.equal(byId("botSummaryText").textContent, data.nativeProfile.summary);
  assert.doesNotMatch(textOf(byId("mbtiSources")), /不应显示的旧解释/);
  assert.equal(byId("btnRetryApiPortrait").hidden, true);
  assert.equal(members[0].apiSource, true);
  assert.equal(members[0].apiNativeProfile, true);
  assert.deepEqual(members[0].mbtiInference, data.nativeProfile.mbtiInference);
  assert.deepEqual(members[0].traits, data.nativeProfile.traits);
});

it("uses only native processed evidence for MBTI and keeps unsupported axes unknown", () => {
  const data = nativePayload();
  const { ui, byId } = personaHarness(async () => data);
  data.nativeProfile.mbtiInference.eligibleMessages = 90;
  ui.renderApiPortrait(data);
  assert.equal(byId("heroMbti").textContent, "90/100 条");
  data.nativeProfile.mbtiInference.eligibleMessages = 120;
  data.nativeProfile.mbtiInference.axes.JP = { leftShare: null, rightShare: null, evidenceCount: 8, insufficientCount: 112 };
  ui.renderApiPortrait(data);
  assert.equal(byId("heroMbti").textContent, "ISF?");
  assert.match(textOf(byId("mbtiScalesList")), /J\/P · 尚无足够证据/);
  data.nativeProfile.traits = [];
  ui.renderApiPortrait(data);
  assert.match(textOf(byId("radarContainer")), /暂无互动风格证据/);
});

it("does not repaint native cards or rewrite evidence counts on job-only progress polls", () => {
  const data = nativePayload();
  data.progress.complete = false;
  data.job = { status: "running", phase: "analyzing", processed: 200, total: 300 };
  const { ui, context, members } = personaHarness(async () => data);
  ui.renderApiPortrait(data);
  const first = members.length;
  ui.renderApiPortrait({ ...data, progress: { ...data.progress, processedTargetTexts: 230 },
    job: { ...data.job, processed: 290 } });
  assert.equal(members.length, first);
  const saved = context.profileCache.get(JSON.stringify(["acct", "friend", "", "api-a"]));
  assert.equal(saved.stats.analyzedCount, 120);
  assert.equal(saved.mbtiInference.eligibleMessages, 120);
  assert.equal(saved.apiProgressProcessed, 230);
});

it("preserves native whole-group and member portrait boundaries", async () => {
  const data = nativePayload("group@chatroom");
  data.identity.isGroup = true;
  data.identity.members = [{ id: "member-1", name: "成员一" }];
  data.nativeProfile = { ...data.nativeProfile, ...data.identity, affinity: null, mbtiInference: null };
  const { ui, context, byId } = personaHarness(async () => data);
  context.currentUser = "group@chatroom";
  context.sessions.set("group@chatroom", { isGroup: true });
  await ui.loadProfile(); await tick();
  assert.equal(byId("mbtiCard").hidden, true);
  assert.doesNotMatch(textOf(byId("heroMetricBox")), /好感度等级/);
  const member = nativePayload("member-1").nativeProfile;
  data.subject = "member-1";
  data.identity = { ...data.identity, username: "member-1", name: "成员一" };
  data.nativeProfile = { ...member, ...data.identity, affinity: null };
  await ui.loadProfile("member-1"); await tick();
  assert.equal(byId("mbtiCard").hidden, false);
  assert.equal(byId("heroMbti").textContent, "ISFP");
  assert.doesNotMatch(textOf(byId("heroMetricBox")), /好感度等级/);
});

it("restores native evidence from the persisted source snapshot before a slow read", async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key) };
  const data = nativePayload();
  data.nativeProfile.mbtiInference.minAxisMargin = .7;
  const first = personaHarness(async () => data, storage);
  await first.ui.loadProfile(); await tick();
  let release;
  const second = personaHarness(() => new Promise(resolve => { release = resolve; }), storage);
  second.ui.loadProfile();
  assert.equal(second.byId("botSummaryText").textContent, data.nativeProfile.summary);
  assert.equal(second.byId("heroMbti").textContent, "????", "the cached native margin is not replaced by raw API axes");
  assert.match(textOf(second.byId("tagCloud")), /散步.*8/);
  release({ ...data, nativeProfile: null, portrait: null, available: null, inventoryReady: false });
  await tick();
  assert.equal(second.byId("botSummaryText").textContent, data.nativeProfile.summary);
  assert.equal(second.byId("heroMbti").textContent, "????");
});

it("keeps legacy scores read-only until explicit rebuilding yields a native profile", async () => {
  let data = { ...payload("api-a", "旧画像暂留"), needsRebuild: true, nativeProfile: null };
  const posts = [];
  const { ui, byId } = personaHarness(async (url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      return { account: "acct", sourceId: "api-a", job: { status: "queued" } };
    }
    return data;
  });
  await ui.loadProfile(); await tick();
  assert.equal(posts.length, 0);
  assert.equal(byId("botSummaryText").textContent, "旧画像暂留");
  assert.equal(byId("btnRetryApiPortrait").textContent, "更新画像");
  fire(byId("btnRetryApiPortrait"), "click"); await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].refreshAxes, undefined);
  data = { ...nativePayload(), needsRebuild: false };
  await ui.loadProfile(); await tick();
  assert.equal(byId("heroMbti").textContent, "ISFP");
  assert.equal(byId("botSummaryText").textContent, data.nativeProfile.summary);
  assert.equal(byId("btnRetryApiPortrait").hidden, true);
});

it("rejects a native profile belonging to another account or subject", async () => {
  for (const invalid of [{ account: "other-account" }, { username: "other-member" }]) {
    const data = nativePayload();
    data.nativeProfile = { ...data.nativeProfile, ...invalid };
    const { ui, byId, members } = personaHarness(async () => data);
    await ui.loadProfile(); await tick();
    assert.equal(members.some(profile => profile.apiNativeProfile), false);
    assert.notEqual(byId("botSummaryText").textContent, data.nativeProfile.summary);
    assert.equal(byId("apiPortraitStatus").textContent, "画像读取失败，请稍后重试");
  }
});

it("starts accumulation from one target text while keeping MBTI locked and migrations manual", async () => {
  for (const [targetCount, needsRebuild, expectedPosts] of [[0, false, 0], [1, false, 1], [2, false, 1], [1, true, 0]]) {
    const data = nativePayload();
    data.needsRebuild = needsRebuild;
    data.available = { messageCount: targetCount, textCount: targetCount, targetTextCount: targetCount, totalChars: targetCount * 12 };
    data.progress = { processed: 0, total: targetCount, processedTargetTexts: 0, totalTargetTexts: targetCount, complete: false };
    data.nativeProfile.stats = { messageCount: targetCount, textCount: targetCount, analyzedCount: 0, participantCount: 1 };
    data.nativeProfile.mbtiInference.eligibleMessages = 0;
    data.job = { id: null, status: "idle" };
    const posts = [];
    const { ui, byId } = personaHarness(async (url, options) => {
      if (options?.method === "POST") {
        posts.push(JSON.parse(options.body));
        data.job = { id: "first-batch", status: "running", phase: "classifying" };
      }
      return data;
    });
    await ui.loadProfile(); await tick();
    assert.equal(posts.length, expectedPosts, JSON.stringify({ targetCount, needsRebuild }));
    assert.equal(byId("heroMbti").textContent, "0/100 条");
    if (expectedPosts) {
      assert.equal(posts[0].refreshAxes, undefined);
      assert.equal(byId("apiPortraitStatus").textContent, "正在分析聊天");
    } else if (!targetCount) assert.equal(byId("apiPortraitStatus").textContent, "暂无目标文本，等待更多消息");
    else assert.equal(byId("btnRetryApiPortrait").textContent, "更新画像");
  }
});

it("requires the portrait's full context budget before automatic or manual submission", async () => {
  for (const contextTokens of [4096, 8192, 12287, 12288, 16384]) {
    for (const needsRebuild of [false, true]) {
      const data = nativePayload();
      data.needsRebuild = needsRebuild;
      data.progress.complete = false;
      data.job = { id: null, status: "idle" };
      const posts = [];
      const { ui, context, byId } = personaHarness(async (url, options) => {
        if (options?.method === "POST") {
          posts.push(JSON.parse(options.body));
          data.job = { id: "job", status: "running", phase: "classifying" };
        }
        return data;
      });
      context.modelSourceSnapshot.api.contextTokens = contextTokens;
      await ui.loadProfile(); await tick();
      const canRun = contextTokens >= 12288;
      assert.equal(posts.length, canRun && !needsRebuild ? 1 : 0);
      assert.equal(byId("btnRetryApiPortrait").disabled, !canRun);
      if (!canRun) {
        assert.equal(byId("apiPortraitStatus").textContent, "画像分析需要至少 12288 tokens 上下文，请在设置中调整");
        // Even a stale/programmatic click cannot bypass the disabled control.
        fire(byId("btnRetryApiPortrait"), "click"); await tick();
        assert.equal(posts.length, 0);
      } else if (needsRebuild) {
        fire(byId("btnRetryApiPortrait"), "click"); await tick();
        assert.equal(posts.length, 1);
      }
    }
  }
});

it("explains provider context rejection without always instructing a larger or smaller budget", () => {
  const data = nativePayload();
  data.job = { id: "job", status: "error", error: "context-too-long" };
  const { ui, context, byId } = personaHarness(async () => data);
  ui.renderApiPortrait(data);
  assert.equal(byId("apiPortraitStatus").textContent, "模型不支持当前请求上下文，请按模型实际支持容量调整设置");
  assert.doesNotMatch(byId("apiPortraitStatus").textContent, /调高|调低/);
  context.modelSourceSnapshot.api.contextTokens = 4096;
  ui.renderApiPortrait(data);
  assert.equal(byId("apiPortraitStatus").textContent, "画像分析需要至少 12288 tokens 上下文，请在设置中调整");
});

it("invalidates hidden-page API portraits on clearing so fallback cannot resurrect them", async () => {
  let cleared = false;
  let reads = 0;
  let holdOldRead = false, releaseOldRead;
  const data = nativePayload();
  const harness = navigationHarness(async (url, options) => {
    if (url === "/api/analysis-cache/clear") {
      cleared = true;
      return { cleared: true, ...JSON.parse(options.body) };
    }
    reads++;
    if (holdOldRead) {
      holdOldRead = false;
      return new Promise(resolve => { releaseOldRead = resolve; });
    }
    return cleared ? { ...data, portrait: null, nativeProfile: null,
      available: { messageCount: 0, textCount: 0, targetTextCount: 0, totalChars: 0 },
      progress: { processed: 0, total: 0, complete: false }, job: { status: "idle" } } : data;
  });
  const { ui, context, byId } = harness;
  await ui.loadProfile(); await tick();
  const currentKey = JSON.stringify(["acct", "friend", "", "api-a"]);
  const otherKey = JSON.stringify(["acct", "friend", "", "api-b"]);
  const other = { ...context.profileCache.get(currentKey), apiSourceId: "api-b" };
  context.profileCache.set(otherKey, other);
  context.storedProfileSnapshots.set(otherKey, { key: otherKey, at: Date.now(), profile: other });
  holdOldRead = true;
  ui.loadProfile(); await tick();
  assert.equal(typeof releaseOldRead, "function");
  ui.switchView("chat");
  installApiCacheClear(harness);
  const beforeClearReads = reads;
  fire(byId("btnConfirmAnalysisCacheClear"), "click"); await tick();
  assert.equal(reads, beforeClearReads, "clearing from chat must not load the hidden portrait");
  assert.equal(context.apiPortraitSnapshot, null);
  assert.equal(context.renderedApiPortraitKey, null);
  assert.equal(context.renderedApiPortraitScopeKey, null);
  assert.equal(context.profileCache.has(currentKey), false);
  assert.equal(context.storedProfileSnapshots.has(currentKey), false);
  assert.equal(context.profileCache.get(otherKey), other);
  ui.switchView("persona"); await tick();
  assert.equal(reads, beforeClearReads + 1, "the cancelled older GET cannot block the new read");
  releaseOldRead(data); await tick();
  assert.notEqual(byId("botSummaryText").textContent, data.nativeProfile.summary);
  assert.notEqual(context.profileCache.get(currentKey)?.summary, data.nativeProfile.summary);
  assert.notEqual(context.storedProfileSnapshots.get(currentKey)?.profile.summary, data.nativeProfile.summary);
});

it("does not invalidate the active portrait when another API source is cleared", async () => {
  const data = nativePayload("friend", "api-b");
  const harness = personaHarness(async (url, options) => url === "/api/analysis-cache/clear" ?
    { cleared: true, ...JSON.parse(options.body) } : data);
  harness.context.modelSourceSnapshot.sourceId = "api-b";
  await harness.ui.loadProfile(); await tick();
  const snapshot = harness.context.apiPortraitSnapshot;
  const rendered = harness.context.renderedApiPortraitKey;
  installApiCacheClear(harness, "api-a");
  fire(harness.byId("btnConfirmAnalysisCacheClear"), "click"); await tick();
  assert.equal(harness.context.apiPortraitSnapshot, snapshot);
  assert.equal(harness.context.renderedApiPortraitKey, rendered);
  assert.equal(harness.byId("botSummaryText").textContent, data.nativeProfile.summary);
});

it("marks the old portrait throughout rebuilding without hiding the actual failure reason", () => {
  const data = { ...payload("api-a", "待替换的旧摘要"), rebuilding: true,
    needsRebuild: false, progress: { processed: 0, total: 8, complete: false },
    job: { id: "rebuild", status: "running", phase: "classifying" } };
  const { ui, byId } = personaHarness(async () => data);
  ui.renderApiPortrait(data);
  assert.equal(byId("botSummaryText").textContent, "待替换的旧摘要");
  assert.equal(byId("apiPortraitStatus").textContent, "正在按新规则分析，暂显示旧画像");
  ui.renderApiPortrait({ ...data, job: { id: "rebuild", status: "error", error: "timeout" } });
  assert.equal(byId("apiPortraitStatus").textContent, "模型响应超时 · 暂显示旧画像");
  assert.equal(byId("botSummaryText").textContent, "待替换的旧摘要");
  ui.renderApiPortrait({ ...data, job: { id: "rebuild", status: "error", error: "portrait-state-invalid" } });
  assert.equal(byId("apiPortraitStatus").textContent,
    "画像进度校验失败，请清除当前模型的分析缓存后重试 · 暂显示旧画像");
});

it("uses exact native MBTI boundaries and backend preferences without changing the local card", () => {
  const { ui, byId } = personaHarness(async () => {});
  const axes = Object.fromEntries(["EI", "SN", "TF", "JP"].map(key =>
    [key, { leftShare: .6, rightShare: .4, evidenceCount: 40 }]));
  const inference = { eligibleMessages: 120, minMessages: 100, minAxisMargin: .2, axes, type: null };
  ui.renderMbti({ isGroup: false, apiSource: true, apiNativeProfile: true, mbtiInference: inference });
  assert.equal(byId("heroMbti").textContent, "????");
  assert.match(textOf(byId("mbtiScalesList")), /E 60% · I 40%/);
  ui.renderMbti({ isGroup: false, mbtiInference: inference });
  assert.equal(byId("heroMbti").textContent, "ESTJ", "local behavior remains unchanged in this scope");
  ui.renderMbti({ isGroup: false, apiSource: true, apiNativeProfile: true,
    mbtiInference: { ...inference, type: "ISFP" } });
  assert.equal(byId("heroMbti").textContent, "ISFP");
  ui.renderMbti({ isGroup: false, apiSource: true, apiNativeProfile: true,
    mbtiInference: { ...inference, type: "ISFP", axes: { ...axes, EI: { ...axes.EI, preference: null } } } });
  assert.equal(byId("heroMbti").textContent, "?SFP");
});

it("shows the Laya locked MBTI card for an API portrait below the evidence threshold", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", "样本较少"));
  ui.renderApiPortrait(payload("api-a", "样本较少"));
  assert.equal(byId("heroMbti").textContent, "5/100 条");
  assert.equal(byId("mbtiScaleBadge").textContent, "未解锁");
  assert.match(textOf(byId("mbtiScalesList")), /人格推测未解锁/);
  assert.match(textOf(byId("mbtiSources")), /5 条目标文本 · 100 条展示门槛/);
  assert.match(textOf(byId("mbtiSources")), /MBTI 官方偏好理论/);
});

it("unlocks the shared local MBTI card automatically at 100 processed texts", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", ""));
  const axes = Object.fromEntries(["EI", "SN", "TF", "JP"].map(key =>
    [key, { leftShare: 0.65, rightShare: 0.35, evidenceCount: 100 }]));
  ui.renderMbti({ isGroup: false, mbtiInference: {
    eligibleMessages: 100, minMessages: 100, axes, sources: [] } });
  assert.equal(byId("mbtiScaleBadge").textContent, "ESTJ · 聊天倾向");
  assert.doesNotMatch(textOf(byId("mbtiScalesList")), /解锁人格|人格推测未解锁/);
});

it("keeps uncertain API MBTI axes undecided while preserving their actual percentages", () => {
  for (const [score, expected] of [[null, "待判断"], [50, "????"], [51, "????"],
    [55, "????"], [59, "????"], [60, "ESTJ"], [40, "INFP"], [45, "????"]]) {
    const { ui, byId } = personaHarness(async () => {});
    const data = payload("api-a", "合成人格边界样本");
    data.available.targetTextCount = 120;
    data.available.mbtiEvidenceCount = 120;
    data.portrait.mbtiAxes = Object.fromEntries(["EI", "SN", "TF", "JP"].map(key => [key, score]));
    ui.renderApiPortrait(data);
    assert.equal(byId("heroMbti").textContent, expected, `score=${score}`);
    if (score !== null) assert.match(textOf(byId("mbtiScalesList")),
      new RegExp(`E ${score}% · I ${100 - score}%`));
  }
});

it("uses the local MBTI margin, including float boundaries and explicit undecided preferences", () => {
  const { ui, byId } = personaHarness(async () => {});
  const axis = (leftShare, extra = {}) => ({ leftShare, rightShare: 1 - leftShare, evidenceCount: 40, ...extra });
  const render = (axes, extra = {}) => ui.renderMbti({ isGroup: false, mbtiInference: {
    eligibleMessages: 120, minMessages: 100, axes, type: null, status: "partial", ...extra } });
  render({ EI: axis(0.51), SN: axis(0.55), TF: axis(0.6), JP: axis(0.4) });
  assert.equal(byId("heroMbti").textContent, "??TP");
  assert.equal(byId("mbtiScaleBadge").textContent, "部分维度待定");
  assert.match(textOf(byId("mbtiScalesList")), /E 51% · I 49%/);
  render({ EI: axis(0.65), SN: axis(0.65), TF: axis(0.65), JP: axis(0.65) }, { minAxisMargin: 0.4 });
  assert.equal(byId("heroMbti").textContent, "????");
  render({ EI: axis(0.7, { preference: null }), SN: axis(0.7, { preference: "S" }),
    TF: axis(0.7, { preference: "invalid" }), JP: axis(0.3, { preference: "P" }) });
  assert.equal(byId("heroMbti").textContent, "?S?P");
});

it("gates the API MBTI unlock on the observation ledger, not the analysed-text count", () => {
  // api-portrait.ts withholds all four axes until the observation ledger reaches 100
  // (`evidence.targetCount < 100`). Counting the 100 analysed texts instead reported the card
  // unlocked with every axis blank and no explanation.
  const { ui, byId } = personaHarness(async () => payload("api-a", "进行中"));
  const data = payload("api-a", "进行中");
  data.available.targetTextCount = 100;
  data.available.mbtiEvidenceCount = 30;
  data.progress = { processed: 30, total: 100, complete: false };
  ui.renderApiPortrait(data);
  assert.equal(byId("heroMbti").textContent, "30/100 条");
  assert.equal(byId("mbtiScaleBadge").textContent, "未解锁");
  assert.match(textOf(byId("mbtiScalesList")), /人格推测未解锁/);
});

it("uses exact processed target counts for the single-chat progress denominator", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", "进行中"));
  const data = payload("api-a", "进行中");
  data.available = { messageCount: 3949, textCount: 3160, targetTextCount: 1385,
    mbtiEvidenceCount: 1385, totalChars: 10000 };
  data.progress = { processed: 1043, total: 3160,
    processedTargetTexts: 407, totalTargetTexts: 1385, complete: false };
  data.job = { id: "job", status: "running", processed: 1043, total: 3160 };
  ui.renderApiPortrait(data);
  assert.equal(byId("stripMsgCount").textContent, "1385 条");
  assert.equal(byId("stripConfidence").textContent, "407 / 1385 条文本");
  assert.equal(byId("heroMbti").textContent, "EN?J");
});

it("uses the shared MBTI evidence state without an API-only unlock action", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", "有画像但无轴"));
  const data = payload("api-a", "有画像但无轴");
  data.available.targetTextCount = 120;
  data.available.mbtiEvidenceCount = 120;
  data.portrait.mbtiAxes = { EI: null, SN: null, TF: null, JP: null };
  ui.renderApiPortrait(data);
  assert.equal(byId("heroMbti").textContent, "待判断");
  assert.equal(byId("mbtiScaleBadge").textContent, "偏好证据待积累");
  const card = textOf(byId("mbtiScalesList"));
  assert.match(card, /尚无足够证据/);
  assert.doesNotMatch(card, /解锁人格|重试 API 画像/);
  assert.doesNotMatch(card, /\?\?\?\?/);
});

it("auto-continues an incomplete API portrait once, like local Laya, without looping", async () => {
  const posts = [];
  let job = { id: null, status: "idle", processed: 0, total: 0 };
  const { ui, byId } = personaHarness(async (url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      job = { id: "job-1", status: "running", processed: 2, total: 8 };
      return { account: "acct", sourceId: "api-a", job };
    }
    const data = payload("api-a", "进行中");
    data.job = job;
    data.progress = job.status === "done"
      ? { processed: 8, total: 8, complete: true }
      : { processed: 2, total: 8, complete: false };
    return data;
  });
  await ui.loadProfile();
  await tick();
  await ui.loadProfile();
  await ui.loadProfile();
  assert.equal(posts.length, 1, "entering/polling auto-continues exactly once while running");
  assert.equal(posts[0].refreshAxes, undefined);
  job = { id: "job-1", status: "done", processed: 8, total: 8 };
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "no repost once the saved portrait is up to date");
  assert.equal(byId("btnRetryApiPortrait").hidden, true);
});

it("keeps a completed empty portrait settled across repeated loads without posting another analysis", async () => {
  const posts = [];
  const data = payload("api-a", "");
  data.portrait = {
    summary: "", communication: "", emotionExpression: "", interactionPreferences: "",
    topics: [], patterns: [], boundaries: [], uncertain: [], affinity: null,
    mbtiAxes: { EI: null, SN: null, TF: null, JP: null },
    traits: { socialEnergy: null, humor: null, composure: null, initiative: null, care: null, affection: null },
  };
  data.available = { messageCount: 150, textCount: 150, targetTextCount: 120,
    mbtiEvidenceCount: 120, totalChars: 700 };
  data.progress = { processed: 150, total: 150, processedTargetTexts: 120,
    totalTargetTexts: 120, complete: true, batchIndex: 1, batchTotal: 1 };
  data.needsRebuild = false;
  const { ui, byId } = personaHarness(async (url, options) => {
    if (options?.method === "POST") posts.push({ url, body: JSON.parse(options.body) });
    return data;
  });
  for (let repeat = 0; repeat < 3; repeat++) {
    await ui.loadProfile();
    ui.renderApiPortrait(data);
    await tick();
  }
  assert.equal(posts.length, 0, "empty observations are a completed judgment, not a request to infer again");
  assert.equal(byId("apiPortraitStatus").textContent, "API 画像已更新");
  assert.equal(byId("botSummaryText").textContent, "待判断");
  assert.equal(byId("heroMbti").textContent, "待判断");
  assert.equal(byId("btnRetryApiPortrait").hidden, true);
});

it("offers explicit reassessment of saved observations without restarting completed history", async () => {
  const posts = [];
  const data = payload("api-a", "已保存的交流观察");
  data.available = { messageCount: 180, textCount: 150, targetTextCount: 120, totalChars: 900 };
  data.progress = { processed: 150, total: 150, processedTargetTexts: 120,
    totalTargetTexts: 120, complete: true, batchIndex: 2, batchTotal: 2 };
  data.portrait.mbtiAxes = { EI: null, SN: null, TF: null, JP: null };
  const { ui, byId } = personaHarness(async (url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      return { account: "acct", sourceId: "api-a", job: { id: "review", status: "running" } };
    }
    return data;
  });
  await ui.loadProfile(); await tick();
  assert.equal(posts.length, 0);
  assert.equal(byId("btnRetryApiPortrait").hidden, false);
  assert.equal(byId("btnRetryApiPortrait").textContent, "重新评估 MBTI");
  fire(byId("btnRetryApiPortrait"), "click"); await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].refreshAxes, true);
  assert.equal(byId("botSummaryText").textContent, "已保存的交流观察");
  data.portrait.mbtiAxes.SN = 35;
  data.mbtiBasis = { SN: { status: "supported", kind: "pattern",
    reason: "讨论不同方案时持续关注概念联系，暂偏N。", evidenceCount: 2 } };
  ui.renderApiPortrait(data);
  assert.match(textOf(byId("mbtiSources")), /持续关注概念联系/);
  assert.equal(byId("btnRetryApiPortrait").hidden, false, "a partial estimate may be explicitly reassessed again");
  assert.equal(posts.length, 1, "rendering the result cannot schedule another review");
});

it("preserves a legacy portrait without automatic migration and posts once after an explicit update click", async () => {
  const posts = [];
  let updating = false;
  const legacy = { ...payload("api-a", "迁移前保留的摘要"), needsRebuild: true };
  const current = () => updating ? { ...legacy, needsRebuild: false,
    progress: { processed: 0, total: 8, complete: false, batchIndex: 0, batchTotal: 1 },
    job: { id: "migration", status: "running", phase: "observing" } } : legacy;
  const { ui, byId } = personaHarness(async (url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      updating = true;
      return { account: "acct", sourceId: "api-a", job: current().job };
    }
    return current();
  });
  for (let repeat = 0; repeat < 3; repeat++) {
    await ui.loadProfile();
    ui.renderApiPortrait(legacy);
    await tick();
  }
  assert.equal(posts.length, 0, "opening an old cache must not silently pay to rebuild history");
  assert.equal(byId("botSummaryText").textContent, "迁移前保留的摘要");
  assert.equal(byId("btnRetryApiPortrait").hidden, false);
  assert.equal(byId("btnRetryApiPortrait").textContent, "更新画像");
  fire(byId("btnRetryApiPortrait"), "click");
  await tick();
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "manual update starts one job and polling must not duplicate it");
  assert.equal(posts[0].account, "acct");
  assert.equal(posts[0].user, "friend");
  assert.equal(byId("botSummaryText").textContent, "迁移前保留的摘要");
  assert.equal(byId("apiPortraitStatus").textContent, "正在提取聊天观察");
});

it("cannot reassess a previous member or another chat while the current snapshot is loading", async () => {
  for (const switchChat of [false, true]) {
    const posts = [];
    let hold = false, release;
    const data = { ...payload("api-a", "已完成成员画像", {
      username: "m1", name: "合成成员", isGroup: true, avatar: "", avatarCandidates: [],
      members: [{ id: "m1", name: "成员一" }, { id: "m2", name: "成员二" }],
    }), subject: "m1", available: { messageCount: 180, textCount: 150, targetTextCount: 120, totalChars: 900 },
      progress: { processed: 150, total: 150, processedTargetTexts: 120, totalTargetTexts: 120, complete: true } };
    const { ui, context, byId } = personaHarness(async (url, options) => {
      if (options?.method === "POST") {
        posts.push(JSON.parse(options.body));
        return { account: "acct", sourceId: "api-a", job: { id: "review", status: "running" } };
      }
      if (hold) return new Promise(resolve => { release = resolve; });
      return data;
    });
    context.currentUser = "room-a@chatroom";
    await ui.loadProfile("m1"); await tick();
    assert.equal(byId("btnRetryApiPortrait").hidden, false);
    hold = true;
    if (switchChat) context.currentUser = "room-b@chatroom";
    else context.activeMember = "m2";
    fire(byId("btnRetryApiPortrait"), "click"); await tick();
    assert.equal(posts.length, 0, "a stale visible button must not post either reassessment or full history work");
    assert.equal(byId("btnRetryApiPortrait").hidden, true);
    hold = false;
    release({ ...data, subject: switchChat ? "m1" : "m2",
      identity: { ...data.identity, username: switchChat ? "m1" : "m2" } });
    await tick();
    fire(byId("btnRetryApiPortrait"), "click"); await tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].user, context.currentUser);
    assert.equal(posts[0].member, switchChat ? "m1" : "m2");
    assert.equal(posts[0].refreshAxes, true);
  }
});

it("shows a running state during submission and a visible error instead of idle after failure", async () => {
  let rejectPost;
  let posts = 0;
  const data = payload("api-a", "已保存画像");
  data.progress = { processed: 0, total: 8, complete: false };
  data.job = { id: null, status: "idle" };
  const { ui, byId } = personaHarness((url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts++;
      return new Promise((_resolve, reject) => { rejectPost = reject; });
    }
    return Promise.resolve(data);
  });
  await ui.loadProfile();
  await tick();
  assert.equal(posts, 1);
  assert.equal(byId("stripStatusText").textContent, "API 分析中");
  rejectPost(new Error("synthetic failure"));
  await tick();
  assert.equal(byId("stripStatusText").textContent, "分析失败，请重试");
  assert.match(byId("apiPortraitStatus").textContent, /提交失败/);
  assert.equal(byId("btnRetryApiPortrait").hidden, false);
  await ui.loadProfile();
  await tick();
  assert.equal(posts, 1, "polling after failure must not silently submit again");
});

it("shows real completed throughput and the ten-second retry countdown in the status", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", "已保存画像"));
  const data = payload("api-a", "已保存画像");
  data.progress = { processed: 4, total: 8, complete: false };
  data.job = { id: "job", status: "running", processed: 4, total: 8,
    batchStartedAtMs: Date.now() - 5000, rateTextsPerSecond: 3.25 };
  ui.renderApiPortrait(data);
  assert.match(byId("stripStatusText").textContent, /API 分析中.*3\.3 条\/秒/);
  data.job.retry = { reason: "invalid-output", attempt: 1, max: 5,
    nextAtMs: Date.now() + 10000 };
  ui.renderApiPortrait(data);
  assert.match(byId("stripStatusText").textContent, /自动重试 1\/5/);
  assert.match(byId("apiPortraitStatus").textContent, /模型返回格式不正确.*自动重试 1\/5/);
});

it("restores the API portrait synchronously on an A->B->A revisit before the slow GET resolves", async () => {
  const posts = [];
  const pending = [];
  let delayA = false;
  const apiPayload = user => ({
    account: "acct", sourceId: "api-a", subject: user,
    identity: { username: user, name: user + "名", avatar: "", avatarCandidates: [], isGroup: false, members: [] },
    portrait: { summary: user + "摘要", communication: "", emotionExpression: "",
      interactionPreferences: "", topics: [], patterns: [], boundaries: [], uncertain: [],
      affinity: 60, mbtiAxes: { EI: null, SN: null, TF: null, JP: null },
      traits: { socialEnergy: null, humor: null, composure: null, initiative: null, care: null, affection: null } },
    available: { messageCount: 9, textCount: 8, targetTextCount: 5, totalChars: 120 },
    inventoryReady: true, inventoryStatus: "ready",
    progress: { processed: 8, total: 8, complete: true },
    job: { id: null, status: "done" },
  });
  const { ui, context, byId } = personaHarness((url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts.push(1);
      return { account: "acct", sourceId: "api-a",
        job: { id: "j", status: "running", processed: 0, total: 8 } };
    }
    const user = context.currentUser;
    if (delayA && user === "A") return new Promise(resolve => pending.push(() => resolve(apiPayload("A"))));
    return apiPayload(user);
  });
  context.sessions.set("A", { name: "A名", isGroup: false });
  context.sessions.set("B", { name: "B名", isGroup: false });
  context.currentUser = "A";
  await ui.loadProfile();
  await tick();
  assert.equal(byId("stripDbPath").textContent, "9 条");
  context.currentUser = "B";
  await ui.loadProfile();
  await tick();
  assert.equal(byId("botSummaryText").textContent, "B摘要");
  delayA = true;
  context.currentUser = "A";
  const revisit = ui.loadProfile();
  // Synchronously, before the slow A GET resolves, the saved A snapshot is visible.
  assert.equal(byId("stripDbPath").textContent, "9 条");
  assert.equal(byId("botSummaryText").textContent, "A摘要");
  pending.shift()();
  await revisit;
  await tick();
  assert.equal(byId("botSummaryText").textContent, "A摘要");
  assert.equal(posts.length, 0, "restoring a cached scope must not submit a portrait");
});

it("real session and view navigation restores an API portrait despite a startup refresh marker", async () => {
  let resolveRevisit;
  let delayed = false;
  const { ui, context, byId } = navigationHarness(() => {
    if (delayed && context.currentUser === "A") {
      delayed = false;
      return new Promise(resolve => { resolveRevisit = resolve; });
    }
    return apiPortraitPayload(context.currentUser);
  });
  context.sessions.set("A", { name: "A名", isGroup: false });
  context.sessions.set("B", { name: "B名", isGroup: false });
  context.currentUser = null;
  context.view = "chat";
  ui.switchSession("A");
  ui.switchView("persona");
  await tick();
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  ui.switchView("chat");
  ui.switchSession("B");
  ui.switchView("persona");
  await tick();
  assert.equal(byId("botSummaryText").textContent, "api-a:B摘要");

  const key = JSON.stringify(["acct", "A", "", "api-a"]);
  context.profileSnapshotsRequireRefresh.add(key);
  delayed = true;
  ui.switchView("chat");
  ui.switchSession("A");
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  ui.switchView("persona");
  assert.equal(byId("stripDbPath").textContent, "9 条");
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  const cachedProgress = byId("stripConfidence").textContent;
  assert.match(cachedProgress, /5 \/ 5/);
  resolveRevisit({ ...apiPortraitPayload("A"), portrait: null, available: null,
    inventoryReady: false, inventoryStatus: "running",
    progress: { processed: 0, total: 0, complete: false }, job: { id: null, status: "idle" } });
  await tick();
  assert.equal(byId("stripDbPath").textContent, "9 条", "a blank inventory GET keeps known counts");
  assert.equal(byId("stripConfidence").textContent, cachedProgress, "a blank GET keeps saved progress");
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  ui.loadProfile();
  await tick();
  assert.equal(context.profileSnapshotsRequireRefresh.has(key), false,
    "a validated API response resolves the pending refresh marker");
});

it("restores an API group member without requiring a local Laya member cache", async () => {
  let delayed = false;
  const { ui, context, byId } = navigationHarness(() => {
    if (delayed) return new Promise(() => {});
    return payload("api-a", "成员的独立画像", { username: "member", name: "合成成员",
      isGroup: true, members: [{ id: "member", name: "合成成员" }], messageCount: 9, textCount: 5 });
  });
  context.currentUser = "room@chatroom";
  context.sessions.set("room@chatroom", { name: "群聊", isGroup: true });
  context.sessions.set("B", { name: "B", isGroup: false });
  await ui.loadProfile("member");
  await tick();
  assert.equal(byId("heroName").textContent, "合成成员");
  delayed = true;
  ui.switchView("chat");
  ui.switchSession("B");
  ui.switchSession("room@chatroom");
  ui.switchView("persona");
  assert.equal(context.activeMember, "member");
  assert.equal(byId("heroName").textContent, "合成成员");
  assert.equal(byId("botSummaryText").textContent, "成员的独立画像");
});

it("distinguishes background preparation from provider inference without resetting saved progress", () => {
  const { ui, byId } = personaHarness(async () => { throw new Error("unexpected request"); });
  const data = payload("api-a", "已有画像");
  ui.renderApiPortrait(data);
  const before = byId("stripConfidence").textContent;
  ui.renderApiPortrait({ ...data, portrait: null, available: null, inventoryReady: false,
    progress: { processed: 0, total: 0, complete: false },
    job: { status: "running", phase: "preparing" } });
  assert.equal(byId("stripConfidence").textContent, before);
  assert.equal(byId("stripStatusText").textContent, "正在准备待分析文本");
  assert.equal(byId("botSummaryText").textContent, "已有画像");
});

it("legacy incremental counts remain usable while missing inventory fields are rebuilt", async () => {
  let legacy = false;
  const { ui, byId } = personaHarness(async () => {
    const data = payload("api-a", "已保存画像");
    if (legacy) {
      data.available.messageCount = null;
      data.available.totalChars = null;
      data.available.pieceCount = null;
      data.progress = { processed: 7, total: 8, processedTargetTexts: 4, totalTargetTexts: 5, complete: false };
      data.job = { status: "running", phase: "preparing" };
    }
    return data;
  });
  await ui.loadProfile();
  await tick();
  legacy = true;
  await ui.loadProfile();
  await tick();
  assert.equal(byId("stripDbPath").textContent, "9 条");
  assert.equal(byId("stripConfidence").textContent, "4 / 5 条文本");
  assert.equal(byId("stripStatusText").textContent, "正在准备待分析文本");
  assert.equal(byId("botSummaryText").textContent, "已保存画像");
});

it("view re-entry restores its saved portrait after the shared DOM is cleared", async () => {
  let resolveRefresh;
  let delay = false;
  const { ui, context, byId } = navigationHarness(() => delay ?
    new Promise(resolve => { resolveRefresh = resolve; }) : apiPortraitPayload("A"));
  context.sessions.set("A", { name: "A名", isGroup: false });
  context.currentUser = null;
  context.view = "chat";
  ui.switchSession("A");
  ui.switchView("persona");
  await tick();
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  ui.switchView("chat");
  ui.clearProfileView("A名");
  delay = true;
  ui.switchView("persona");
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  assert.equal(byId("stripDbPath").textContent, "9 条");
  resolveRefresh(apiPortraitPayload("A"));
  await tick();
});

it("cold restart restores the persisted API portrait before a delayed GET, isolated per source", async () => {
  const store = (() => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k) };
  })();
  {
    const { ui, context } = personaHarness(() => apiPortraitPayload("A", "api-a"), store);
    context.sessions.set("A", { name: "A名", isGroup: false });
    context.currentUser = "A";
    await ui.loadProfile();
    await tick();
    assert.ok(store.getItem("real-ui-profile-snapshots-v1"), "snapshot persisted to storage");
  }
  const pending = [];
  const { ui, context, byId } = personaHarness((url, options) => {
    if (options?.method === "POST")
      return { account: "acct", sourceId: context.modelSourceSnapshot.sourceId,
        job: { id: "j", status: "running", processed: 0, total: 8 } };
    if (context.modelSourceSnapshot.sourceId === "api-a" && context.currentUser === "A")
      return new Promise(resolve => pending.push(() => resolve(apiPortraitPayload("A", "api-a"))));
    return apiPortraitPayload(context.currentUser, context.modelSourceSnapshot.sourceId);
  }, store);
  context.sessions.set("A", { name: "A名", isGroup: false });
  // A different source must not show A's api-a snapshot.
  context.modelSourceSnapshot.sourceId = "api-b";
  context.currentUser = "A";
  await ui.loadProfile();
  await tick();
  assert.notEqual(byId("botSummaryText").textContent, "api-a:A摘要");
  // Back on api-a, the persisted snapshot is visible before the delayed GET resolves.
  context.modelSourceSnapshot.sourceId = "api-a";
  const revisit = ui.loadProfile();
  assert.equal(byId("stripDbPath").textContent, "9 条");
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  pending.shift()();
  await revisit;
  await tick();
});

it("auto-starts an API portrait exactly once when the active source has no checkpoint", async () => {
  const posts = [];
  let job = { id: null, status: "idle", processed: 0, total: 0 };
  const payloadFor = () => ({
    ...apiPortraitPayload("A", "api-a"),
    available: { messageCount: 4120, textCount: 3160, targetTextCount: 1385, totalChars: 240000 },
    progress: job.status === "done"
      ? { processed: 3160, total: 3160, complete: true }
      : { processed: 0, total: 3160, complete: false },
    job,
  });
  const { ui, context } = personaHarness((url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      job = { id: "j", status: "running", processed: 0, total: 3160 };
      return { account: "acct", sourceId: "api-a", job };
    }
    return payloadFor();
  });
  context.sessions.set("A", { name: "A名", isGroup: false });
  context.currentUser = "A";
  await ui.loadProfile();
  await tick();
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "auto-starts exactly once while running");
  assert.equal(posts[0].refreshAxes, undefined);
  job = { id: "j", status: "done", processed: 3160, total: 3160 };
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "no repost after completion");
});

it("resumes a saved API checkpoint incrementally without restarting or blanking", async () => {
  const posts = [];
  let job = { id: null, status: "idle", processed: 1589, total: 3160 };
  const payloadFor = () => ({
    ...apiPortraitPayload("A", "api-a"),
    available: { messageCount: 4120, textCount: 3160, targetTextCount: 1385, totalChars: 240000 },
    progress: job.status === "idle"
      ? { processed: 1589, total: 3160, complete: false, batchIndex: 3, batchTotal: 6 }
      : { processed: 3160, total: 3160, complete: true, batchIndex: 6, batchTotal: 6 },
    job,
  });
  const { ui, context, byId } = personaHarness((url, options) => {
    if (url === "/api/model-portrait" && options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      job = { id: "j", status: "running", processed: 1589, total: 3160 };
      return { account: "acct", sourceId: "api-a", job };
    }
    return payloadFor();
  });
  context.sessions.set("A", { name: "A名", isGroup: false });
  context.currentUser = "A";
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "a saved checkpoint resumes with exactly one POST");
  // The prior portrait stays visible while the resume runs (no blank loading page).
  assert.equal(byId("botSummaryText").textContent, "api-a:A摘要");
  assert.notEqual(byId("stripDbPath").textContent, "正在读取");
  job = { id: "j", status: "done", processed: 3160, total: 3160 };
  await ui.loadProfile();
  await tick();
  assert.equal(posts.length, 1, "no repost once the checkpoint is complete");
});

it("shows undecided API metrics in the same cards and preserves whole-group/member behavior", () => {
  const { ui, context, byId, members } = personaHarness(async () => payload("api-a", ""));
  context.currentUser = "room@chatroom";
  context.sessions.set("room@chatroom", { name: "合成群聊", isGroup: true });
  const identity = { username: "room@chatroom", name: "合成群聊", avatar: "",
    avatarCandidates: [], isGroup: true, members: [{ id: "friend", name: "合成成员" }],
    messageCount: 9, textCount: 8 };
  const data = payload("api-a", "群聊讨论安排", identity);
  data.portrait.affinity = null;
  data.portrait.mbtiAxes.TF = null;
  data.portrait.traits.humor = null;
  ui.renderApiPortrait(data);
  assert.equal(byId("heroRelationBadge").textContent, "群画像");
  assert.equal(byId("mbtiCard").hidden, true);
  assert.match(textOf(byId("heroMetricBox")), /参与人数.*已分析文本/);
  assert.match(textOf(byId("radarContainer")), /表达活力.*60.*幽默表达.*待判断/);
  context.activeMember = "friend";
  ui.renderApiPortrait(payload("api-a", "成员画像", { ...identity, username: "friend", name: "合成成员",
    messageCount: 4, textCount: 3 }));
  assert.equal(byId("mbtiCard").hidden, false);
  assert.equal(byId("heroRelationBadge").textContent, "群成员画像");
  assert.equal(members.at(-1).username, "friend");
});

it("updates group progress without recreating portrait controls and keeps a saved portrait through a null poll", () => {
  const { ui, context, byId, members, avatars } = personaHarness(async () => payload("api-a", ""));
  context.currentUser = "room@chatroom";
  const identity = { username: "room@chatroom", name: "合成群聊", avatar: "",
    avatarCandidates: [], isGroup: true, members: [{ id: "friend", name: "合成成员" }],
    messageCount: 9, textCount: 8 };
  const first = payload("api-a", "已保存的群画像", identity);
  first.progress = { processed: 2, total: 8, complete: false };
  first.job = { id: "synthetic", status: "running" };
  ui.renderApiPortrait(first);
  const avatarNode = byId("heroAvatar").children[0];
  const memberNode = byId("groupMemberTabs").children[0];
  const second = payload("api-a", "已保存的群画像", identity);
  second.progress = { processed: 4, total: 8, complete: false };
  second.job = { id: "synthetic", status: "running" };
  ui.renderApiPortrait(second);
  assert.strictEqual(byId("heroAvatar").children[0], avatarNode);
  assert.strictEqual(byId("groupMemberTabs").children[0], memberNode);
  assert.equal(avatars.length, 1);
  assert.equal(members.length, 1);
  assert.equal(byId("stripConfidence").textContent, "4 / 8 条文本");
  assert.match(textOf(byId("heroMetricBox")), /已分析文本.*4 \/ 8/);
  ui.renderApiPortrait({ ...second, portrait: null, progress: { processed: 5, total: 8, complete: false } });
  assert.equal(byId("botSummaryText").textContent, "已保存的群画像");
  assert.strictEqual(byId("heroAvatar").children[0], avatarNode);
  assert.strictEqual(byId("groupMemberTabs").children[0], memberNode);
  assert.match(textOf(byId("heroMetricBox")), /已分析文本.*5 \/ 8/);
});

it("re-renders the group metadata strip after the shared profile DOM is cleared", () => {
  const { ui, context, byId } = personaHarness(async () => payload("api-a", "群画像"));
  context.currentUser = "room@chatroom";
  context.sessions.set("room@chatroom", { name: "合成群聊", isGroup: true });
  const identity = { username: "room@chatroom", name: "合成群聊", avatar: "", avatarCandidates: [],
    isGroup: true, members: [{ id: "friend", name: "合成成员" }], messageCount: 9, textCount: 8 };
  ui.renderApiPortrait(payload("api-a", "群画像", identity));
  assert.equal(byId("stripMsgCount").textContent, "8 条");
  assert.equal(ui.apiProfileRendered(), true);
  // A same-scope re-entry clears the shared DOM but keeps the portrait key, so the
  // render memo must be invalidated or the strip stays blank forever.
  ui.clearProfileView("合成群聊");
  assert.equal(byId("stripDbPath").textContent, "正在读取");
  assert.equal(ui.apiProfileRendered(), false);
  ui.renderApiPortrait(payload("api-a", "群画像", identity));
  assert.equal(byId("stripMsgCount").textContent, "8 条");
});

it("clears the old portrait when the API source actually changes", async () => {
  let finishNew;
  const newResponse = new Promise(resolve => { finishNew = resolve; });
  let calls = 0;
  const { ui, context, byId } = personaHarness(async () =>
    ++calls === 1 ? payload("api-a", "旧来源画像") : newResponse);
  await ui.loadProfile();
  await tick();
  assert.equal(byId("botSummaryText").textContent, "旧来源画像");
  context.modelSourceSnapshot = { mode: "api", sourceId: "api-b",
    api: { model: "new-model", contextTokens: 8192 } };
  await ui.loadProfile();
  assert.equal(byId("botSummaryText").textContent, "");
  assert.equal(byId("heroAvatar").children.length, 0);
  finishNew(payload("api-b", "新来源画像"));
  await tick();
  assert.equal(byId("botSummaryText").textContent, "新来源画像");
});

it("keeps the current portrait visible while the same source changes its context budget", async () => {
  let finishRefresh;
  const refresh = new Promise(resolve => { finishRefresh = resolve; });
  let calls = 0;
  const { ui, context, byId, avatars } = personaHarness(async () =>
    ++calls === 1 ? payload("api-a", "当前画像") : refresh);
  await ui.loadProfile();
  await tick();
  const avatarNode = byId("heroAvatar").children[0];
  context.modelSourceSnapshot = { mode: "api", sourceId: "api-a",
    api: { model: "synthetic", contextTokens: 32768 } };
  await ui.loadProfile();
  assert.equal(byId("botSummaryText").textContent, "当前画像");
  assert.strictEqual(byId("heroAvatar").children[0], avatarNode);
  finishRefresh(payload("api-a", "当前画像"));
  await tick();
  assert.strictEqual(byId("heroAvatar").children[0], avatarNode);
  assert.equal(avatars.length, 1);
});

it("drops a stale portrait response after an API source switch", async () => {
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const calls = [];
  const { ui, context, byId } = personaHarness(async url => {
    calls.push(url);
    return calls.length === 1 ? oldResponse : payload("api-b", "新来源画像");
  });
  await ui.loadProfile();
  context.modelSourceSnapshot = { mode: "api", sourceId: "api-b",
    api: { model: "new-model", contextTokens: 8192 } };
  await ui.loadProfile();
  await tick();
  releaseOld(payload("api-a", "旧来源画像"));
  await tick();
  assert.equal(byId("botSummaryText").textContent, "新来源画像");
  assert.equal(calls.length, 2);
});

it("shows bounded portrait errors in the existing summary status area", () => {
  const { ui, byId } = personaHarness(async () => payload("api-a", ""));
  for (const [code, label] of [["invalid-output", "模型返回格式不正确"],
    ["timeout", "模型响应超时"], ["rate-limit", "接口请求受限"],
    ["empty-response", "模型未返回内容"]]) {
    const data = payload("api-a", "");
    data.job = { id: "synthetic", status: "error", error: code };
    data.progress.complete = false;
    ui.renderApiPortrait(data);
    assert.equal(byId("apiPortraitStatus").textContent, label);
  }
});

it("does not GET or POST local analysis in API mode or before local Laya is ready", async () => {
  const calls = [];
  const context = vm.createContext({
    api: async url => { calls.push(url); return {}; },
    suppressedLocalAccounts: new Set(), autoIncrementalState: new Map(),
    currentAccount: "acct", currentUser: "friend", generation: 1,
    activeAnalysisScope: "local-scope", historyState: null,
    modelSourceResolved: true, modelSourceSnapshot: { mode: "api" },
    localModelResolved: true, localModelReady: false,
  });
  seed(context, {});
  vm.runInContext(incrementalCode, context);
  const state = { pending: false };
  const analysis = { job: { status: "idle" } };
  context.ui.scheduleIncremental("friend", 1, null, analysis, true, "new-window");
  await context.ui.startIncremental("friend", 1, null, "local-scope", state);
  await context.ui.loadAnalysis("friend", 1, null);
  assert.deepEqual(calls, []);
  context.modelSourceSnapshot = { mode: "local" };
  assert.equal(context.ui.canAnalyzeLocal(), false);
  context.localModelReady = true;
  assert.equal(context.ui.canAnalyzeLocal(), true);
});

it("keeps a saved portrait through a same-scope inventory refresh and clears on a real source change", async () => {
  const groupIdentity = { username: "room@chatroom", name: "合成群聊", avatar: "", avatarCandidates: [],
    isGroup: true, members: [{ id: "friend", name: "合成成员" }], messageCount: 9, textCount: 8 };
  const ready = () => payload("api-a", "群画像", groupIdentity);
  const notReady = () => {
    const data = payload("api-a", "群画像", groupIdentity);
    data.inventoryReady = false;
    data.inventoryStatus = "running";
    data.available = null;
    data.progress = { processed: 2, total: 8, complete: false };
    return data;
  };
  const responses = [ready(), notReady(), notReady()];
  let i = 0;
  const { ui, context, byId } = personaHarness(async () => responses[Math.min(i++, responses.length - 1)]);
  context.currentUser = "room@chatroom";
  context.sessions.set("room@chatroom", { name: "合成群聊", isGroup: true });
  for (let n = 0; n < 3; n++) {
    await ui.loadProfile();
    await tick();
    assert.equal(byId("heroRelationBadge").textContent, "群画像");
    assert.match(byId("stripDbPath").textContent, /^\d+ 条 · \d+ 人参与$/);
  }
  // A genuine source change must clear instead of showing the old conversation's portrait.
  context.modelSourceSnapshot = { mode: "api", sourceId: "api-b",
    api: { model: "other", contextTokens: 8192 } };
  await ui.loadProfile();
  assert.equal(byId("stripDbPath").textContent, "正在读取");
  assert.equal(ui.apiProfileRendered(), false);
});

it("ignores an in-flight local analysis response after switching to API", async () => {
  let finish;
  let rendered = 0;
  const context = vm.createContext({
    api: () => new Promise(resolve => { finish = resolve; }),
    suppressedLocalAccounts: new Set(), autoIncrementalState: new Map(),
    currentAccount: "acct", currentUser: "friend", generation: 1,
    analysisGeneration: 0, activeAnalysisScope: "local-scope", historyState: null,
    modelSourceResolved: true, modelSourceSnapshot: { mode: "local" },
    localModelResolved: true, localModelReady: true,
    renderJob: () => { rendered++; },
  });
  seed(context, {});
  vm.runInContext(incrementalCode, context);
  const pending = context.ui.loadAnalysis("friend", 1, null);
  context.modelSourceSnapshot = { mode: "api" };
  finish({ account: "acct", job: { status: "error" } });
  await pending;
  assert.equal(rendered, 0);
  assert.equal(context.activeAnalysisScope, "local-scope");
});
