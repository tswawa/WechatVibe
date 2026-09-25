"use strict";
const byId = id => document.getElementById(id);
const element = (tag, className = "", text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const text = (id, value) => { byId(id).textContent = value == null ? "" : String(value); };
const setStripStatus = (message = "") => {
  text("stripStatusText", message);
  byId("stripStatusText").title = "";
  const item = byId("stripStatusItem");
  if (item) item.style.display = message ? "" : "none";
};
const svgIcon = (pathD, className = "", viewBox = "0 0 24 24") => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("viewBox", viewBox);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  svg.appendChild(path);
  return svg;
};
function getWatermarks() {
  const key = `read-watermark:${currentAccount || "default"}`;
  try { return JSON.parse(localStorage.getItem(key) || "{}"); }
  catch { return {}; }
}
function markSessionAsRead(username) {
  if (!username) return;
  const key = `read-watermark:${currentAccount || "default"}`;
  const marks = getWatermarks();
  const session = sessions.get(username);
  marks[username] = {
    time: Number(session?.sortTimestamp || session?.time) || 0,
    unreadCount: Number(session?.unreadCount) || 0,
    preview: String(session?.preview || ""),
    readAt: Date.now()
  };
  try { localStorage.setItem(key, JSON.stringify(marks)); } catch {}
}
function getVisibleUnreadCount(session) {
  if (!session) return 0;
  const serverUnread = Number(session.unreadCount) || 0;
  if (serverUnread <= 0) return 0;
  if (session.username === currentUser) return 0;
  const marks = getWatermarks();
  const wm = marks[session.username];
  if (!wm) return serverUnread;
  const curTime = Number(session.sortTimestamp || session.time) || 0;
  const curPreview = String(session.preview || "");
  const hasNewTime = wm.time > 0 && curTime > wm.time;
  const hasIncreasedUnread = serverUnread > wm.unreadCount;
  const hasNewPreview = (curTime === wm.time && curPreview !== wm.preview && curPreview !== "");
  if (hasIncreasedUnread) return serverUnread - wm.unreadCount;
  if (hasNewTime || hasNewPreview) return serverUnread;
  return 0;
}
function getMbtiUnlockKey() {
  return `mbti-unlocked:${currentAccount || "default"}:${currentUser || ""}:${activeMember || ""}`;
}
function isMbtiUnlocked() {
  try { return localStorage.getItem(getMbtiUnlockKey()) === "true"; }
  catch { return false; }
}
function unlockMbti() {
  try { localStorage.setItem(getMbtiUnlockKey(), "true"); } catch {}
}
const defaults = { theme: "dark", zoom: "1.0", intent: true };
const CURRENT_LABEL_SCHEMA = "generic-v5";
const GENERIC_INTENT_LABELS = Object.freeze({
  small_talk: "闲聊", share_news: "分享", ask_question: "提问", seek_help: "求助",
  give_comfort: "安慰", agree: "同意", invite: "邀约", show_affection: "表达好感",
  complain: "抱怨", apologize: "道歉", joke: "玩笑", reject: "拒绝",
  distance: "保持距离", thank: "感谢", greet: "问候", confirm: "确认", inspect: "查看",
  suggest_action: "建议或指令", explain: "解释", inform: "告知事实",
  plan: "计划", correct: "纠正或异议", status_report: "状态报告",
  follow_up: "追问", clarify: "澄清", share_feeling: "表达感受", confide: "倾诉",
  seek_comfort: "求安慰", seek_company: "求陪伴", show_care: "关心",
  encourage: "鼓励", praise: "称赞", celebrate: "祝贺", miss_you: "表达想念",
  test_feelings: "探询心意", set_boundary: "设定边界", reconcile: "缓和关系",
  show_material: "展示内容", offer_help: "提供帮助", tease: "调侃", close_chat: "告别",
  general_exchange: "一般交流",
});
const GROUNDED_EVIDENCE = Object.freeze({
  greet: ["greeting_phrase"], thank: ["thanks_phrase"],
  confirm: ["short_acknowledgement"], inspect: ["first_person_inspection"],
  agree: ["explicit_acceptance"],
  reject: ["explicit_refusal"], invite: ["inclusive_invitation"],
  ask_question: ["answer_seeking_question"], seek_help: ["action_request"],
  suggest_action: ["advice_marker", "negative_imperative", "imperative_adjustment", "delegated_action"],
  plan: ["first_person_intention"], correct: ["explicit_correction"],
  explain: ["causal_explanation", "process_explanation"], complain: ["negative_evaluation"],
  status_report: ["progress_statement"], share_news: ["sharing_announcement"],
});
let settings;
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem("real-ui-settings-1") || "{}") }; }
catch { settings = { ...defaults }; }
delete settings.historyLimit;
if (!["dark", "light"].includes(settings.theme)) settings.theme = "dark";
if (!["0.9", "1.0", "1.1", "1.25", "1.5"].includes(settings.zoom)) settings.zoom = "1.0";
if (typeof settings.intent !== "boolean") settings.intent = true;
const save = () => localStorage.setItem("real-ui-settings-1", JSON.stringify(settings));
const sessions = new Map();
const sessionCache = new Map();
const profileCache = new Map();
const sessionCacheMessageLimit = 80;
const historyWindowLimit = 240;
let historyState = null;
let historyRequest = 0;
let historyController = null;
let historySearchRequest = 0;
let historySearchController = null;
let historySearchPending = false;
let historySearchPage = 0;
let historySearchPageStarts = [null];
let historySearchQuery = { q: "", date: "" };
let self = null;
let sessionSignature = null;
let sessionRequest = 0;
let sessionLoading = false;
let sessionRefreshQueued = false;
let windowRequestSerial = 0;
let preloadDone = 0;
let preloadTotal = 0;
let currentAccount = null;
let currentUser = null;
let view = "chat";
let generation = 0;
let profileGeneration = 0;
let analysisGeneration = 0;
const autoIncrementalState = new Map();
let activeAnalysisScope = null;
let currentAnalysisJob = null;
let currentRecentJob = null;
let controller = null;
let messages = [];
let results = {};
const inlineIntentPending = new Map();
let inlineIntentJobId = null;
let recentFailed = false;
const requestedRecentSignatures = new Set();
let recentPending = false;
let intentActionState = "idle";
let intentFeedbackTimer = null;
let manualRecentAwaitingPost = false;
let manualRecentJobId = null;
let manualRecentDeferred = false;
let incrementalFailed = false;
let analysisNetworkFailed = false;
let recentNetworkFailed = false;
let messagePending = false;
let messageRequest = 0;
let messageRefreshQueued = false;
let selectedAnalysisTimer = null;
let conversationMood = null;
let followLatest = true;
let lastChatScrollTop = 0;
let catalogReady = false;
let intentDisplayAliases = new Map();
let emotionDisplayAliases = new Map();
let catalogLabelRevision = "";
let toastTimer;
let accountUnavailable = false;
let accountClearedExiting = false;
let replyPredictionRequest = 0;
let replyPredictionController = null;
let startupActive = true;
let startupStage = "account";
let startupStageEpoch = 0;
let startupAttempt = 0;
let startupWatchdog = null;
let startupAccountRetryUsed = false;
let startupAccountRetryTimer = null;
function showStartup(stage, message, options = {}) {
  if (!startupActive) return;
  startupStage = stage;
  const epoch = ++startupStageEpoch;
  const steps = ["account", "sessions", "messages"];
  for (const item of byId("startupOverlay").querySelectorAll(".startup-step")) {
    const position = steps.indexOf(item.dataset.step);
    item.classList.toggle("done", position < steps.indexOf(stage));
    item.classList.toggle("active", item.dataset.step === stage);
  }
  text("startupStatus", message);
  byId("startupRetry").hidden = !options.retry;
  byId("startupContinue").hidden = !options.continueEmpty;
  clearTimeout(startupWatchdog);
  if (!options.retry) startupWatchdog = setTimeout(() => {
    if (startupActive && startupStageEpoch === epoch) byId("startupRetry").hidden = false;
  }, 12000);
}
function completeStartup() {
  if (!startupActive) return;
  startupActive = false;
  startupAttempt++;
  clearTimeout(startupWatchdog);
  clearTimeout(startupAccountRetryTimer);
  startupAccountRetryTimer = null;
  startupAccountRetryUsed = false;
  byId("startupOverlay").hidden = true;
  byId("appWindow").removeAttribute("inert");
}
function retryStartup() {
  if (!startupActive || accountClearedExiting) return;
  startupAttempt++;
  clearTimeout(startupAccountRetryTimer);
  startupAccountRetryTimer = null;
  startupAccountRetryUsed = true;
  showStartup(currentAccount ? "messages" : "sessions", currentAccount ? `正在准备聊天记录 ${preloadDone}/${preloadTotal}` : "正在读取会话列表…");
  void loadSessions();
}
function sessionCacheKey(account, user) {
  return JSON.stringify([account, user]);
}
function sessionSummarySignature(session) {
  return JSON.stringify(session);
}
function cacheCurrentSession(update) {
  if (!currentAccount || !currentUser) return;
  const key = sessionCacheKey(currentAccount, currentUser);
  const cached = sessionCache.get(key);
  if (!cached && !Array.isArray(update.messages)) return;
  if (update.windowSerial && cached?.windowSerial > update.windowSerial) return;
  const entry = { ...(cached || { account: currentAccount, user: currentUser, messages: null, results: {}, mood: null, scrollTop: 0, followLatest: true }), ...update };
  if (Array.isArray(entry.messages)) {
    entry.messages = entry.messages.slice(-sessionCacheMessageLimit);
    entry.results = visibleResults(entry.results || {}, entry.messages);
  }
  sessionCache.set(key, entry);
}
function cacheSessionWindow(account, session, next, serial) {
  const key = sessionCacheKey(account, session.username);
  const cached = sessionCache.get(key);
  if (serial < (cached?.windowSerial || 0)) return;
  const selected = next.slice(-sessionCacheMessageLimit);
  sessionCache.set(key, {
    ...(cached || { account, user: session.username, mood: null, scrollTop: 0, followLatest: true }),
    messages: selected,
    results: unchangedMessageResults(cached?.messages || [], selected, cached?.results || {}),
    summarySignature: sessionSummarySignature(session),
    windowSerial: serial
  });
}
function sessionWindowReady(account, session) {
  const cached = sessionCache.get(sessionCacheKey(account, session.username));
  return Array.isArray(cached?.messages) &&
    (session.username === currentUser && !startupActive || cached.summarySignature === sessionSummarySignature(session));
}
function pruneSessionCache(account, nextSessions) {
  for (const [key, entry] of sessionCache) {
    if (entry.account !== account || !nextSessions.has(entry.user)) sessionCache.delete(key);
  }
  for (const key of profileCache.keys()) {
    const [cachedAccount, user] = JSON.parse(key);
    if (cachedAccount !== account || !nextSessions.has(user)) profileCache.delete(key);
  }
  pruneStoredProfiles(account, nextSessions);
}
function visibleResults(source, list) {
  const selected = {};
  for (const message of list) {
    const id = String(message.id);
    if (Object.prototype.hasOwnProperty.call(source, id) && fineMessageResult(source[id])) selected[id] = source[id];
  }
  return selected;
}
function fineMessageResult(value) {
  return !!value && typeof value === "object" && !value.batchId && !value.batch && value.state !== "batch-covered";
}
function unchangedMessageResults(previous, next, source) {
  const previousById = new Map(previous.map(message => [String(message.id), JSON.stringify(message)]));
  const selected = {};
  for (const message of next) {
    const id = String(message.id);
    if (previousById.get(id) === JSON.stringify(message) && Object.prototype.hasOwnProperty.call(source, id) && fineMessageResult(source[id])) selected[id] = source[id];
  }
  return selected;
}
const percent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1).replace(/\.0$/, "")}%` : "";
const time = value => { const number = Number(value); if (!Number.isFinite(number) || number <= 0) return ""; const date = new Date(number); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; };
function toast(value) {
  text("toastMsg", value);
  byId("toastMsg").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => byId("toastMsg").classList.remove("show"), 2300);
}
function avatarUrls(value, candidates = []) {
  return [value, ...(Array.isArray(candidates) ? candidates : [])].map(candidate => {
    try { const url = new URL(candidate); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }).filter(Boolean);
}
function avatar(value, className, candidates = [], name = "", group = false) {
  const frame = element("span", `${className === "msg-avatar" ? "msg-avatar-frame" : className} avatar-frame`);
  const fallback = element("span", "avatar-fallback", group ? "群" : Array.from(String(name || "·").trim())[0] || "·");
  frame.appendChild(fallback);
  const urls = avatarUrls(value, candidates);
  if (urls.length) {
    const image = element("img", `${className === "msg-avatar" ? "msg-avatar " : ""}avatar-image`);
    image.alt = "";
    if (className === "session-avatar" || className === "msg-avatar") {
      image.loading = "lazy";
      image.decoding = "async";
    }
    let index = 0;
    image.onload = () => frame.classList.add("loaded");
    image.onerror = () => { frame.classList.remove("loaded"); index++; if (index < urls.length) image.src = urls[index]; else image.remove(); };
    frame.appendChild(image);
    image.src = urls[index];
  }
  return frame;
}
function setAvatar(id, value, candidates = [], name = "", group = false) {
  const target = byId(id);
  if (id === "selfAvatar") {
    const fallback = byId("selfAvatarFallback");
    fallback.textContent = Array.from(String(name || "我").trim())[0] || "我";
    fallback.style.display = "grid";
    target.style.display = "none";
    const urls = avatarUrls(value, candidates);
    let index = 0;
    target.onload = () => { target.style.display = "block"; fallback.style.display = "none"; };
    target.onerror = () => { index++; if (index < urls.length) target.src = urls[index]; else { target.removeAttribute("src"); target.style.display = "none"; } };
    if (urls.length) target.src = urls[index];
    else target.removeAttribute("src");
    return;
  }
  target.replaceChildren(avatar(value, "avatar-inner", candidates, name, group));
}
async function api(path, options = {}, signal) {
  const response = await fetch(path, { ...options, signal, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}) } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    if (response.status === 503) {
      try {
        const body = await response.json();
        error.code = typeof body?.error === "string" ? body.error : "";
      } catch { }
    }
    throw error;
  }
  const data = await response.json();
  if (data.error) throw new Error(String(data.error));
  return data;
}
function status(container, message, retry) {
  container.replaceChildren(element("div", "ui-state", message));
  if (retry) {
    const button = element("button", "ui-retry", "重试");
    button.addEventListener("click", retry);
    container.appendChild(button);
  }
}
const isNetworkFailure = error => error instanceof TypeError;
function canPredictReply() {
  return !!currentUser && currentAccount != null && sessions.has(currentUser) && !sessions.get(currentUser).isGroup && messages.length > 0;
}
function updatePredictReplyAvailability() {
  const button = byId("btnPredictReply");
  if (!button) return;
  button.disabled = !canPredictReply() || !!replyPredictionController;
  button.title = sessions.get(currentUser)?.isGroup ? "群聊暂不支持预测" : messages.length ? "预测对方可能的回应" : "暂无消息";
}
function clearReplyPrediction() {
  replyPredictionController?.abort();
  replyPredictionController = null;
  replyPredictionRequest++;
  const card = byId("replyPrediction");
  card.hidden = true;
  card.dataset.lastMessageId = "";
  byId("replyPredictionBody").replaceChildren();
  const dock = byId("chatInput").closest(".chat-input-pane");
  if (card.parentElement !== dock) dock.prepend(card);
  updatePredictReplyAvailability();
}
function placeReplyPrediction(scroll = true) {
  const card = byId("replyPrediction");
  const items = [...byId("chatMessages").querySelectorAll(".msg-item")];
  const host = [...items].reverse().find(item => item.querySelector(".inline-intent-row")) || items.at(-1);
  const wrap = host?.querySelector(".msg-content-wrap");
  if (!wrap) return;
  const intent = wrap.querySelector(".inline-intent-row");
  if (intent) intent.after(card);
  else wrap.appendChild(card);
  if (scroll) requestAnimationFrame(() => { if (!card.hidden && card.isConnected) card.scrollIntoView({ block: "nearest" }); });
}
function resetAccountView(message = "当前微信账号未就绪", preserveOtherCaches = false) {
  clearTimeout(startupAccountRetryTimer);
  startupAccountRetryTimer = null;
  clearInlineIntentPending();
  clearTimeout(selectedAnalysisTimer);
  selectedAnalysisTimer = null;
  cancelHistoryRequest();
  historyState = null;
  resetHistorySearch();
  if (!startupActive) {
    startupActive = true;
    byId("startupOverlay").hidden = false;
    byId("appWindow").setAttribute("inert", "");
  }
  showStartup("account", message, { retry: message === "当前微信账号未就绪", continueEmpty: message === "当前微信账号未就绪" });
  accountUnavailable = false;
  sessionRequest++;
  controller?.abort();
  controller = null;
  generation++;
  profileGeneration++;
  analysisGeneration++;
  messageRequest++;
  currentAccount = null;
  currentUser = null;
  self = null;
  sessionSignature = null;
  preloadDone = 0;
  preloadTotal = 0;
  sessions.clear();
  if (!preserveOtherCaches) {
    sessionCache.clear();
    profileCache.clear();
  }
  messages = [];
  results = {};
  conversationMood = null;
  recentFailed = false;
  recentPending = false;
  incrementalFailed = false;
  analysisNetworkFailed = false;
  recentNetworkFailed = false;
  if (!preserveOtherCaches) autoIncrementalState.clear();
  messagePending = false;
  messageRefreshQueued = false;
  manualRecentAwaitingPost = false;
  manualRecentJobId = null;
  manualRecentDeferred = false;
  setIntentActionState("idle");
  profilePending = false;
  requestedRecentSignatures.clear();
  activeAnalysisScope = null;
  currentAnalysisJob = null;
  currentRecentJob = null;
  activeMember = "";
  groupMembers = [];
  renderedProfileKey = null;
  renderedProfileSignature = null;
  memberRenderedScope = null;
  followLatest = true;
  lastChatScrollTop = 0;
  byId("chatInput").value = "";
  byId("btnSend").classList.remove("ready");
  byId("searchInput").value = "";
  clearReplyPrediction();
  setAvatar("selfAvatar", null, [], "我");
  text("chatTitle", "聊天");
  byId("chatStatusPill").style.display = "none";
  text("analysisStatus", "");
  byId("btnRetryAnalysis").hidden = true;
  byId("btnRetryProfile").hidden = true;
  status(byId("chatMessages"), message);
  status(byId("sessionList"), message);
  text("personaHeaderTitle", "人物画像分析");
  text("heroName", message);
  text("heroRelationBadge", "");
  byId("heroAvatar").replaceChildren();
  byId("heroMbtiRow").hidden = true;
  text("heroArchetype", "");
  byId("heroArchetype").style.display = "none";
  byId("heroMetricBox").replaceChildren();
  text("heroMbti", "");
  byId("mbtiCard").hidden = true;
  byId("mbtiScalesList").replaceChildren();
  byId("mbtiSources").replaceChildren();
  byId("radarContainer").replaceChildren();
  byId("tagCloud").replaceChildren();
  text("botSummaryText", "");
  text("stripDbPath", "待读取");
  text("stripMsgCount", "待读取");
  text("stripConfidence", "");
  setStripStatus("");
  byId("groupMemberTabs").replaceChildren();
  byId("groupMemberTabs").style.display = "none";
  updateHistoryNavigation();
}
function accountUnavailableError(error) {
  return error?.status === 503 && error?.code === "AccountUnavailableError";
}
function accountChangedError(error) {
  return error?.status === 503 && error?.code === "AccountChangedError";
}
function contactSnapshotStaleError(error) {
  return error?.status === 503 && error?.code === "ContactSnapshotStaleError";
}
function handleAccountBoundaryError(error) {
  if (accountChangedError(error)) {
    resetAccountView("微信账号已变化，正在读取会话…");
    void loadSessions();
    return true;
  }
  if (accountUnavailableError(error)) {
    resetAccountView("当前微信账号未就绪");
    accountUnavailable = true;
    return true;
  }
  return false;
}
function acceptResponseAccount(account) {
  if (account === undefined || account === currentAccount) return true;
  resetAccountView("微信账号已变化，正在读取会话…");
  void loadSessions();
  return false;
}
function predictionState(message, retry = false) {
  const body = byId("replyPredictionBody");
  const state = element("div", "reply-prediction-state", message);
  if (retry) {
    const button = element("button", "reply-prediction-retry", "重试");
    button.type = "button";
    button.addEventListener("click", () => { void requestReplyPrediction(); });
    state.appendChild(button);
  }
  body.replaceChildren(state);
}
async function predictionApi(payload, signal) {
  const response = await fetch("/api/predict-reply", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  let data = null;
  try { data = await response.json(); } catch { }
  if (!response.ok || data?.error) {
    const error = new Error("Prediction request failed");
    error.status = response.status;
    error.code = typeof data?.code === "string" ? data.code : typeof data?.error === "string" ? data.error :
      typeof data?.error?.code === "string" ? data.error.code : "";
    throw error;
  }
  return data;
}
async function requestReplyPrediction() {
  if (!canPredictReply() || view !== "chat") return;
  clearReplyPrediction();
  const token = ++replyPredictionRequest;
  const user = currentUser;
  const account = currentAccount;
  const lastMessageId = String(messages.at(-1).id);
  const draft = byId("chatInput").value.trim();
  const requestId = globalThis.crypto?.randomUUID?.() || `predict-${Date.now()}-${token}`;
  const payload = { user, account, requestId, expectedLastMessageId: lastMessageId };
  if (draft) payload.draft = draft;
  const requestController = new AbortController();
  replyPredictionController = requestController;
  const card = byId("replyPrediction");
  card.hidden = false;
  card.dataset.lastMessageId = lastMessageId;
  placeReplyPrediction();
  predictionState("正在预测…");
  updatePredictReplyAvailability();
  try {
    const data = await predictionApi(payload, requestController.signal);
    if (token !== replyPredictionRequest || requestController.signal.aborted) return;
    if (currentUser !== user || currentAccount !== account || String(messages.at(-1)?.id ?? "") !== lastMessageId ||
      byId("chatInput").value.trim() !== draft) { clearReplyPrediction(); return; }
    if (data.user !== user || data.account !== account || data.requestId !== requestId ||
      String(data.lastMessageId) !== lastMessageId || typeof data.basisFingerprint !== "string" || !data.basisFingerprint ||
      !Array.isArray(data.candidates) || data.candidates.length !== 3 ||
      data.candidates.some(item => !item || typeof item.label !== "string" || !item.label.trim() ||
        typeof item.description !== "string" || !item.description.trim())) throw new Error("Invalid prediction response");
    const body = byId("replyPredictionBody");
    body.replaceChildren(...data.candidates.map(candidate => {
      const row = element("div", "reply-prediction-item");
      row.append(element("span", "reply-prediction-label", candidate.label),
        element("span", "reply-prediction-description", candidate.description));
      return row;
    }));
  } catch (error) {
    if (error.name !== "AbortError" && token === replyPredictionRequest && currentUser === user && currentAccount === account) {
      if (error.code === "account-changed" || accountChangedError(error) || accountUnavailableError(error)) {
        if (error.code === "account-changed") {
          resetAccountView("微信账号已变化，正在读取会话…");
          void loadSessions();
        } else handleAccountBoundaryError(error);
        return;
      }
      const message = error.code === "content-too-long" ? "内容太长，请缩短草稿" :
        ["no-context", "no-text-context"].includes(error.code) ? "暂无可用文字" :
          error.status === 409 ? "消息已变化，请重试" : "预测失败，请重试";
      predictionState(message, !["content-too-long", "no-context", "no-text-context"].includes(error.code));
    }
  } finally {
    if (token === replyPredictionRequest) {
      replyPredictionController = null;
      updatePredictReplyAvailability();
    }
  }
}
function renderSessions() {
  const container = byId("sessionList");
  const query = byId("searchInput").value.trim().toLowerCase();
  const existing = new Map([...container.children].filter(node => node.classList.contains("session-item")).map(node => [node.dataset.id, node]));
  let visible = 0;
  for (const session of sessions.values()) {
    if (!`${session.name || ""} ${session.preview || ""}`.toLowerCase().includes(query)) continue;
    let item = existing.get(session.username);
    if (!item) {
      item = element("div", "session-item");
      item.dataset.id = session.username;
      const avatarWrap = element("div", "session-avatar-wrap");
      const info = element("div", "session-info");
      const top = element("div", "session-top");
      top.append(element("span", "session-name"), element("span", "session-time"));
      const bottom = element("div", "session-bottom");
      bottom.appendChild(element("span", "session-preview"));
      info.append(top, bottom);
      item.append(avatarWrap, info);
      item.addEventListener("click", () => {
        markSessionAsRead(item.dataset.id);
        switchSession(item.dataset.id);
      });
    }
    item.classList.toggle("active", session.username === currentUser);
    const avatarWrap = item.querySelector(".session-avatar-wrap");
    const avatarSignature = JSON.stringify([session.avatar, session.avatarCandidates, session.name || session.username, session.isGroup]);
    if (item.dataset.avatarSignature !== avatarSignature) {
      avatarWrap.querySelector(".avatar-frame")?.remove();
      avatarWrap.prepend(avatar(session.avatar, "session-avatar", session.avatarCandidates, session.name || session.username, session.isGroup));
      item.dataset.avatarSignature = avatarSignature;
    }
    const unread = getVisibleUnreadCount(session);
    const badge = avatarWrap.querySelector(".session-unread-dot");
    if (unread > 0) {
      const label = unread > 99 ? "99+" : unread > 9 ? "9+" : String(unread);
      if (badge) { if (badge.textContent !== label) badge.textContent = label; }
      else avatarWrap.appendChild(element("span", "session-unread-dot", label));
    } else badge?.remove();
    const name = item.querySelector(".session-name");
    const displayName = session.name || session.username;
    if (name.dataset.label !== displayName || name.dataset.pinned !== String(!!session.pinned)) {
      name.replaceChildren(document.createTextNode(displayName));
      if (session.pinned) name.appendChild(element("span", "session-pinned", "置顶"));
      name.dataset.label = displayName;
      name.dataset.pinned = String(!!session.pinned);
    }
    const timeNode = item.querySelector(".session-time");
    const displayTime = time(session.time);
    if (timeNode.textContent !== displayTime) timeNode.textContent = displayTime;
    const preview = item.querySelector(".session-preview");
    if (preview.textContent !== (session.preview || "")) preview.textContent = session.preview || "";
    if (container.children[visible] !== item) container.insertBefore(item, container.children[visible] || null);
    visible++;
  }
  while (container.children.length > visible) container.lastElementChild.remove();
  if (!visible) status(container, sessions.size ? "没有匹配的会话" : "暂无会话");
}
async function preloadSessionWindows(account, nextSessions, request) {
  const list = [...nextSessions.values()];
  preloadTotal = list.length;
  const missing = list.filter(session => !sessionWindowReady(account, session));
  preloadDone = list.length - missing.length;
  if (startupActive) showStartup("messages", `正在准备聊天记录 ${preloadDone}/${preloadTotal}`);
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const serial = ++windowRequestSerial;
    const data = await api("/api/messages/batch", { method: "POST", body: JSON.stringify({ account, users: batch.map(session => session.username) }) });
    if (request !== sessionRequest || currentAccount !== account) return false;
    if (data.account !== account) {
      const error = new Error("Batch account changed");
      error.status = 503;
      error.code = "AccountChangedError";
      throw error;
    }
    if (!Array.isArray(data.windows)) throw new Error("Invalid batch response");
    const expected = new Map(batch.map(session => [session.username, session]));
    const seen = new Set();
    for (const window of data.windows) {
      if (!window || !expected.has(window.user) || seen.has(window.user) || !Array.isArray(window.messages)) throw new Error("Invalid batch window");
      seen.add(window.user);
      cacheSessionWindow(account, expected.get(window.user), window.messages, serial);
    }
    preloadDone = list.filter(session => sessionWindowReady(account, session)).length;
    if (startupActive) showStartup("messages", `正在准备聊天记录 ${preloadDone}/${preloadTotal}`);
    if (seen.size !== batch.length) throw new Error("Incomplete batch response");
  }
  return true;
}
async function loadSessions(retryChanged = true) {
  if (accountClearedExiting) return;
  if (sessionLoading) { sessionRefreshQueued = true; return; }
  sessionLoading = true;
  let request = ++sessionRequest;
  let followup = null;
  try {
    const data = await api("/api/sessions");
    if (request !== sessionRequest || accountClearedExiting) return;
    if (typeof data.account !== "string" || !data.account || !Array.isArray(data.sessions)) throw new Error("Invalid sessions response");
    const signature = JSON.stringify([data.self, data.sessions, data.account]);
    const accountChanged = currentAccount !== data.account;
    if (accountChanged && currentAccount !== null) {
      resetAccountView("正在读取会话…");
      request = ++sessionRequest;
    }
    accountUnavailable = false;
    currentAccount = data.account;
    clearTimeout(startupAccountRetryTimer);
    startupAccountRetryTimer = null;
    const nextSessions = new Map();
    for (const session of data.sessions) if (session?.username) nextSessions.set(session.username, session);
    if (signature === sessionSignature && [...nextSessions.values()].every(session => sessionWindowReady(data.account, session))) return;
    if (nextSessions.size && !await preloadSessionWindows(data.account, nextSessions, request)) return;
    if (request !== sessionRequest || currentAccount !== data.account) return;
    const scroll = byId("sessionList").scrollTop;
    self = data.self || null;
    setAvatar("selfAvatar", self?.avatar, self?.avatarCandidates, self?.name || "我");
    if (!nextSessions.size) {
      resetAccountView("暂无会话");
      currentAccount = data.account;
      self = data.self || null;
      setAvatar("selfAvatar", self?.avatar, self?.avatarCandidates, self?.name || "我");
      sessionSignature = signature;
      completeStartup();
      return;
    }
    sessions.clear();
    for (const [user, session] of nextSessions) sessions.set(user, session);
    sessionSignature = signature;
    let remembered = null;
    try { remembered = localStorage.getItem(`last-conversation:${currentAccount}`); } catch {}
    const selected = sessions.has(currentUser) ? currentUser :
      sessions.has(remembered) ? remembered : sessions.keys().next().value;
    if (selected !== currentUser || accountChanged) switchSession(selected, accountChanged);
    if (currentUser && sessions.has(currentUser)) text("chatTitle", sessions.get(currentUser).name || currentUser);
    pruneSessionCache(data.account, nextSessions);
    renderSessions();
    byId("sessionList").scrollTop = scroll;
    if (!accountChanged && currentUser && view === "persona") void loadProfile(activeMember);
    completeStartup();
  } catch (error) {
    if (request !== sessionRequest) return;
    if (accountChangedError(error)) {
      resetAccountView("微信账号已变化，正在读取会话…");
      if (retryChanged !== false) followup = false;
      else showStartup("account", "微信账号已变化，请重试", { retry: true });
    } else if (accountUnavailableError(error)) {
      const autoRetry = startupActive && !startupAccountRetryUsed;
      if (!accountUnavailable || currentAccount !== null || sessions.size) resetAccountView("当前微信账号未就绪");
      accountUnavailable = true;
      status(byId("sessionList"), "当前微信账号未就绪", () => { void loadSessions(); });
      if (autoRetry) {
        startupAccountRetryUsed = true;
        showStartup("account", "正在重试连接微信…");
        const attempt = startupAttempt;
        const pendingRequest = sessionRequest;
        startupAccountRetryTimer = setTimeout(() => {
          startupAccountRetryTimer = null;
          if (startupActive && startupAttempt === attempt && sessionRequest === pendingRequest &&
              accountUnavailable && !accountClearedExiting) {
            void loadSessions();
          }
        }, 2500);
      } else showStartup("account", "当前微信账号未就绪", { retry: true, continueEmpty: true });
    } else if (contactSnapshotStaleError(error)) {
      if (currentAccount !== null || sessions.size || !startupActive) {
        resetAccountView("联系人资料更新中…", true);
      }
      status(byId("sessionList"), "联系人资料更新中…", () => { void loadSessions(); });
      showStartup("sessions", "联系人资料更新中…", { retry: true });
      const pendingRequest = sessionRequest;
      setTimeout(() => {
        if (pendingRequest === sessionRequest && !accountClearedExiting) void loadSessions();
      }, 2000);
    } else {
      if (!sessions.size && !accountUnavailable) status(byId("sessionList"), "会话读取失败，请重试", () => { void loadSessions(); });
      if (startupActive) showStartup(currentAccount && preloadTotal ? "messages" : "sessions",
        currentAccount && preloadTotal ? `聊天记录准备失败 ${preloadDone}/${preloadTotal}，请重试` : "会话读取失败，请重试", { retry: true });
    }
  } finally {
    sessionLoading = false;
    const queued = sessionRefreshQueued;
    sessionRefreshQueued = false;
    if (followup !== null) void loadSessions(followup);
    else if (queued) void loadSessions();
  }
}
function renderMood() {
  const mood = conversationMood;
  const moodLabel = displayEmotionLabel(mood);
  const face = mood?.label ? window.Kaomoji.pick(mood, `${currentUser}:history:${mood.label}`) || String(mood.kaomoji || "").trim() : "";
  byId("chatStatusPill").style.display = settings.intent && mood?.label ? "inline-flex" : "none";
  text("headerMoodLabel", sessions.get(currentUser)?.isGroup ? "群聊氛围" : "人物情绪");
  text("headerMoodKaomoji", face || moodLabel);
  byId("chatStatusPill").title = moodLabel ? `${moodLabel} · ${Number(mood.sampleCount) || 0} 条已分析文本` : "";
}
function rankedScores(values) {
  if (!Array.isArray(values)) return [];
  return values.map((item, index) => ({ item, index, probability: Number(item?.probability) }))
    .filter(({ item, probability }) => item?.label && Number.isFinite(probability) && probability > 0 && probability <= 1)
    .sort((left, right) => right.probability - left.probability || left.index - right.index);
}
function intentAlias(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}
function displayEmotionLabel(item) {
  for (const value of [item?.rawLabel, item?.id, item?.modelLabel, item?.label]) {
    const display = emotionDisplayAliases.get(intentAlias(value));
    if (display) return display;
  }
  return String(item?.label || item?.rawLabel || "").trim();
}
function rankedEmotionScores(values) {
  return rankedScores(values).map(({ item, ...rank }) => ({
    ...rank, item: { ...item, label: displayEmotionLabel(item) },
  }));
}
function hasIntentContent(messageText) {
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(String(messageText || ""));
}
function displayedIntent(result, messageText) {
  if (!hasIntentContent(messageText)) return [];
  const grounded = result.groundedIntent;
  if (grounded && Object.prototype.hasOwnProperty.call(GROUNDED_EVIDENCE, grounded.label) &&
      GROUNDED_EVIDENCE[grounded.label].includes(grounded.evidenceKind)) {
    return [{ label: GENERIC_INTENT_LABELS[grounded.label], probability: null }];
  }
  const ranked = Array.isArray(result.intent) ? result.intent
    .filter(item => typeof item?.rawLabel === "string" &&
      Object.prototype.hasOwnProperty.call(GENERIC_INTENT_LABELS, item.rawLabel) &&
      typeof item.probability === "number" && Number.isFinite(item.probability) &&
      item.probability >= 0 && item.probability <= 1)
    .sort((left, right) => right.probability - left.probability) : [];
  return ranked.slice(0, 3).map(item => ({
    label: GENERIC_INTENT_LABELS[item.rawLabel], probability: item.probability,
  }));
}
function appendScoreLine(container, label, scores, messageId, emotion = false) {
  if (!scores.length) return;
  const line = element("div", `intent-line ${emotion ? "emotion-line" : "intent-score-line"}`);
  line.appendChild(element("span", "intent-label", label));
  for (const [index, { item }] of scores.slice(0, 3).entries()) {
    const candidate = element("span", emotion && index === 0 ? "intent-pill-primary" : `intent-item${index === 0 ? " primary" : ""}`);
    if (emotion && index === 0) {
      const face = window.Kaomoji.pick(item, messageId);
      if (face) candidate.appendChild(element("span", "kaomoji-mood", face));
    }
    candidate.appendChild(element("span", "intent-name", String(item.label).trim()));
    candidate.appendChild(element("span", "intent-pct", percent(item.probability)));
    line.appendChild(candidate);
  }
  container.appendChild(line);
}
function appendIntentLine(container, candidates) {
  if (!candidates.length) return;
  const line = element("div", "intent-line intent-score-line");
  line.appendChild(element("span", "intent-label", "意图"));
  for (const [index, candidate] of candidates.slice(0, 3).entries()) {
    const item = element("span", `intent-item${index === 0 ? " primary" : ""}`);
    item.appendChild(element("span", "intent-name", candidate.label));
    if (candidate.probability !== null) {
      item.appendChild(element("span", "intent-pct", percent(candidate.probability)));
    }
    line.appendChild(item);
  }
  container.appendChild(line);
}
function clearInlineIntentPending() {
  inlineIntentPending.clear();
  inlineIntentJobId = null;
}
function startInlineIntentPending(window) {
  for (const message of uncoveredMessages(window)) {
    const id = String(message.id);
    inlineIntentPending.set(id, message.text);
  }
  inlineIntentJobId = null;
  refreshLabels();
}
function settleInlineIntentPending(job) {
  if (!inlineIntentPending.size) return;
  let changed = false;
  const visible = new Map(messages.map(message => [String(message.id), message]));
  const recentFinished = !!inlineIntentJobId && job?.recent?.id === inlineIntentJobId &&
    ["done", "error"].includes(job.recent.status);
  const jobFailed = job?.status === "error" && !["queued", "running"].includes(job.recent?.status);
  const terminal = recentFinished || jobFailed;
  for (const [id, pendingText] of inlineIntentPending) {
    const state = fineMessageResult(results[id]) ? results[id].state : null;
    if (terminal || state === "skipped" ||
        (state === "done" && results[id]?.labelSchema === CURRENT_LABEL_SCHEMA) ||
        visible.get(id)?.text !== pendingText) {
      inlineIntentPending.delete(id);
      changed = true;
    }
  }
  if (terminal || !inlineIntentPending.size) inlineIntentJobId = null;
  if (changed) refreshLabels();
}
function updateLabel(message, node) {
  const wrap = node.querySelector(".msg-content-wrap");
  const result = results[message.id];
  const eligible = settings.intent && message.side === "other" && message.kind === "text" &&
    typeof message.text === "string" && !!message.text.trim();
  const pendingText = inlineIntentPending.get(String(message.id));
  const pending = eligible && !historyState && pendingText === message.text &&
    !(fineMessageResult(result) && (result.state === "skipped" ||
      result.state === "done" && result.labelSchema === CURRENT_LABEL_SCHEMA));
  const signature = pending ? "pending" : eligible && fineMessageResult(result) && result.state === "done" ?
    JSON.stringify([result.emotion, result.intentBroad, result.intent, result.groundedIntent,
      result.labelSchema, catalogReady, catalogLabelRevision]) : "";
  if (node.dataset.analysisSignature === signature) return;
  const revealing = signature !== "pending" && !!wrap.querySelector(".inline-intent-pending");
  node.querySelector(".msg-avatar-column .msg-mood")?.remove();
  wrap.querySelector(".inline-expression-row")?.remove();
  wrap.querySelector(".inline-intent-row")?.remove();
  wrap.querySelector(".inline-intent-pending")?.remove();
  node.dataset.analysisSignature = signature;
  if (!signature) return;
  if (signature === "pending") {
    wrap.appendChild(element("div", "inline-intent-pending", "分析中"));
    return;
  }
  const row = element("div", "inline-intent-row");
  appendScoreLine(row, "情绪", rankedEmotionScores(result.emotion), message.id, true);
  appendIntentLine(row, result.labelSchema === CURRENT_LABEL_SCHEMA
    ? displayedIntent(result, message.text)
    : hasIntentContent(message.text) ? [{ label: "待判断", probability: null }] : []);
  if (row.childNodes.length) {
    if (revealing) row.classList.add("inline-intent-revealed");
    wrap.appendChild(row);
  }
}
function messageNode(message) {
  const session = sessions.get(currentUser);
  const item = element("div", `msg-item ${message.side === "self" ? "outgoing" : "incoming"}`);
  item.dataset.messageId = String(message.id);
  const avatarColumn = element("div", "msg-avatar-column");
  avatarColumn.appendChild(message.side === "self" ? avatar(self?.avatar, "msg-avatar", self?.avatarCandidates, self?.name || "我") : avatar(message.senderAvatar || (session?.isGroup ? null : session?.avatar), "msg-avatar", message.senderAvatarCandidates || (session?.isGroup ? [] : session?.avatarCandidates), message.senderName || session?.name || message.senderId, session?.isGroup && !message.senderId));
  item.appendChild(avatarColumn);
  const wrap = element("div", "msg-content-wrap");
  if (session?.isGroup && message.side !== "self") wrap.appendChild(element("span", "msg-sender", message.senderName || message.senderId || "未知成员"));
  wrap.appendChild(element("div", "msg-bubble", message.kind === "image" ? "[图片]" :
    message.kind === "text" ? message.text || "" : message.text || "[不支持的消息]"));
  item.appendChild(wrap);
  updateLabel(message, item);
  return item;
}
function renderMessages(next, restoreScroll = null, historyAnchor = null) {
  const container = byId("chatMessages");
  const oldIds = messages.map(message => String(message.id));
  const nextIds = next.map(message => String(message.id));
  const appendOnly = oldIds.length && oldIds.length <= nextIds.length && oldIds.every((id, index) => id === nextIds[index] && JSON.stringify(messages[index]) === JSON.stringify(next[index])) && container.querySelectorAll(".msg-item").length === oldIds.length;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  followLatest = historyAnchor ? false : restoreScroll ? restoreScroll.followLatest : atBottom || !oldIds.length;
  const scroll = container.scrollTop;
  const anchor = !atBottom && !appendOnly ? [...container.querySelectorAll(".msg-item")].find(node => node.getBoundingClientRect().bottom >= container.getBoundingClientRect().top) : null;
  const anchorId = anchor?.dataset.messageId;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : 0;
  const start = appendOnly ? oldIds.length : 0;
  if (!appendOnly) container.replaceChildren();
  if (!byId("replyPrediction").hidden) clearReplyPrediction();
  messages = next;
  updatePredictReplyAvailability();
  for (let index = start; index < next.length; index++) {
    const message = next[index];
    const previous = next[index - 1];
    if (!previous || Number(message.time) - Number(previous.time) > 300000) {
      const row = element("div", "msg-time-row");
      row.appendChild(element("span", "msg-time", time(message.time)));
      container.appendChild(row);
    }
    container.appendChild(messageNode(message));
  }
  if (!next.length) status(container, "暂无消息");
  else if (historyAnchor) {
    const anchor = [...container.querySelectorAll(".msg-item")].find(node => node.dataset.messageId === historyAnchor.id);
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - historyAnchor.top;
    lastChatScrollTop = container.scrollTop;
  } else if (restoreScroll) {
    const token = generation;
    const user = currentUser;
    requestAnimationFrame(() => {
      if (token !== generation || user !== currentUser || view !== "chat") return;
      container.scrollTop = restoreScroll.followLatest ? container.scrollHeight : restoreScroll.scrollTop;
      lastChatScrollTop = container.scrollTop;
    });
  } else if (atBottom || !oldIds.length) scrollToLatest();
  else if (anchorId && !appendOnly) {
    const replacement = [...container.querySelectorAll(".msg-item")].find(node => node.dataset.messageId === anchorId);
    container.scrollTop = replacement ? scroll + replacement.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorOffset : scroll;
  } else container.scrollTop = scroll;
  renderMood();
  updateHistoryNavigation();
}
function scrollToLatest() {
  followLatest = true;
  const token = generation;
  const user = currentUser;
  requestAnimationFrame(() => { if (view === "chat" && token === generation && user === currentUser) { const container = byId("chatMessages"); container.scrollTop = container.scrollHeight; } });
}
function refreshLabels() {
  const container = byId("chatMessages");
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const nodes = new Map([...byId("chatMessages").querySelectorAll(".msg-item")].map(node => [node.dataset.messageId, node]));
  for (const message of messages) if (nodes.has(String(message.id))) updateLabel(message, nodes.get(String(message.id)));
  if (!byId("replyPrediction").hidden) placeReplyPrediction(false);
  if (atBottom && !historyState) scrollToLatest();
  renderMood();
}
function historyAnchor(fromEnd = false) {
  const container = byId("chatMessages");
  const bounds = container.getBoundingClientRect();
  const visible = [...container.querySelectorAll(".msg-item")].filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  const node = fromEnd ? visible.at(-1) : visible[0];
  return node ? { id: node.dataset.messageId, top: node.getBoundingClientRect().top - bounds.top } : null;
}
function updateHistoryNavigation() {
  const firstCursor = messages[0]?.historyCursor;
  const state = historyState;
  const container = byId("chatMessages");
  const atTop = container.scrollTop <= 80;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
  byId("historyNavigation").hidden = !currentUser || !(firstCursor || state);
  byId("btnHistoryEarlier").hidden = !firstCursor || state?.hasMoreBefore === false;
  byId("btnHistoryEarlier").disabled = !!historyController || !atTop;
  byId("btnHistoryEarlier").title = atTop ? "" : "滚动到顶部后加载";
  byId("btnHistoryNewer").hidden = !state?.hasMoreAfter;
  byId("btnHistoryNewer").disabled = !!historyController || !atBottom;
  byId("btnHistoryNewer").title = atBottom ? "" : "滚动到底部后加载";
  byId("btnReturnLatest").hidden = !state;
  text("historyNavStatus", historyController ? "读取中…" : state?.error || "");
}
function cancelHistoryRequest() {
  historyRequest++;
  historyController?.abort();
  historyController = null;
}
function enterHistoryView() {
  if (historyState) return;
  clearTimeout(selectedAnalysisTimer);
  selectedAnalysisTimer = null;
  historyState = { beforeCursor: messages[0]?.historyCursor || null, hasMoreBefore: true, hasMoreAfter: false, error: "" };
  messageRequest++;
  messagePending = false;
  messageRefreshQueued = false;
  analysisGeneration++;
  followLatest = false;
  clearInlineIntentPending();
  refreshLabels();
  updateHistoryNavigation();
}
function historyResponseValid(data, account, user) {
  if (data?.account !== account || data?.user !== user || !Array.isArray(data.messages)) throw new Error("Invalid history response");
}
function historyUrl(account, user, key, cursor) {
  const params = new URLSearchParams({ account, user, limit: "80" });
  params.set(key, cursor);
  return `/api/history?${params}`;
}
async function loadOlderHistory() {
  if (!currentAccount || !currentUser || historyController || historyState?.hasMoreBefore === false) return;
  if (byId("chatMessages").scrollTop > 80) return;
  const initialCursor = historyState?.beforeCursor || messages[0]?.historyCursor;
  if (!initialCursor) return;
  enterHistoryView();
  const account = currentAccount, user = currentUser, token = generation, request = ++historyRequest;
  const controller = new AbortController();
  historyController = controller;
  historyState.error = "";
  updateHistoryNavigation();
  try {
    let before = initialCursor, data;
    for (;;) {
      data = await api(historyUrl(account, user, "before", before), {}, controller.signal);
      if (request !== historyRequest || token !== generation || account !== currentAccount || user !== currentUser) return;
      historyResponseValid(data, account, user);
      if (data.messages.length || !data.hasMoreBefore) break;
      if (!data.nextCursor || data.nextCursor === before) throw new Error("History cursor did not advance");
      before = data.nextCursor;
    }
    const existing = new Set(messages.map(message => String(message.id)));
    const older = data.messages.filter(message => !existing.has(String(message.id)));
    const combined = [...older, ...messages];
    const removedFromEnd = Math.max(0, combined.length - historyWindowLimit);
    const next = combined.slice(0, historyWindowLimit);
    const anchor = historyAnchor();
    results = visibleResults({ ...results, ...(data.results || {}) }, next);
    historyState.beforeCursor = data.nextCursor || older[0]?.historyCursor || before;
    historyState.hasMoreBefore = !!data.hasMoreBefore;
    historyState.hasMoreAfter ||= removedFromEnd > 0;
    if (older.length) renderMessages(next, null, anchor);
  } catch (error) {
    if (error.name !== "AbortError" && request === historyRequest && token === generation) historyState.error = "读取失败，请重试";
  } finally {
    if (request === historyRequest) {
      historyController = null;
      updateHistoryNavigation();
    }
  }
}
async function loadNewerHistory() {
  if (!historyState?.hasMoreAfter || historyController || !messages.length) return;
  const container = byId("chatMessages");
  if (container.scrollHeight - container.scrollTop - container.clientHeight > 80) return;
  const marker = messages.at(-1)?.historyCursor;
  if (!marker) return;
  const account = currentAccount, user = currentUser, token = generation, request = ++historyRequest;
  const controller = new AbortController();
  historyController = controller;
  historyState.error = "";
  updateHistoryNavigation();
  try {
    const data = await api(historyUrl(account, user, "around", marker), {}, controller.signal);
    if (request !== historyRequest || token !== generation || account !== currentAccount || user !== currentUser) return;
    historyResponseValid(data, account, user);
    const position = data.messages.findIndex(message => message.historyCursor === marker);
    if (position < 0) throw new Error("History anchor missing");
    const existing = new Set(messages.map(message => String(message.id)));
    const newer = data.messages.slice(position + 1).filter(message => !existing.has(String(message.id)));
    const combined = [...messages, ...newer];
    const removedFromStart = Math.max(0, combined.length - historyWindowLimit);
    const next = combined.slice(removedFromStart);
    const anchor = historyAnchor(true);
    results = visibleResults({ ...results, ...(data.results || {}) }, next);
    historyState.hasMoreBefore ||= removedFromStart > 0;
    historyState.beforeCursor = next[0]?.historyCursor || historyState.beforeCursor;
    historyState.hasMoreAfter = !!data.hasMoreAfter && newer.length > 0;
    if (newer.length) renderMessages(next, null, anchor);
  } catch (error) {
    if (error.name !== "AbortError" && request === historyRequest && token === generation) historyState.error = "读取失败，请重试";
  } finally {
    if (request === historyRequest) {
      historyController = null;
      updateHistoryNavigation();
    }
  }
}
async function jumpToHistory(cursor, messageId) {
  if (!currentAccount || !currentUser || !cursor) return;
  const previous = historyState;
  enterHistoryView();
  cancelHistoryRequest();
  const account = currentAccount, user = currentUser, token = generation, request = ++historyRequest;
  const controller = new AbortController();
  historyController = controller;
  historyState.error = "";
  updateHistoryNavigation();
  try {
    const data = await api(historyUrl(account, user, "around", cursor), {}, controller.signal);
    if (request !== historyRequest || token !== generation || account !== currentAccount || user !== currentUser) return;
    historyResponseValid(data, account, user);
    const target = data.messages.find(message => String(message.id) === String(messageId));
    if (!target) throw new Error("History target missing");
    historyState = { beforeCursor: data.nextCursor || data.messages[0]?.historyCursor || null,
      hasMoreBefore: !!data.hasMoreBefore, hasMoreAfter: !!data.hasMoreAfter, error: "" };
    results = visibleResults(data.results || {}, data.messages);
    renderMessages(data.messages, null, { id: String(messageId), top: byId("chatMessages").clientHeight / 2 });
    const hit = [...byId("chatMessages").querySelectorAll(".msg-item")].find(node => node.dataset.messageId === String(messageId));
    hit?.classList.add("history-hit");
    setTimeout(() => hit?.classList.remove("history-hit"), 2500);
  } catch (error) {
    if (error.name !== "AbortError" && request === historyRequest && token === generation) {
      historyState = previous;
      if (!previous) void loadMessages(token, true);
      toast("记录定位失败，请重试");
    }
  } finally {
    if (request === historyRequest) {
      historyController = null;
      updateHistoryNavigation();
    }
  }
}
function returnToLatest() {
  if (!historyState) return;
  cancelHistoryRequest();
  historyState = null;
  const cached = sessionCache.get(sessionCacheKey(currentAccount, currentUser));
  results = visibleResults(cached?.results || {}, cached?.messages || []);
  conversationMood = cached?.mood || null;
  if (Array.isArray(cached?.messages)) renderMessages(cached.messages, { followLatest: true, scrollTop: 0 });
  else status(byId("chatMessages"), "正在读取消息…");
  followLatest = true;
  updateHistoryNavigation();
  void loadMessages(generation, !Array.isArray(cached?.messages));
}
function cancelHistorySearch(showCancelled = false) {
  historySearchRequest++;
  historySearchController?.abort();
  historySearchController = null;
  historySearchPending = false;
  byId("btnRunHistorySearch").disabled = false;
  byId("btnCancelHistorySearch").hidden = true;
  if (showCancelled) text("historySearchStatus", "已取消");
}
function closeHistorySearch() {
  cancelHistorySearch();
  byId("historySearchPanel").hidden = true;
  byId("btnChatHistory").setAttribute("aria-expanded", "false");
}
function resetHistorySearch() {
  closeHistorySearch();
  byId("historyKeyword").value = "";
  byId("historyDate").value = "";
  byId("historySearchResults").replaceChildren();
  text("historySearchStatus", "");
  byId("btnHistoryPrevResults").hidden = true;
  byId("btnHistoryNextResults").hidden = true;
  historySearchPage = 0;
  historySearchPageStarts = [null];
  historySearchQuery = { q: "", date: "" };
}
function openHistorySearch() {
  if (!currentUser || !currentAccount) { toast("请先选择会话"); return; }
  byId("historySearchPanel").hidden = false;
  byId("btnChatHistory").setAttribute("aria-expanded", "true");
  byId("historyKeyword").focus();
}
function renderHistorySearchResults(items, pageIndex, hasMore) {
  const container = byId("historySearchResults");
  container.replaceChildren();
  for (const message of items) {
    if (!message?.historyCursor) continue;
    const button = element("button", "history-result");
    button.type = "button";
    const sender = message.side === "self" ? "我" : message.senderName || message.senderId || sessions.get(currentUser)?.name || "对方";
    button.appendChild(element("span", "history-result-meta", `${sender} · ${time(message.time)}`));
    button.appendChild(element("span", "history-result-text", message.text || "[非文字消息]"));
    button.addEventListener("click", () => {
      const cursor = message.historyCursor, id = message.id;
      closeHistorySearch();
      void jumpToHistory(cursor, id);
    });
    container.appendChild(button);
  }
  historySearchPage = pageIndex;
  byId("btnHistoryPrevResults").hidden = pageIndex === 0;
  byId("btnHistoryNextResults").hidden = !hasMore;
  text("historySearchStatus", items.length ? `第 ${pageIndex + 1} 页` : "没有找到记录");
  container.scrollTop = 0;
}
async function loadHistorySearchPage(pageIndex) {
  const cursor = historySearchPageStarts[pageIndex];
  if (pageIndex > 0 && !cursor || historySearchPending || !currentAccount || !currentUser) return;
  cancelHistorySearch();
  const account = currentAccount, user = currentUser, token = generation, request = ++historySearchRequest;
  const controller = new AbortController();
  historySearchController = controller;
  historySearchPending = true;
  byId("btnRunHistorySearch").disabled = true;
  byId("btnCancelHistorySearch").hidden = false;
  byId("btnHistoryPrevResults").hidden = true;
  byId("btnHistoryNextResults").hidden = true;
  text("historySearchStatus", "搜索中…");
  try {
    const found = [];
    let before = cursor || null, hasMore = true;
    while (!found.length && hasMore) {
      const params = new URLSearchParams({ account, user, limit: String(50 - found.length) });
      if (historySearchQuery.q) params.set("q", historySearchQuery.q);
      if (historySearchQuery.date) params.set("date", historySearchQuery.date);
      if (before) params.set("before", before);
      const data = await api(`/api/history/search?${params}`, {}, controller.signal);
      if (request !== historySearchRequest || token !== generation || account !== currentAccount || user !== currentUser) return;
      if (data.account !== account || data.user !== user || !Array.isArray(data.messages)) throw new Error("Invalid search response");
      found.push(...data.messages);
      hasMore = !!data.hasMore;
      if (hasMore && (!data.nextCursor || data.nextCursor === before)) throw new Error("Search cursor did not advance");
      before = data.nextCursor || null;
    }
    historySearchPageStarts[pageIndex + 1] = before;
    renderHistorySearchResults(found.slice(0, 50), pageIndex, hasMore);
  } catch (error) {
    if (error.name !== "AbortError" && request === historySearchRequest && token === generation) text("historySearchStatus", "搜索失败，请重试");
  } finally {
    if (request === historySearchRequest) {
      historySearchController = null;
      historySearchPending = false;
      byId("btnRunHistorySearch").disabled = false;
      byId("btnCancelHistorySearch").hidden = true;
    }
  }
}
function startHistorySearch() {
  const q = byId("historyKeyword").value.trim();
  const date = byId("historyDate").value;
  if (!q && !date) { text("historySearchStatus", "输入关键词或选择日期"); return; }
  cancelHistorySearch();
  historySearchQuery = { q, date };
  historySearchPageStarts = [null];
  historySearchPage = 0;
  byId("historySearchResults").replaceChildren();
  void loadHistorySearchPage(0);
}
function renderJob(job, settlePending = true) {
  if (!job) return;
  currentAnalysisJob = job;
  if (job.recent) currentRecentJob = job.recent;
  if (settlePending) settleInlineIntentPending(job);
  if (job.status === "error" && job.requested?.mode !== "recent") incrementalFailed = true;
  if (!manualRecentAwaitingPost) {
    if (job.recent?.status === "error") recentFailed = true;
    else if ((job.recent?.status === "done" || !job.recent && job.status === "done") && !uncoveredMessages().length) recentFailed = false;
  }
  renderRecentAction(job);
  const retry = incrementalFailed || recentFailed;
  byId("btnRetryAnalysis").hidden = !retry;
  byId("btnRetryProfile").hidden = !incrementalFailed;
  text("analysisStatus", "");
  byId("analysisStatus").title = "";
  updateProfileProgress();
}
function setIntentActionState(state) {
  if (intentActionState === state && state !== "idle") return;
  intentActionState = state;
  clearTimeout(intentFeedbackTimer);
  const button = byId("btnToggleIntent");
  button.textContent = !settings.intent ? "意图识别" : {
    idle: "意图识别", submitting: "正在提交…", queued: "识别排队中",
    running: "识别中…", done: "识别完成", error: "识别失败 · 重试"
  }[state];
  button.dataset.state = settings.intent ? state : "idle";
  if (settings.intent && ["submitting", "queued", "running"].includes(state)) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  if (state === "done") intentFeedbackTimer = setTimeout(() => {
    if (intentActionState === "done") setIntentActionState("idle");
  }, 2300);
}
function renderRecentAction(job) {
  if (!settings.intent || intentActionState === "idle" || manualRecentAwaitingPost) return;
  if (!job?.recent || manualRecentJobId && job.recent.id !== manualRecentJobId) return;
  const status = job.recent.status;
  if (["queued", "running", "done", "error"].includes(status)) setIntentActionState(status);
}
function submitManualRecent() {
  if (!settings.intent || !currentUser || !controller || historyState || recentPending ||
      ["queued", "running"].includes(currentRecentJob?.status)) return;
  if (!activeAnalysisScope) {
    manualRecentDeferred = true;
    return;
  }
  const window = fineWindow();
  if (!uncoveredMessages(window).length) return;
  recentFailed = false;
  manualRecentAwaitingPost = true;
  manualRecentJobId = null;
  analysisGeneration++;
  setIntentActionState("submitting");
  void analyzeRecent(currentUser, generation, controller.signal, fineWindowSignature(window), window.limit, window);
}
function fineWindow() {
  if (!messages.length) return { limit: 0, candidates: [] };
  const container = byId("chatMessages");
  const bounds = container.getBoundingClientRect();
  const positions = new Map(messages.map((message, index) => [String(message.id), index]));
  let first = -1;
  const pendingLatestScroll = followLatest && container.scrollHeight - container.scrollTop - container.clientHeight > 80;
  if (bounds.height > 0 && !pendingLatestScroll) for (const node of container.querySelectorAll(".msg-item")) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
    const index = positions.get(node.dataset.messageId);
    if (index !== undefined && (first < 0 || index < first)) first = index;
  }
  const limit = Math.min(80, first < 0 ? Math.min(12, messages.length) : messages.length - first);
  const candidates = messages.slice(-Math.max(1, limit)).filter(message => message.side === "other" &&
    message.kind === "text" && typeof message.text === "string" && message.text.trim());
  return { limit: Math.max(1, limit), candidates };
}
function analyzableMessages(window = fineWindow()) {
  return window.candidates;
}
function uncoveredMessages(window = fineWindow()) {
  return analyzableMessages(window).filter(message => {
    const result = fineMessageResult(results[message.id]) ? results[message.id] : null;
    return result?.state !== "skipped" &&
      !(result?.state === "done" && result.labelSchema === CURRENT_LABEL_SCHEMA);
  });
}
function fineWindowSignature(window) {
  return JSON.stringify([window.limit, analyzableMessages(window).map(message => [message.id, message.text])]);
}
function scheduleRecent(user, token, signal, changedOther) {
  if (!settings.intent || view !== "chat" || document.hidden || startupActive || !changedOther ||
      recentPending || recentFailed || !activeAnalysisScope) return;
  const window = fineWindow();
  if (!uncoveredMessages(window).length) return;
  const signature = fineWindowSignature(window);
  if (!requestedRecentSignatures.has(signature)) void analyzeRecent(user, token, signal, signature, window.limit, window);
}
function incrementalState(key) {
  let state = autoIncrementalState.get(key);
  if (!state) {
    state = { requestedSignature: null, bootstrapRequested: false, pending: false, queued: false, failed: false, networkFailed: false };
    autoIncrementalState.set(key, state);
  }
  return state;
}
async function startIncremental(user, token, signal, key, state) {
  if (state.pending) return;
  state.pending = true;
  let refresh = false;
  try {
    const data = await api("/api/analyze", { method: "POST", body: JSON.stringify({ user, mode: "incremental" }) }, signal);
    if (autoIncrementalState.get(key) !== state) return;
    state.failed = data.job?.status === "error";
    state.networkFailed = false;
    if (token === generation && key === activeAnalysisScope) {
      incrementalFailed = state.failed;
      renderJob(data.job);
      refresh = !state.failed;
    }
  } catch (error) {
    if (autoIncrementalState.get(key) !== state) return;
    if (error.name === "AbortError") {
      state.requestedSignature = null;
      state.bootstrapRequested = false;
      return;
    }
    if (token === generation && key === activeAnalysisScope && handleAccountBoundaryError(error)) return;
    state.failed = true;
    state.networkFailed = isNetworkFailure(error);
    if (token === generation && key === activeAnalysisScope) {
      incrementalFailed = true;
      renderJob({ status: "error", error: error.message });
    }
  } finally {
    state.pending = false;
    if (refresh && token === generation && key === activeAnalysisScope) void loadAnalysis(user, token, signal);
  }
}
function scheduleIncremental(user, token, signal, data, changed, signature) {
  const key = activeAnalysisScope;
  if (!key) return;
  const state = incrementalState(key);
  const job = data.job || { status: "idle", checkpointComplete: false };
  if (job.status === "error") {
    state.failed = true;
    incrementalFailed = true;
    return;
  }
  if (state.failed) return;
  if (state.pending || ["queued", "running"].includes(job.status)) {
    if (changed && signature !== state.requestedSignature) state.queued = true;
    return;
  }
  const checkpointNeeded = !state.bootstrapRequested || job.status === "idle";
  const newWindow = changed && signature !== state.requestedSignature;
  if (!checkpointNeeded && !newWindow && !state.queued) return;
  state.queued = false;
  state.bootstrapRequested = true;
  state.requestedSignature = signature;
  void startIncremental(user, token, signal, key, state);
}
async function loadAnalysis(user, token, signal) {
  if (historyState) return;
  const request = ++analysisGeneration;
  try {
    const data = await api(`/api/analysis?user=${encodeURIComponent(user)}`, {}, signal);
    if (token !== generation || request !== analysisGeneration || historyState) return;
    if (!acceptResponseAccount(data.account)) return;
    analysisNetworkFailed = false;
    const key = JSON.stringify([currentAccount, user, data.analysisVersion || "current"]);
    activeAnalysisScope = key;
    if (data.job?.status !== "error" && !autoIncrementalState.get(key)?.failed) incrementalFailed = false;
    const incoming = visibleResults(data.results || {}, messages);
    results = ["queued", "running"].includes(data.job?.status) ? { ...visibleResults(results, messages), ...incoming } : incoming;
    conversationMood = data.mood || null;
    cacheCurrentSession({ results, mood: conversationMood });
    refreshLabels();
    renderJob(data.job || { status: "idle", checkpointComplete: false });
    if (manualRecentDeferred) {
      manualRecentDeferred = false;
      submitManualRecent();
    } else scheduleRecent(user, token, signal, true);
    if (view === "persona" && !profilePending && (data.job?.status === "running" || data.job?.status === "done")) loadProfile(activeMember);
    return data;
  } catch (error) {
    if (error.name !== "AbortError" && token === generation && request === analysisGeneration) {
      if (handleAccountBoundaryError(error)) return;
      incrementalFailed = true;
      analysisNetworkFailed = isNetworkFailure(error);
      renderJob({ status: "error", error: `读取失败：${error.message}` });
      setStripStatus("分析读取失败，请重试");
    }
  }
}
async function analyzeRecent(user, token, signal, signature, limit, window) {
  if (recentPending || recentFailed) return;
  requestedRecentSignatures.add(signature);
  while (requestedRecentSignatures.size > 64) requestedRecentSignatures.delete(requestedRecentSignatures.values().next().value);
  recentPending = true;
  startInlineIntentPending(window);
  try {
    const data = await api("/api/analyze", { method: "POST", body: JSON.stringify({ user, mode: "recent", limit }) }, signal);
    if (token === generation) {
      recentNetworkFailed = false;
      if (manualRecentAwaitingPost) manualRecentJobId = data.job?.recent?.id || null;
      manualRecentAwaitingPost = false;
      inlineIntentJobId = data.job?.recent?.id || null;
      renderJob(data.job, false);
      await loadAnalysis(user, token, signal);
    }
  } catch (error) {
    if (error.name !== "AbortError" && token === generation) {
      manualRecentAwaitingPost = false;
      if (handleAccountBoundaryError(error)) return;
      recentFailed = true;
      recentNetworkFailed = isNetworkFailure(error);
      if (intentActionState !== "idle") setIntentActionState("error");
      clearInlineIntentPending();
      refreshLabels();
      byId("btnRetryAnalysis").hidden = false;
      updateProfileProgress();
      toast("分析失败，可重试");
    }
  }
  finally {
    if (token === generation) {
      recentPending = false;
    }
  }
}
async function loadMessages(token = generation, poll = false, refresh = false) {
  if (!currentUser || token !== generation || historyState) return;
  if (messagePending) {
    if (refresh) messageRefreshQueued = true;
    return;
  }
  messagePending = true;
  const request = ++messageRequest;
  const windowSerial = ++windowRequestSerial;
  const user = currentUser;
  const signal = controller.signal;
  try {
    const data = await api(`/api/messages?user=${encodeURIComponent(user)}&limit=80`, {}, signal);
    if (token !== generation || request !== messageRequest || historyState) return;
    if (!acceptResponseAccount(data.account)) return;
    if (!Array.isArray(data.messages)) throw new Error("Invalid messages response");
    const next = data.messages;
    const signature = JSON.stringify(next);
    const changed = signature !== JSON.stringify(messages);
    const previousOther = new Map(messages.filter(message => message.side === "other" && message.kind === "text")
      .map(message => [String(message.id), message.text]));
    const changedOther = next.some(message => message.side === "other" && message.kind === "text" &&
      typeof message.text === "string" && message.text.trim() && previousOther.get(String(message.id)) !== message.text);
    if (changed) results = unchangedMessageResults(messages, next, results);
    if (!poll || changed) renderMessages(next);
    cacheCurrentSession({ messages: next, results: visibleResults(results, next),
      summarySignature: sessionSummarySignature(sessions.get(user)), windowSerial });
    markSessionAsRead(user);
    renderSessions();
    const analysis = await loadAnalysis(user, token, signal);
    if (token === generation && request === messageRequest && !historyState && analysis) {
      scheduleIncremental(user, token, signal, analysis, changed, signature);
      scheduleRecent(user, token, signal, changedOther);
    }
  } catch (error) {
    if (error.name !== "AbortError" && token === generation && request === messageRequest) {
      if (handleAccountBoundaryError(error)) return;
      if (!poll) status(byId("chatMessages"), "消息读取失败，请重试", () => loadMessages(token));
      else text("stripStatusText", "消息读取失败，请重试");
    }
  } finally {
    if (token === generation && request === messageRequest) {
      messagePending = false;
      if (messageRefreshQueued) {
        messageRefreshQueued = false;
        void loadMessages(token, true);
      }
    }
  }
}
function switchSession(user, force = false) {
  if (!sessions.has(user)) return;
  try { localStorage.setItem(`last-conversation:${currentAccount}`, user); } catch {}
  markSessionAsRead(user);
  if (user === currentUser && !force) {
    renderSessions();
    return;
  }
  cacheCurrentSession({ scrollTop: historyState ? 0 : byId("chatMessages").scrollTop, followLatest: historyState ? true : followLatest });
  const cacheKey = sessionCacheKey(currentAccount, user);
  const cached = sessionCache.get(cacheKey);
  clearInlineIntentPending();
  clearTimeout(selectedAnalysisTimer);
  selectedAnalysisTimer = null;
  cancelHistoryRequest();
  historyState = null;
  resetHistorySearch();
  clearReplyPrediction();
  if (byId("btnPredictReply")) byId("btnPredictReply").disabled = true;
  controller?.abort();
  controller = new AbortController();
  generation++;
  analysisGeneration++;
  profileGeneration++;
  profilePending = false;
  messagePending = false;
  messageRefreshQueued = false;
  manualRecentAwaitingPost = false;
  manualRecentJobId = null;
  manualRecentDeferred = false;
  setIntentActionState("idle");
  recentPending = false;
  incrementalFailed = false;
  recentFailed = false;
  analysisNetworkFailed = false;
  recentNetworkFailed = false;
  requestedRecentSignatures.clear();
  activeMember = sessions.get(user)?.isGroup ? storedProfileSelections.get(sessionCacheKey(currentAccount, user)) || "" : "";
  groupMembers = [];
  renderedProfileKey = null;
  renderedProfileSignature = null;
  memberRenderedScope = null;
  activeAnalysisScope = null;
  currentAnalysisJob = null;
  currentRecentJob = null;
  currentUser = user;
  messages = [];
  results = visibleResults(cached?.results || {}, cached?.messages || []);
  conversationMood = cached?.mood || null;
  followLatest = cached?.followLatest ?? true;
  lastChatScrollTop = cached?.scrollTop || 0;
  byId("chatStatusPill").style.display = "none";
  byId("btnRetryAnalysis").hidden = true;
  byId("btnRetryProfile").hidden = true;
  text("analysisStatus", "");
  text("chatTitle", sessions.get(user).name || user);
  if (Array.isArray(cached?.messages)) renderMessages(cached.messages, cached);
  else status(byId("chatMessages"), "正在读取消息…");
  updateHistoryNavigation();
  let profileKey = profileCacheKey(currentAccount, user, activeMember);
  let cachedProfile = cachedProfileFor(currentAccount, user, activeMember);
  if (!cachedProfile && activeMember) {
    activeMember = "";
    profileKey = profileCacheKey(currentAccount, user, "");
    cachedProfile = cachedProfileFor(currentAccount, user, "");
  }
  if (cachedProfile) {
    renderProfile(cachedProfile);
    renderedProfileKey = profileKey;
    renderedProfileSignature = JSON.stringify(cachedProfile);
  } else clearProfileView(sessions.get(user).name || user);
  if (view === "persona") loadProfile(activeMember);
  renderSessions();
  const token = generation, account = currentAccount, signal = controller.signal;
  if (sessionWindowReady(account, sessions.get(user))) {
    selectedAnalysisTimer = setTimeout(async () => {
      selectedAnalysisTimer = null;
      if (token !== generation || account !== currentAccount || user !== currentUser || historyState) return;
      const analysis = await loadAnalysis(user, token, signal);
      if (analysis && token === generation && !historyState) scheduleIncremental(user, token, signal, analysis, false, JSON.stringify(messages));
    }, 120);
  } else void loadMessages(token, !!cached);
}
function switchView(target) {
  if (target !== "chat") clearReplyPrediction();
  view = target;
  byId("chatView").classList.toggle("active", target === "chat");
  byId("personaView").classList.toggle("active", target === "persona");
  byId("navChat").classList.toggle("active", target === "chat");
  byId("navPersona").classList.toggle("active", target === "persona");
  if (target === "persona") loadProfile(activeMember);
  else if (!historyState) scrollToLatest();
}
let activeMember = "";
let profilePending = false;
let groupMembers = [];
let renderedProfileKey = null;
let renderedProfileSignature = null;
let memberRenderedScope = null;
function profileCacheKey(account, user, member) {
  return JSON.stringify([account, user, member]);
}
const profileSnapshotStorageKey = "real-ui-profile-snapshots-v1";
const profileSelectionStorageKey = "real-ui-profile-selection-v1";
const profileSnapshotLimit = 128;
const profileSelectionLimit = 64;
const profileSnapshotMaxBytes = 1000000;
const profileSnapshotEncoder = new TextEncoder();
function storedArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
const storedProfileSnapshots = new Map();
for (const entry of storedArray(profileSnapshotStorageKey).slice(0, profileSnapshotLimit)) {
  try {
    const [account, user, member] = JSON.parse(entry.key);
    if (typeof account === "string" && account && typeof user === "string" && user &&
        typeof member === "string" && entry.profile?.account === account &&
        entry.profile.username === (member || user) &&
        Number.isFinite(entry.at)) {
      storedProfileSnapshots.set(entry.key, entry);
    }
  } catch { }
}
const storedProfileSelections = new Map();
for (const entry of storedArray(profileSelectionStorageKey).slice(0, profileSelectionLimit)) {
  try {
    const [account, user] = JSON.parse(entry.key);
    if (typeof account === "string" && account && typeof user === "string" && user &&
        typeof entry.member === "string") storedProfileSelections.set(entry.key, entry.member);
  } catch { }
}
function saveStoredProfiles() {
  const entries = [...storedProfileSnapshots.values()].sort((a, b) => b.at - a.at).slice(0, profileSnapshotLimit);
  while (entries.length && profileSnapshotEncoder.encode(JSON.stringify(entries)).byteLength > profileSnapshotMaxBytes) entries.pop();
  storedProfileSnapshots.clear();
  for (const entry of entries) storedProfileSnapshots.set(entry.key, entry);
  try { localStorage.setItem(profileSnapshotStorageKey, JSON.stringify(entries)); } catch { }
}
function saveStoredSelections() {
  const entries = [...storedProfileSelections].slice(-profileSelectionLimit).map(([key, member]) => ({ key, member }));
  try { localStorage.setItem(profileSelectionStorageKey, JSON.stringify(entries)); } catch { }
}
function rememberProfileMember(account, user, member) {
  if (!account || !user) return;
  const key = sessionCacheKey(account, user);
  if (storedProfileSelections.get(key) === member) return;
  storedProfileSelections.delete(key);
  storedProfileSelections.set(key, member);
  while (storedProfileSelections.size > profileSelectionLimit) storedProfileSelections.delete(storedProfileSelections.keys().next().value);
  saveStoredSelections();
}
function profileSnapshot(profile) {
  const stats = profile.stats || {};
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const avatarUrl = value => typeof value === "string" && value.length <= 512 && /^https?:\/\//i.test(value) ? value : "";
  const inference = profile.mbtiInference;
  return {
    account: profile.account, username: profile.username,
    name: String(profile.name || profile.username || "").slice(0, 128), isGroup: !!profile.isGroup,
    avatar: avatarUrl(profile.avatar), avatarCandidates: Array.isArray(profile.avatarCandidates) ?
      profile.avatarCandidates.map(avatarUrl).filter(Boolean).slice(0, 2) : [],
    stats: { messageCount: count(stats.messageCount), textCount: count(stats.textCount),
      analyzedCount: count(stats.analyzedCount), participantCount: count(stats.participantCount) },
    affinity: Number.isFinite(profile.affinity) ? profile.affinity : null,
    traits: Array.isArray(profile.traits) ? profile.traits.slice(0, 6).map(item => ({
      key: String(item.key || ""), label: String(item.label || "").slice(0, 24),
      val: Number(item.val), sampleCount: count(item.sampleCount) })) : [],
    keywords: Array.isArray(profile.keywords) ? profile.keywords.slice(0, 6).map(item => ({
      word: String(item.word || "").slice(0, 24), count: count(item.count) })) : [],
    summary: String(profile.summary || "").slice(0, 600),
    mbtiInference: inference && typeof inference === "object" ? {
      eligibleMessages: count(inference.eligibleMessages), minMessages: count(inference.minMessages) || 100,
      axes: inference.axes && typeof inference.axes === "object" ? Object.fromEntries(
        ["EI", "SN", "TF", "JP"].map(axis => [axis, inference.axes[axis] || {}])) : {}
    } : null,
    members: profile.isGroup && Array.isArray(profile.members) ? profile.members.slice(0, 64).map(item => ({
      id: String(item.id || "").slice(0, 256), name: String(item.name || item.id || "").slice(0, 64) })) : [],
    dataStatus: profile.dataStatus, analysisUnit: profile.analysisUnit,
    job: { status: "idle" }
  };
}
function cachedProfileFor(account, user, member) {
  const key = profileCacheKey(account, user, member);
  const stored = storedProfileSnapshots.get(key);
  const cached = profileCache.get(key) || stored?.profile;
  if (!cached || cached.account !== account || cached.username !== (member || user) ||
      !!cached.isGroup !== !!sessions.get(user)?.isGroup || !cached.stats ||
      !Array.isArray(cached.traits) || !Array.isArray(cached.keywords) ||
      !Array.isArray(cached.members)) return null;
  profileCache.set(key, cached);
  if (stored && Date.now() - stored.at > 5 * 60 * 1000) {
    storedProfileSnapshots.delete(key);
    storedProfileSnapshots.set(key, { ...stored, at: Date.now() });
    saveStoredProfiles();
  }
  return cached;
}
function rememberProfile(profile, account, user, member) {
  if (profile.account !== account || profile.username !== (member || user)) return;
  const key = profileCacheKey(account, user, member);
  const snapshot = profileSnapshot(profile);
  const previous = storedProfileSnapshots.get(key);
  if (previous && Date.now() - previous.at < 24 * 60 * 60 * 1000 &&
      JSON.stringify(previous.profile) === JSON.stringify(snapshot)) return;
  storedProfileSnapshots.delete(key);
  storedProfileSnapshots.set(key, { key, at: Date.now(), profile: snapshot });
  saveStoredProfiles();
}
function pruneStoredProfiles(account, nextSessions) {
  let changedProfiles = false, changedSelections = false;
  for (const key of storedProfileSnapshots.keys()) {
    const [cachedAccount, user] = JSON.parse(key);
    if (cachedAccount === account && !nextSessions.has(user)) { storedProfileSnapshots.delete(key); changedProfiles = true; }
  }
  for (const key of storedProfileSelections.keys()) {
    const [cachedAccount, user] = JSON.parse(key);
    if (cachedAccount === account && !nextSessions.has(user)) { storedProfileSelections.delete(key); changedSelections = true; }
  }
  if (changedProfiles) saveStoredProfiles();
  if (changedSelections) saveStoredSelections();
}
async function clearStoredProfilesForAccount(accountId) {
  const maps = [storedProfileSnapshots, storedProfileSelections, profileCache,
    profileRateSamples, sessionCache, autoIncrementalState];
  const storages = [localStorage];
  if (typeof sessionStorage !== "undefined") storages.push(sessionStorage);
  const accounts = new Set();
  if (typeof currentAccount === "string" && currentAccount) accounts.add(currentAccount);
  for (const map of maps) for (const key of map.keys()) {
    try {
      const [account] = JSON.parse(key);
      if (typeof account === "string" && account) accounts.add(account);
    } catch { }
  }
  for (const storage of storages) try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith("read-watermark:")) accounts.add(key.slice("read-watermark:".length));
      else if (key?.startsWith("last-conversation:")) accounts.add(key.slice("last-conversation:".length));
      else if (key?.startsWith("mbti-unlocked:")) accounts.add(key.slice("mbti-unlocked:".length).split(":", 1)[0]);
    }
  } catch { }
  const matching = new Set();
  for (const account of accounts) {
    const digest = await crypto.subtle.digest("SHA-256", profileSnapshotEncoder.encode(account));
    const id = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (id === accountId) matching.add(account);
  }
  for (const map of maps) for (const key of map.keys()) {
    try { if (matching.has(JSON.parse(key)[0])) map.delete(key); } catch { }
  }
  for (const account of matching) for (const storage of storages) try {
    storage.removeItem(`read-watermark:${account}`);
    storage.removeItem(`last-conversation:${account}`);
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(`mbti-unlocked:${account}:`)) storage.removeItem(key);
    }
  } catch { }
  saveStoredProfiles();
  saveStoredSelections();
  return matching;
}
const profileRateSamples = new Map();
function observeProfileRate(profile, key) {
  const count = Number(profile.stats?.analyzedCount);
  if (!Number.isFinite(count) || count < 0) return;
  const now = performance.now();
  let samples = profileRateSamples.get(key) || [];
  if (samples.length && (count < samples[samples.length - 1].count ||
      now - samples[samples.length - 1].at > 30000)) samples = [];
  samples.push({ at: now, count });
  // Retain the observation just before the window so a long model batch is not
  // mistaken for an instantaneous burst when its completed texts arrive together.
  while (samples.length > 2 && samples[1].at < now - 30000) samples.shift();
  profileRateSamples.delete(key);
  profileRateSamples.set(key, samples);
  while (profileRateSamples.size > 64) profileRateSamples.delete(profileRateSamples.keys().next().value);
}
function profileRateText() {
  const samples = profileRateSamples.get(profileCacheKey(currentAccount, currentUser, activeMember));
  if (!samples || samples.length < 2) return "— 条/秒";
  const first = samples[0], last = samples[samples.length - 1];
  const elapsed = (last.at - first.at) / 1000;
  return elapsed > 0 ? `${((last.count - first.count) / elapsed).toFixed(1)} 条/秒` : "— 条/秒";
}
function updateProfileProgress(profile = profileCache.get(profileCacheKey(currentAccount, currentUser, activeMember))) {
  const ownJob = profile?.job;
  const job = ownJob || (activeMember ? null : currentAnalysisJob);
  const profileFailed = ownJob ? ownJob.status === "error" :
    !activeMember && (incrementalFailed || job?.status === "error" && job.requested?.mode !== "recent");
  if (profile) {
    const analyzed = Number(profile.stats?.analyzedCount) || 0;
    const total = Number(profile.stats?.textCount) || 0;
    const partial = (profile.dataStatus && profile.dataStatus !== "analyzed") || analyzed < total || job?.checkpointComplete === false;
    text("stripConfidence", `${analyzed} / ${total} 条文本`);
    byId("stripConfidenceItem").style.display = profile.isGroup ? "none" : "";
    text("summaryBadge", analyzed ? partial ? "阶段性结果" : "基于聊天汇总" : "暂无分析结果");
  }
  byId("btnRetryProfile").hidden = !profileFailed;
  const active = status => status === "queued" || status === "running";
  let state = "";
  if (profileFailed) state = "分析失败，请重试";
  else if (active(job?.status)) state = profileRateText();
  else if (job?.checkpointComplete === false) state = "待继续";
  else if (profile && job?.checkpointComplete) state = "已完成";
  setStripStatus(state);
  if (state.endsWith("条/秒")) byId("stripStatusText").title = "最近30秒新增已分析文本的实际速率";
}
function clearProfileView(name = "正在读取画像…") {
  text("personaHeaderTitle", name);
  text("heroName", name);
  text("heroRelationBadge", "待分析");
  byId("heroAvatar").replaceChildren();
  byId("heroMbtiRow").hidden = true;
  text("heroArchetype", "");
  byId("heroArchetype").style.display = "none";
  byId("heroMetricBox").replaceChildren();
  text("heroMbti", "");
  byId("mbtiCard").hidden = true;
  text("mbtiScaleBadge", "待读取");
  byId("mbtiScalesList").replaceChildren();
  byId("mbtiSources").replaceChildren();
  byId("radarContainer").replaceChildren();
  byId("tagCloud").replaceChildren();
  text("botSummaryText", "");
  text("stripDbPath", "待读取");
  text("stripMsgCount", "待读取");
  text("stripConfidence", "");
  byId("stripConfidenceItem").style.display = "none";
  text("summaryBadge", "基于聊天汇总");
  setStripStatus("");
  byId("groupMemberTabs").replaceChildren();
  byId("groupMemberTabs").style.display = "none";
  memberRenderedScope = null;
  renderedProfileKey = null;
  renderedProfileSignature = null;
}
const preferenceAxes = [
  { key: "EI", left: "E", right: "I", meaning: "注意力与能量：外向互动 / 内向反思" },
  { key: "SN", left: "S", right: "N", meaning: "信息偏好：具体经验事实 / 模式与可能性" },
  { key: "TF", left: "T", right: "F", meaning: "决策偏好：客观逻辑原则 / 价值与对人的影响" },
  { key: "JP", left: "J", right: "P", meaning: "对外界的方式：结构收敛 / 保留选项、灵活探索" }
];
const officialSources = [
  "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
  "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs"
];
function renderMbti(profile) {
  const container = byId("mbtiScalesList");
  const sources = byId("mbtiSources");
  container.replaceChildren();
  sources.replaceChildren();
  const groupOverall = profile.isGroup && !activeMember;
  byId("mbtiCard").hidden = groupOverall;
  byId("heroMbtiRow").hidden = groupOverall;
  if (groupOverall) {
    text("heroMbti", "");
    return;
  }

  const inference = profile.mbtiInference;
  const eligible = Number(inference?.eligibleMessages) || 0;
  const minMessages = Number(inference?.minMessages) || 100;
  const axes = inference?.axes || {};
  const unlocked = isMbtiUnlocked();
  const validAxis = evidence => Number(evidence?.evidenceCount) > 0 &&
    Number.isFinite(evidence?.leftShare) && Number.isFinite(evidence?.rightShare) &&
    evidence.leftShare >= 0 && evidence.leftShare <= 1 &&
    evidence.rightShare >= 0 && evidence.rightShare <= 1;
  const validAxisCount = preferenceAxes.filter(axis => validAxis(axes[axis.key])).length;

  if (eligible < minMessages) {
    text("heroMbti", `${Math.max(0, eligible)}/${minMessages} 条`);
    text("mbtiScaleBadge", "未解锁");
    const lockPanel = element("div", "mbti-lock-panel");
    const iconWrap = element("div", "mbti-lock-icon-wrap");
    iconWrap.appendChild(svgIcon("M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z", "mbti-lock-icon"));
    lockPanel.appendChild(iconWrap);
    lockPanel.appendChild(element("div", "mbti-lock-title", "人格推测未解锁"));
    lockPanel.appendChild(element("div", "mbti-lock-desc", `需积累 ${minMessages} 条该人物有效文本以进行四维偏好推测`));
    const progWrap = element("div", "mbti-lock-progress-wrap");
    const progBar = element("div", "mbti-lock-progress-bar");
    const fill = element("div", "mbti-lock-progress-fill");
    fill.style.width = `${Math.min(100, Math.round(eligible / minMessages * 100))}%`;
    progBar.appendChild(fill);
    progWrap.appendChild(progBar);
    progWrap.appendChild(element("div", "mbti-lock-progress-text", `目标人物文本 ${eligible} / ${minMessages} 条`));
    lockPanel.appendChild(progWrap);
    const btn = element("button", "mbti-unlock-btn disabled", `积累 ${minMessages} 条后解锁`);
    btn.disabled = true;
    lockPanel.appendChild(btn);
    container.appendChild(lockPanel);
  } else if (!unlocked) {
    text("heroMbti", "可解锁");
    text("mbtiScaleBadge", "待解锁");
    const lockPanel = element("div", "mbti-lock-panel");
    const iconWrap = element("div", "mbti-lock-icon-wrap");
    iconWrap.appendChild(svgIcon("M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z", "mbti-lock-icon"));
    lockPanel.appendChild(iconWrap);
    lockPanel.appendChild(element("div", "mbti-lock-title", "人格推测已就绪"));
    lockPanel.appendChild(element("div", "mbti-lock-desc", "已积累足够聊天样本，点击下方按钮解锁"));
    const progWrap = element("div", "mbti-lock-progress-wrap");
    const progBar = element("div", "mbti-lock-progress-bar");
    const fill = element("div", "mbti-lock-progress-fill");
    fill.style.width = "100%";
    progBar.appendChild(fill);
    progWrap.appendChild(progBar);
    progWrap.appendChild(element("div", "mbti-lock-progress-text", `目标人物文本 ${eligible} / ${minMessages} 条 (已达标)`));
    lockPanel.appendChild(progWrap);
    const btn = element("button", "mbti-unlock-btn active", "解锁人格");
    btn.id = "btnUnlockMbti";
    btn.addEventListener("click", () => {
      unlockMbti();
      renderMbti(profile);
    });
    lockPanel.appendChild(btn);
    container.appendChild(lockPanel);
  } else {
    const inclination = preferenceAxes.map(axis => {
      const evidence = axes[axis.key];
      if (!validAxis(evidence) || evidence.leftShare === evidence.rightShare) return "?";
      return evidence.leftShare > evidence.rightShare ? axis.left : axis.right;
    }).join("");
    text("heroMbti", inclination);
    text("mbtiScaleBadge", inclination.includes("?") ? validAxisCount ? "部分维度待定" : "偏好证据待积累" : `${inclination} · 聊天倾向`);
    for (const axis of preferenceAxes) {
      const evidence = axes[axis.key];
      const row = element("div", "mbti-scale-row");
      row.appendChild(element("div", "mbti-scale-meta", axis.key));
      const leftShare = evidence?.leftShare;
      const rightShare = evidence?.rightShare;
      if (validAxis(evidence)) {
        row.appendChild(element("div", "mbti-axis-values", `${axis.left} ${Math.round(leftShare * 100)}% · ${axis.right} ${Math.round(rightShare * 100)}%`));
        const track = element("div", "mbti-track-wrap");
        const fill = element("div", "mbti-track-fill");
        fill.style.width = `${leftShare * 100}%`;
        track.appendChild(fill);
        row.appendChild(track);
      } else row.appendChild(element("div", "mbti-axis-empty", `${axis.left}/${axis.right} · 尚无足够证据`));
      container.appendChild(row);
    }
  }

  const provided = Array.isArray(inference?.sources) ? inference.sources : [];
  const urls = provided.filter(value => officialSources.includes(value));
  const details = element("details", "mbti-details");
  details.appendChild(element("summary", "", "依据与说明"));
  details.appendChild(element("div", "mbti-sample", `${eligible} 条目标文本 · ${minMessages} 条展示门槛`));
  for (const [index, url] of (urls.length ? urls : officialSources).entries()) {
    const link = element("a", "mbti-source", index ? "Myers & Briggs 官方资料" : "MBTI 官方偏好理论");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    details.appendChild(link);
  }
  details.appendChild(element("span", "mbti-source-note", "聊天证据推测，非标准量表。"));
  sources.appendChild(details);
}
function renderRadar(traits) {
  const container = byId("radarContainer");
  container.replaceChildren();
  const keys = ["socialEnergy", "humor", "composure", "initiative", "care", "affection"];
  const values = keys.map(key => Array.isArray(traits) ? traits.find(item => item?.key === key) : null);
  if (values.some(item => !item || !Number.isFinite(item.val) || item.val < 0 || item.val > 100)) {
    container.appendChild(element("div", "radar-empty", "暂无互动风格证据"));
    return;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 360 280");
  svg.setAttribute("class", "radar-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "六维互动风格雷达");
  const point = (index, radius) => {
    const angle = -Math.PI / 2 + index * Math.PI / 3;
    return `${(180 + Math.cos(angle) * radius).toFixed(1)},${(140 + Math.sin(angle) * radius).toFixed(1)}`;
  };
  const shape = (tag, className, points) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    node.setAttribute("class", className);
    node.setAttribute("points", points);
    svg.appendChild(node);
  };
  for (const radius of [25, 50, 75, 100]) shape("polygon", "radar-ring", keys.map((_, index) => point(index, radius)).join(" "));
  for (let index = 0; index < keys.length; index++) shape("polyline", "radar-axis", `180,140 ${point(index, 100)}`);
  shape("polygon", "radar-area", values.map((item, index) => point(index, item.val)).join(" "));
  values.forEach((item, index) => {
    const [x, y] = point(index, 100).split(",").map(Number);
    const side = index === 1 || index === 2 ? 1 : index === 4 || index === 5 ? -1 : 0;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "radar-label");
    label.setAttribute("x", String(x + side * 14));
    label.setAttribute("y", String(y + (index === 0 ? -18 : index === 3 ? 20 : 0)));
    label.setAttribute("text-anchor", side > 0 ? "start" : side < 0 ? "end" : "middle");
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = item.label;
    svg.appendChild(label);
  });
  const legend = element("div", "radar-values");
  for (const item of values) {
    const row = element("div", "radar-value");
    row.append(element("span", "", item.label), element("strong", "", `${Math.round(item.val)}`));
    legend.appendChild(row);
  }
  container.append(svg, legend);
}
function renderMembers(profile) {
  const members = byId("groupMemberTabs");
  const scope = `${currentUser}\u0000${activeMember}`;
  const previousSearch = members.querySelector(".member-search");
  const previousPicker = members.querySelector(".member-picker");
  const previous = scope === memberRenderedScope && previousSearch ? {
    open: previousPicker?.classList.contains("open"), query: previousSearch.value,
    start: previousSearch.selectionStart, end: previousSearch.selectionEnd,
    focused: document.activeElement === previousSearch,
    page: Number(previousPicker?.dataset.page) || 0
  } : null;
  members.replaceChildren();
  memberRenderedScope = profile.isGroup ? scope : null;
  members.style.display = profile.isGroup ? "flex" : "none";
  if (!profile.isGroup) return;
  if (Array.isArray(profile.members) && profile.members.length) groupMembers = profile.members;
  const overall = element("button", `member-chip${activeMember ? "" : " active"}`, "群整体");
  overall.type = "button";
  overall.addEventListener("click", () => { closeMemberPicker(); if (activeMember) void loadProfile(""); });
  members.appendChild(overall);
  if (activeMember) members.appendChild(element("span", "member-current", groupMembers.find(item => item.id === activeMember)?.name || profile.name || activeMember));
  const picker = element("div", "member-picker");
  const trigger = element("button", "member-picker-trigger", "选择成员");
  trigger.type = "button";
  trigger.setAttribute("aria-expanded", "false");
  const panel = element("div", "member-picker-panel");
  const search = element("input", "member-search");
  search.type = "search";
  search.placeholder = "搜索成员";
  search.setAttribute("aria-label", "搜索群成员");
  const list = element("div", "member-options");
  const pager = element("div", "member-pager");
  const previousPage = element("button", "member-page-btn", "上一页");
  const pageText = element("span", "member-page-text");
  const nextPage = element("button", "member-page-btn", "下一页");
  previousPage.type = nextPage.type = "button";
  pager.append(previousPage, pageText, nextPage);
  let page = previous?.page ?? Math.max(0, Math.floor(groupMembers.findIndex(item => item.id === activeMember) / 6));
  function renderPage() {
    const query = search.value.trim().toLowerCase();
    const filtered = groupMembers.filter(member => `${member.name || ""} ${member.id || ""}`.toLowerCase().includes(query));
    const pageCount = Math.max(1, Math.ceil(filtered.length / 6));
    page = Math.min(Math.max(0, page), pageCount - 1);
    picker.dataset.page = String(page);
    list.replaceChildren();
    for (const member of filtered.slice(page * 6, page * 6 + 6)) {
      const option = element("button", `member-option${member.id === activeMember ? " active" : ""}`, member.name || member.id);
      option.type = "button";
      option.addEventListener("click", () => { closeMemberPicker(); void loadProfile(member.id); });
      list.appendChild(option);
    }
    if (!filtered.length) list.appendChild(element("div", "member-empty", "没有匹配成员"));
    pager.hidden = pageCount <= 1;
    pageText.textContent = `${page + 1} / ${pageCount}`;
    previousPage.disabled = page === 0;
    nextPage.disabled = page >= pageCount - 1;
    list.scrollTop = 0;
  }
  search.addEventListener("input", () => { page = 0; renderPage(); });
  previousPage.addEventListener("click", () => { page--; renderPage(); });
  nextPage.addEventListener("click", () => { page++; renderPage(); });
  trigger.addEventListener("click", () => { const open = picker.classList.toggle("open"); trigger.setAttribute("aria-expanded", String(open)); if (open) search.focus(); });
  panel.append(search, list, pager);
  picker.append(trigger, panel);
  members.appendChild(picker);
  if (previous) {
    search.value = previous.query;
    picker.classList.toggle("open", !!previous.open);
    trigger.setAttribute("aria-expanded", String(!!previous.open));
    if (previous.focused && previous.open) {
      search.focus();
      search.setSelectionRange(previous.start, previous.end);
    }
  }
  renderPage();
}
function renderProfile(profile) {
  const group = !!profile.isGroup;
  text("personaHeaderTitle", profile.name || profile.username || "人物画像");
  text("heroName", profile.name || profile.username || "未知");
  setAvatar("heroAvatar", profile.avatar, profile.avatarCandidates, profile.name || profile.username, group && !activeMember);
  renderMbti(profile);
  byId("heroArchetype").style.display = "none";
  text("heroRelationBadge", group ? activeMember ? "群成员画像" : "群画像" : profile.affinity == null ? "好感待分析" : `好感 ${profile.affinity}`);
  const stats = profile.stats || {};
  text("stripDbPath", `${Number(stats.messageCount) || 0} 条消息 · ${Number(stats.participantCount) || 0} 人参与`);
  text("stripMsgCount", `${Number(stats.textCount) || 0} 条文本`);
  updateProfileProgress(profile);
  const metric = byId("heroMetricBox");
  metric.replaceChildren();
  if (group) {
    const grid = element("div", "group-activity-grid");
    for (const [label, value] of [["参与人数", stats.participantCount], ["消息数", stats.messageCount], ["文本消息", stats.textCount], ["已分析文本", `${Number(stats.analyzedCount) || 0} / ${Number(stats.textCount) || 0}`]]) {
      const card = element("div", "group-stat-card");
      card.append(element("span", "group-stat-label", label), element("span", "group-stat-val", value));
      grid.appendChild(card);
    }
    metric.appendChild(grid);
  } else {
    const score = profile.affinity;
    const header = element("div", "game-favor-header");
    header.append(element("div", "game-favor-title-wrap", "♥ 好感度等级"), element("div", "game-favor-score", score == null ? "待分析" : String(score)));
    metric.appendChild(header);
    if (typeof score === "number" && score >= 0 && score <= 100) {
      const names = ["素昧平生", "泛泛之交", "初识相知", "友善默契", "亲密无间"];
      const level = Math.min(5, Math.floor(score / 20) + 1);
      const track = element("div", "favor-heart-track");
      names.forEach((name, index) => {
        const stage = index + 1;
        const node = element("div", `heart-stage-node${stage <= level ? " unlocked" : ""}${stage === level ? " current" : ""}`);
        node.append(element("div", "heart-icon-wrap", stage === level ? "❤️" : stage < level ? "💖" : "🤍"), element("span", "heart-stage-name", name));
        track.appendChild(node);
      });
      const progress = element("div", "game-favor-progress-wrap");
      const bar = element("div", "game-favor-progress-bar");
      const fill = element("div", "game-favor-progress-fill");
      fill.style.width = `${score}%`;
      bar.appendChild(fill);
      progress.appendChild(bar);
      metric.append(track, progress);
    }
  }
  renderRadar(profile.traits);
  const tags = byId("tagCloud");
  tags.replaceChildren();
  for (const keyword of (profile.keywords || []).map((value, index) => ({ value, index })).sort((left, right) => (Number(right.value.count) || 0) - (Number(left.value.count) || 0) || left.index - right.index).slice(0, 6).map(item => item.value)) {
    const tag = element("span", "keyword-tag", keyword.word);
    tag.appendChild(element("span", "tag-count", ` ${keyword.count}`));
    tags.appendChild(tag);
  }
  if (!tags.childNodes.length) tags.textContent = "暂无关键词";
  text("botSummaryText", profile.summary || "暂无摘要");
  renderMembers(profile);
}
async function loadProfile(member = "", retry = false) {
  if (!currentUser) return;
  const token = ++profileGeneration;
  const account = currentAccount;
  const user = currentUser;
  const key = profileCacheKey(account, user, member);
  const previousMember = activeMember;
  activeMember = member;
  if (sessions.get(user)?.isGroup) rememberProfileMember(account, user, member);
  if (key !== renderedProfileKey) {
    const cached = cachedProfileFor(account, user, member);
    if (cached) {
      renderProfile(cached);
      renderedProfileKey = key;
      renderedProfileSignature = JSON.stringify(cached);
    } else {
      const members = previousMember !== member ? groupMembers : null;
      clearProfileView(sessions.get(user)?.name || user);
      if (members) groupMembers = members;
    }
  }
  profilePending = true;
  if (key !== renderedProfileKey) setStripStatus("");
  try {
    const data = await api(`/api/profile?user=${encodeURIComponent(user)}${member ? `&member=${encodeURIComponent(member)}` : ""}${retry ? "&retry=1" : ""}`, {}, controller.signal);
    if (token === profileGeneration && account === currentAccount && user === currentUser && member === activeMember) {
      if (!acceptResponseAccount(data.account)) return;
      observeProfileRate(data, key);
      const signature = JSON.stringify(data);
      if (key !== renderedProfileKey || signature !== renderedProfileSignature) {
        const previous = profileCache.get(key);
        try { renderProfile(data); }
        catch (error) {
          if (previous && renderedProfileKey === key) {
            try { renderProfile(previous); } catch { }
          }
          console.error("画像显示失败", error);
          setStripStatus("画像显示失败");
          return;
        }
        renderedProfileKey = key;
        renderedProfileSignature = signature;
      }
      profileCache.set(key, data);
      rememberProfile(data, account, user, member);
      updateProfileProgress(data);
      if (currentAnalysisJob) renderJob(currentAnalysisJob);
    }
  } catch (error) {
    if (error.name !== "AbortError" && token === profileGeneration) {
      if (handleAccountBoundaryError(error)) return;
      const hasVisibleProfile = renderedProfileKey === key && profileCache.has(key);
      setStripStatus(hasVisibleProfile ? "画像刷新失败" : "画像读取失败，请重试");
      if (!hasVisibleProfile) status(byId("heroMetricBox"), "画像读取失败", () => loadProfile(member));
    }
  } finally { if (token === profileGeneration) profilePending = false; }
}
function applySettings() {
  document.body.classList.toggle("theme-light", settings.theme === "light");
  document.documentElement.classList.toggle("desktop-host", !!window.desktopHost);
  document.documentElement.style.zoom = settings.zoom;
  document.documentElement.style.setProperty("--zoom-inverse", String(1 / Number(settings.zoom)));
  window.desktopHost?.setTheme?.(settings.theme);
  byId("selectThemeMode").value = settings.theme;
  byId("selectZoomLevel").value = settings.zoom;
  byId("btnToggleIntent").classList.toggle("active", settings.intent);
  byId("btnToggleIntent").setAttribute("aria-pressed", String(settings.intent));
  refreshLabels();
}
let runtimeSnapshot = null;
let runtimeRequest = 0;
let runtimeBusy = false;
let runtimePollTimer = null;
function validRuntime(data) {
  return data && ["cpu", "gpu"].includes(data.requestedProvider) &&
    [null, "cpu", "webgpu"].includes(data.modelProvider) &&
    ["ready", "loading", "idle", "error"].includes(data.status) &&
    (data.status !== "ready" || data.modelProvider !== null);
}
function showRuntime(data) {
  runtimeSnapshot = data;
  byId("selectRuntimeProvider").value = data.requestedProvider;
  const actual = data.modelProvider === "webgpu" ? "GPU" : data.modelProvider === "cpu" ? "CPU" : "";
  text("runtimeStatus", data.status === "ready" ? `当前 ${actual}` :
    data.status === "loading" ? "正在加载…" : data.status === "error" ? "加载失败" : "待加载");
  clearTimeout(runtimePollTimer);
  if (data.status === "loading" && byId("settingsModal").classList.contains("show"))
    runtimePollTimer = setTimeout(() => { void loadRuntime(); }, 1500);
}
async function loadRuntime() {
  if (runtimeBusy) return;
  const request = ++runtimeRequest;
  const select = byId("selectRuntimeProvider");
  select.disabled = true;
  text("runtimeStatus", "读取中…");
  try {
    const data = await api("/api/runtime");
    if (request !== runtimeRequest) return;
    if (!validRuntime(data)) throw new Error("运行状态无效");
    showRuntime(data);
  } catch {
    if (request === runtimeRequest) text("runtimeStatus", "读取失败");
  } finally {
    if (request === runtimeRequest) select.disabled = !runtimeSnapshot;
  }
}
async function changeRuntime(provider) {
  const select = byId("selectRuntimeProvider");
  const previous = runtimeSnapshot?.requestedProvider;
  if (!previous || runtimeBusy || !["cpu", "gpu"].includes(provider)) {
    if (previous) select.value = previous;
    return;
  }
  runtimeBusy = true;
  const request = ++runtimeRequest;
  clearTimeout(runtimePollTimer);
  select.disabled = true;
  text("runtimeStatus", "正在切换…");
  try {
    const data = await api("/api/runtime", { method: "POST", body: JSON.stringify({ provider }) });
    if (request !== runtimeRequest) return;
    if (!validRuntime(data) || data.requestedProvider !== provider || data.status === "error") throw new Error("切换失败");
    showRuntime(data);
  } catch {
    if (request === runtimeRequest) {
      select.value = previous;
      text("runtimeStatus", "切换失败");
    }
  } finally {
    runtimeBusy = false;
    if (request === runtimeRequest) select.disabled = false;
  }
}
let managedAccounts = [];
let managedCurrentAccountId = null;
let selectedManagedAccountId = null;
let pendingDeleteAccountId = null;
let accountManagerRequest = 0;
let accountDeleteBusy = false;
let accountManagementOpen = false;
function managedAccountIsCurrent(account) {
  return !!account && (account.current || account.accountId === managedCurrentAccountId);
}
function renderManagedAccounts() {
  const list = byId("accountList");
  list.replaceChildren();
  if (!managedAccounts.length) status(list, "暂无已保存账号");
  for (const account of managedAccounts) {
    const row = element("div", "account-row");
    const item = element("button", `account-item${account.accountId === selectedManagedAccountId ? " active" : ""}`);
    item.type = "button";
    item.setAttribute("aria-pressed", String(account.accountId === selectedManagedAccountId));
    item.appendChild(element("span", "account-wechat-id", account.wechatId));
    if (managedAccountIsCurrent(account)) item.appendChild(element("span", "account-current", "正在使用"));
    item.addEventListener("click", () => {
      if (accountDeleteBusy) return;
      selectedManagedAccountId = account.accountId;
      pendingDeleteAccountId = null;
      byId("accountDeleteConfirm").hidden = true;
      text("accountManagerStatus", managedAccountIsCurrent(account) ? "正在使用" : "");
      renderManagedAccounts();
    });
    row.appendChild(item);
    if (accountManagementOpen) {
      const clear = element("button", "settings-danger-btn account-clear-btn", "清除");
      clear.type = "button";
      clear.disabled = accountDeleteBusy;
      clear.title = "清除本软件中的账号数据";
      clear.addEventListener("click", () => {
        if (clear.disabled) return;
        selectedManagedAccountId = account.accountId;
        pendingDeleteAccountId = account.accountId;
        text("accountDeleteQuestion", `清除账号 ${account.wechatId} 在本软件中的聊天记录副本、分析与画像、运行缓存？微信原始记录不会删除。${managedAccountIsCurrent(account) ? "若清除时仍为当前账号，软件将退出；下次启动重新初始化。" : "若清除时仍非当前账号，软件继续运行。"}`);
        text("btnConfirmDeleteAccount", managedAccountIsCurrent(account) ? "清除并退出" : "确认清除");
        byId("accountDeleteConfirm").hidden = false;
        renderManagedAccounts();
      });
      row.appendChild(clear);
    }
    list.appendChild(row);
  }
}
async function loadAccounts() {
  if (accountDeleteBusy) return;
  const request = ++accountManagerRequest;
  status(byId("accountList"), "正在读取账号…");
  try {
    const data = await api("/api/accounts");
    if (request !== accountManagerRequest) return;
    if (!Array.isArray(data.accounts) || !data.accounts.every(account => account &&
      typeof account.accountId === "string" && account.accountId &&
      typeof account.wechatId === "string" && account.wechatId && typeof account.current === "boolean") ||
      !(data.currentAccountId === null || typeof data.currentAccountId === "string") ||
      new Set(data.accounts.map(account => account.accountId)).size !== data.accounts.length) throw new Error("账号列表无效");
    managedAccounts = data.accounts;
    managedCurrentAccountId = data.currentAccountId;
    if (!managedAccounts.some(account => account.accountId === selectedManagedAccountId)) selectedManagedAccountId = null;
    pendingDeleteAccountId = null;
    byId("accountDeleteConfirm").hidden = true;
    renderManagedAccounts();
    text("accountManagerStatus", "");
  } catch (error) {
    if (request !== accountManagerRequest) return;
    managedAccounts = [];
    managedCurrentAccountId = null;
    selectedManagedAccountId = null;
    pendingDeleteAccountId = null;
    byId("accountDeleteConfirm").hidden = true;
    status(byId("accountList"), "账号读取失败", () => { void loadAccounts(); });
    text("accountManagerStatus", error.message);
  }
}
function closeSettingsModal() {
  byId("settingsModal").classList.remove("show");
  clearTimeout(runtimePollTimer);
  accountManagementOpen = false;
  text("btnToggleAccountManagement", "管理");
  byId("btnToggleAccountManagement").setAttribute("aria-pressed", "false");
  pendingDeleteAccountId = null;
  byId("accountDeleteConfirm").hidden = true;
  renderManagedAccounts();
}
async function deleteManagedAccount() {
  const account = managedAccounts.find(item => item.accountId === pendingDeleteAccountId);
  if (!account || accountDeleteBusy) return;
  const accountId = account.accountId;
  accountDeleteBusy = true;
  byId("btnConfirmDeleteAccount").disabled = true;
  renderManagedAccounts();
  text("accountManagerStatus", "正在删除…");
  try {
    const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    let data = null;
    try { data = await response.json(); } catch { }
    if (!response.ok) throw new Error(typeof data?.message === "string" && data.message ? data.message :
      typeof data?.error === "string" && data.error ? data.error : `删除失败（HTTP ${response.status}）`);
    if (data?.deleted !== accountId) throw new Error("删除结果不匹配");
    const exitAfterDelete = data.exitApp === true || data.current === true;
    if (exitAfterDelete) {
      accountClearedExiting = true;
      sessionRequest++;
      generation++;
      profileGeneration++;
      analysisGeneration++;
      controller?.abort();
      currentUser = null;
    }
    let cacheCleared = true;
    try { await clearStoredProfilesForAccount(accountId); }
    catch { cacheCleared = false; }
    if (exitAfterDelete) {
      resetAccountView(cacheCleared ? "账号数据已清除，正在退出…" : "账号已清除，本地缓存清理失败，请关闭软件", true);
      clearTimeout(startupWatchdog);
      byId("startupRetry").hidden = true;
      byId("startupContinue").hidden = true;
      text("accountManagerStatus", cacheCleared ? "已清除，正在退出…" : "账号已清除，本地缓存清理失败");
      try {
        if (typeof window.desktopHost?.exitApp !== "function") throw new Error("exitApp unavailable");
        await window.desktopHost.exitApp();
      } catch { text("startupStatus", "账号已清除，请关闭软件。"); }
      return;
    }
    selectedManagedAccountId = null;
    pendingDeleteAccountId = null;
    byId("accountDeleteConfirm").hidden = true;
    accountDeleteBusy = false;
    await loadAccounts();
    text("accountManagerStatus", cacheCleared ? "已清除" : "账号已清除，本地画像缓存清理失败");
    void loadSessions();
  } catch (error) {
    text("accountManagerStatus", error.message);
  } finally {
    accountDeleteBusy = false;
    byId("btnConfirmDeleteAccount").disabled = false;
    if (!accountClearedExiting) renderManagedAccounts();
  }
}
async function copyDraft() {
  const value = byId("chatInput").value;
  if (!value.trim()) return;
  let copied = false;
  if (window.desktopHost?.copyDraft) {
    try { copied = await window.desktopHost.copyDraft(value); } catch { }
  }
  if (!copied && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); copied = true; } catch { }
  }
  if (!copied) {
    const input = byId("chatInput");
    const focus = document.activeElement;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    try {
      input.focus();
      input.select();
      copied = document.execCommand("copy");
    } catch { }
    finally {
      input.setSelectionRange(start, end);
      if (focus && focus !== input && typeof focus.focus === "function") focus.focus();
    }
  }
  toast(copied ? "草稿已复制，未发送到微信" : "复制失败，请手动复制草稿");
}
byId("searchInput").addEventListener("input", renderSessions);
byId("chatMessages").addEventListener("scroll", event => {
  const container = event.currentTarget;
  if (historyState) {
    followLatest = false;
    lastChatScrollTop = container.scrollTop;
    updateHistoryNavigation();
    return;
  }
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 80) followLatest = true;
  else if (container.scrollTop < lastChatScrollTop - 1) followLatest = false;
  lastChatScrollTop = container.scrollTop;
  updateHistoryNavigation();
});
byId("btnHistoryEarlier").addEventListener("click", () => void loadOlderHistory());
byId("btnHistoryNewer").addEventListener("click", () => void loadNewerHistory());
byId("btnReturnLatest").addEventListener("click", returnToLatest);
byId("btnChatHistory").addEventListener("click", () => byId("historySearchPanel").hidden ? openHistorySearch() : closeHistorySearch());
byId("btnCloseHistorySearch").addEventListener("click", closeHistorySearch);
byId("historySearchForm").addEventListener("submit", event => { event.preventDefault(); startHistorySearch(); });
byId("btnCancelHistorySearch").addEventListener("click", () => cancelHistorySearch(true));
byId("btnHistoryPrevResults").addEventListener("click", () => void loadHistorySearchPage(historySearchPage - 1));
byId("btnHistoryNextResults").addEventListener("click", () => void loadHistorySearchPage(historySearchPage + 1));
byId("btnSend").addEventListener("click", copyDraft);
byId("chatInput").addEventListener("input", () => {
  byId("btnSend").classList.toggle("ready", !!byId("chatInput").value.trim());
  if (!byId("replyPrediction").hidden) clearReplyPrediction();
});
byId("btnPredictReply")?.addEventListener("click", () => {
  closeSettingsModal();
  switchView("chat");
  void requestReplyPrediction();
});
byId("btnClosePrediction").addEventListener("click", clearReplyPrediction);
byId("chatInput").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); copyDraft(); } });
byId("navChat").addEventListener("click", () => switchView("chat"));
byId("navPersona").addEventListener("click", () => switchView("persona"));
byId("btnToolbarPersona").addEventListener("click", () => switchView("persona"));
byId("btnBackToChat").addEventListener("click", () => switchView("chat"));
function retryAnalysis() {
  if (!currentUser || !controller) return;
  const key = activeAnalysisScope || JSON.stringify([currentAccount, currentUser, "current"]);
  const state = incrementalState(key);
  if (state.pending) return;
  byId("btnRetryAnalysis").hidden = true;
  byId("btnRetryProfile").hidden = true;
  setStripStatus("");
  text("analysisStatus", "");
  recentFailed = false;
  incrementalFailed = false;
  activeAnalysisScope = key;
  state.failed = false;
  state.queued = false;
  state.bootstrapRequested = true;
  state.requestedSignature = JSON.stringify(messages);
  void startIncremental(currentUser, generation, controller.signal, key, state);
}
byId("btnRetryAnalysis").addEventListener("click", retryAnalysis);
byId("btnRetryProfile").addEventListener("click", () => {
  if (view === "persona" && activeMember) void loadProfile(activeMember, true);
  else retryAnalysis();
});
byId("btnToggleIntent").addEventListener("click", () => {
  settings.intent = !settings.intent;
  save();
  if (!settings.intent) {
    manualRecentDeferred = false;
    setIntentActionState("idle");
  }
  applySettings();
  if (settings.intent) submitManualRecent();
});
for (const [id, key] of [["selectThemeMode", "theme"], ["selectZoomLevel", "zoom"]]) byId(id).addEventListener("change", event => { settings[key] = event.target.value; save(); applySettings(); });
byId("selectRuntimeProvider").addEventListener("change", event => { void changeRuntime(event.target.value); });
const OFFICIAL_RELEASES_URL = "https://github.com/tswawa/WechatVibe/releases";
const UPDATE_BUSY_PHASES = new Set(["downloading", "verifying", "extracting", "installing", "restarting"]);
let aboutVersionPromise = null;
let versionLoadFailed = false;
let updateState = { phase: "idle" };
let updateStateSequence = 0;
let updateCheckPending = false;
let updateActionPending = false;
let updateOperationStatus = "";
let updateCheckedOnce = false;
let updatePreviousFocus = null;

function displayVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
}
function setDisplayedVersion(value) {
  const version = displayVersion(value);
  if (!version) return;
  text("aboutCurrentVersion", version);
  text("updateCurrentVersion", version);
  byId("btnAboutVersion").setAttribute("aria-label", `查看软件更新，当前版本 ${version}`);
}
function loadAboutVersion() {
  if (aboutVersionPromise) return aboutVersionPromise;
  if (typeof window.desktopHost?.getAppVersion !== "function") {
    text("aboutCurrentVersion", "--");
    text("updateCurrentVersion", "--");
    text("updateStatus", "仅桌面版可用");
    return Promise.resolve();
  }
  aboutVersionPromise = window.desktopHost.getAppVersion().then(version => {
    if (!displayVersion(version)) throw new Error("Invalid app version");
    versionLoadFailed = false;
    setDisplayedVersion(version);
  }).catch(() => {
    versionLoadFailed = true;
    text("aboutCurrentVersion", "读取失败");
    text("updateCurrentVersion", "读取失败");
    renderUpdateState();
    aboutVersionPromise = null;
  });
  return aboutVersionPromise;
}
function officialReleaseUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (url.href === OFFICIAL_RELEASES_URL) return url.href;
  } catch { }
  return OFFICIAL_RELEASES_URL;
}
function updatePhase(state) {
  return typeof state?.phase === "string" ? state.phase :
    (typeof state?.status === "string" ? state.status : "");
}
function updateStatusMessage(state) {
  const latest = displayVersion(state.latestVersion);
  const error = typeof state.error === "string" ? state.error.trim().slice(0, 180) : "";
  return {
    idle: "准备检查更新",
    current: "已是最新版本",
    "preview-current": "已是最新版本",
    available: latest ? `发现新版本 ${latest}` : "发现新版本",
    downloading: "正在下载更新",
    verifying: "正在校验更新包",
    extracting: "正在解压更新包",
    ready: "更新已下载，准备安装",
    installing: "正在安装更新",
    restarting: "正在重启",
    rolled_back: "已回退到上一版本",
    failed: error ? `更新失败：${error}` : "更新失败，请重试",
    "incomplete-release": latest ? `发现 ${latest}，发布文件尚未齐全` : "发布文件尚未齐全",
    "no-release": "暂无正式发布版本",
    "invalid-current": "当前版本信息异常",
    "invalid-release": "发布信息异常，请稍后重试",
    "rate-limited": "检查次数受限，请稍后重试",
    timeout: "检查超时，请重试",
    offline: "网络不可用，请重试",
    "server-error": "暂时无法检查更新",
  }[updatePhase(state)] || "暂时无法检查更新";
}
function renderUpdateState() {
  const phase = updatePhase(updateState);
  const latest = displayVersion(updateState.latestVersion);
  byId("updateLatestRow").hidden = !latest;
  text("updateLatestVersion", latest);
  text("updateStatus", updateCheckPending ? "正在检查更新" :
    (updateOperationStatus || (!window.desktopHost ? "仅桌面版可用" :
      (versionLoadFailed && phase === "idle" ? "版本读取失败" : updateStatusMessage(updateState)))));
  byId("updateReleaseLink").href = officialReleaseUrl(updateState.releaseUrl);

  const downloading = phase === "downloading";
  const downloaded = Number(updateState.downloadedBytes);
  const total = Number(updateState.totalBytes);
  byId("updateProgress").hidden = !downloading;
  if (downloading) {
    const knownTotal = Number.isFinite(total) && total > 0;
    const safeDownloaded = Number.isFinite(downloaded) ? Math.max(0, downloaded) : 0;
    const percent = knownTotal ? Math.min(100, Math.round(safeDownloaded / total * 100)) : 0;
    const bar = byId("updateProgressBar");
    bar.classList.toggle("indeterminate", !knownTotal);
    if (knownTotal) bar.setAttribute("aria-valuenow", String(percent));
    else bar.removeAttribute("aria-valuenow");
    byId("updateProgressFill").style.width = `${percent}%`;
    text("updateProgressText", knownTotal ? `${percent}%` : `${(safeDownloaded / 1048576).toFixed(1)} MB`);
  }

  const canRollback = !!displayVersion(updateState.rollbackVersion) &&
    typeof window.desktopHost?.rollbackUpdate === "function";
  byId("updateRollback").hidden = !canRollback;
  text("updateRollbackVersion", displayVersion(updateState.rollbackVersion));
  byId("btnRollbackUpdate").disabled = updateActionPending || updateCheckPending || UPDATE_BUSY_PHASES.has(phase);

  const canCheck = typeof window.desktopHost?.checkForUpdates === "function";
  byId("btnCheckUpdates").disabled = !canCheck || updateCheckPending || updateActionPending ||
    UPDATE_BUSY_PHASES.has(phase) || phase === "ready";
  const canBegin = typeof window.desktopHost?.beginUpdate === "function" &&
    (phase === "available" || phase === "ready");
  byId("btnBeginUpdate").hidden = !canBegin;
  byId("btnBeginUpdate").disabled = updateCheckPending || updateActionPending;
  text("btnBeginUpdate", phase === "ready" ? "立即安装" : "下载并安装");
}
function applyUpdateState(next) {
  if (!updatePhase(next)) return false;
  updateState = { ...updateState, ...next, phase: updatePhase(next) };
  updateOperationStatus = "";
  updateStateSequence++;
  renderUpdateState();
  return true;
}
async function checkForUpdates() {
  if (updateCheckPending || updateActionPending || typeof window.desktopHost?.checkForUpdates !== "function" ||
      UPDATE_BUSY_PHASES.has(updatePhase(updateState))) return;
  updateCheckedOnce = true;
  updateCheckPending = true;
  renderUpdateState();
  const before = updateStateSequence;
  try {
    const result = await window.desktopHost.checkForUpdates();
    if (before === updateStateSequence) applyUpdateState(result);
  } catch {
    if (before === updateStateSequence) applyUpdateState({ phase: "server-error" });
  } finally {
    updateCheckPending = false;
    renderUpdateState();
  }
}
async function refreshUpdateState() {
  if (typeof window.desktopHost?.getUpdateState === "function") {
    const before = updateStateSequence;
    try {
      const state = await window.desktopHost.getUpdateState();
      if (before === updateStateSequence) applyUpdateState(state);
    } catch { /* The check action remains available. */ }
  }
  if (!updateCheckedOnce && ["idle", "current", "preview-current"].includes(updatePhase(updateState)))
    void checkForUpdates();
}
function openUpdateModal() {
  updatePreviousFocus = document.activeElement;
  byId("updateModal").classList.add("show");
  byId("btnCloseUpdate").focus();
  void loadAboutVersion();
  void refreshUpdateState();
  renderUpdateState();
}
function closeUpdateModal() {
  byId("updateModal").classList.remove("show");
  if (updatePreviousFocus?.isConnected) updatePreviousFocus.focus();
}
byId("btnAboutVersion").addEventListener("click", openUpdateModal);
byId("btnCloseUpdate").addEventListener("click", closeUpdateModal);
byId("updateModal").addEventListener("click", event => { if (event.target === byId("updateModal")) closeUpdateModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && byId("updateModal").classList.contains("show")) closeUpdateModal(); });
window.addEventListener("wechatvibe-update-state", event => { applyUpdateState(event.detail); });
byId("btnCheckUpdates").addEventListener("click", () => { void checkForUpdates(); });
byId("btnBeginUpdate").addEventListener("click", async () => {
  if (updateActionPending || !["available", "ready"].includes(updatePhase(updateState))) return;
  updateActionPending = true;
  updateOperationStatus = updatePhase(updateState) === "ready" ? "正在安装更新" : "正在启动更新";
  renderUpdateState();
  const before = updateStateSequence;
  try {
    const result = await window.desktopHost.beginUpdate();
    if (result === false) throw new Error("更新未启动");
    if (before === updateStateSequence && !applyUpdateState(result)) void refreshUpdateState();
  } catch (error) {
    if (before === updateStateSequence) applyUpdateState({ phase: "failed", error: error?.message || "请重试" });
  } finally {
    updateActionPending = false;
    updateOperationStatus = "";
    renderUpdateState();
  }
});
byId("btnRollbackUpdate").addEventListener("click", async () => {
  if (updateActionPending || !updateState.rollbackVersion ||
      typeof window.desktopHost?.rollbackUpdate !== "function") return;
  updateActionPending = true;
  updateOperationStatus = "正在回退版本";
  renderUpdateState();
  const before = updateStateSequence;
  try {
    const result = await window.desktopHost.rollbackUpdate();
    if (result === false) throw new Error("回退未启动");
    if (before === updateStateSequence && !applyUpdateState(result)) void refreshUpdateState();
  } catch (error) {
    if (before === updateStateSequence) applyUpdateState({ phase: "failed", error: error?.message || "回退失败" });
  } finally {
    updateActionPending = false;
    updateOperationStatus = "";
    renderUpdateState();
  }
});
void loadAboutVersion();
renderUpdateState();
byId("btnSettings").addEventListener("click", () => {
  byId("settingsModal").classList.add("show");
  void loadRuntime();
});
byId("btnCloseSettings").addEventListener("click", closeSettingsModal);
byId("settingsModal").addEventListener("click", event => { if (event.target === byId("settingsModal")) closeSettingsModal(); });
byId("btnManageAccounts").addEventListener("click", () => {
  const panel = byId("accountManager");
  panel.hidden = !panel.hidden;
  byId("settingsModal").querySelector(".settings-modal-card").classList.toggle("account-open", !panel.hidden);
  text("btnManageAccounts", panel.hidden ? "查看账号" : "收起");
  if (!panel.hidden) void loadAccounts();
});
byId("btnRefreshAccounts").addEventListener("click", () => { void loadAccounts(); });
byId("btnToggleAccountManagement").addEventListener("click", () => {
  accountManagementOpen = !accountManagementOpen;
  text("btnToggleAccountManagement", accountManagementOpen ? "完成" : "管理");
  byId("btnToggleAccountManagement").setAttribute("aria-pressed", String(accountManagementOpen));
  if (!accountManagementOpen) {
    pendingDeleteAccountId = null;
    byId("accountDeleteConfirm").hidden = true;
  }
  renderManagedAccounts();
});
byId("btnCancelDeleteAccount").addEventListener("click", () => {
  pendingDeleteAccountId = null;
  byId("accountDeleteConfirm").hidden = true;
});
byId("btnConfirmDeleteAccount").addEventListener("click", () => { void deleteManagedAccount(); });
document.querySelectorAll(".settings-tab-btn").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".settings-tab-btn").forEach(node => node.classList.toggle("active", node === tab));
  document.querySelectorAll(".settings-panel").forEach(node => node.classList.toggle("active", node.id === ({ general: "panelGeneral", about: "panelAbout" })[tab.dataset.tab]));
  byId("settingsModal").querySelector(".settings-modal-card").classList.toggle("account-open", tab.dataset.tab === "general" && !byId("accountManager").hidden);
  if (tab.dataset.tab === "about") void loadAboutVersion();
}));
byId("btnEmoji").addEventListener("click", event => { event.stopPropagation(); byId("emojiPopover").classList.toggle("show"); });
document.querySelectorAll(".popover-tab").forEach(tab => tab.addEventListener("click", event => {
  event.stopPropagation();
  document.querySelectorAll(".popover-tab").forEach(node => node.classList.toggle("active", node === tab));
  byId("emojiGrid").classList.toggle("active", tab.dataset.tab === "emoji");
  byId("kaomojiGrid").classList.toggle("active", tab.dataset.tab === "kaomoji");
}));
function insertKaomoji(value) {
  const input = byId("chatInput");
  input.setRangeText(value, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input"));
  input.focus();
  byId("emojiPopover").classList.remove("show");
}
document.querySelectorAll(".emoji-btn").forEach(button => button.addEventListener("click", () => insertKaomoji(button.textContent)));
byId("kaomojiGrid").addEventListener("click", event => {
  const button = event.target.closest(".kaomoji-btn");
  if (button) insertKaomoji(button.textContent);
});
function renderKaomojiPanel() {
  const grid = byId("kaomojiGrid");
  grid.replaceChildren();
  for (const group of window.Kaomoji.panelItems()) {
    const section = element("section", "kaomoji-category");
    section.appendChild(element("div", "kaomoji-category-title", group.category));
    const items = element("div", "kaomoji-category-items");
    for (const item of group.items) for (const variant of item.variants) {
      const button = element("button", "kaomoji-btn", variant);
      button.type = "button";
      button.title = item.label;
      items.appendChild(button);
    }
    section.appendChild(items);
    grid.appendChild(section);
  }
}
async function loadCatalog() {
  try {
    const response = await fetch("data/analysis-catalog.json", { cache: "no-store" });
    if (!response.ok) return;
    const catalog = await response.json();
    const coverage = window.Kaomoji.installCatalog(catalog);
    if (coverage.missing.length) { console.error("Missing canonical kaomoji mapping:", coverage.missing); return; }
    const addAlias = (map, alias, display) => {
      const key = intentAlias(alias);
      if (!key || !display) return;
      if (!map.has(key)) map.set(key, display);
      else if (map.get(key) !== display) map.set(key, null);
    };
    const legacyIntentAliases = new Map();
    for (const [alias, display] of Object.entries(catalog.legacyIntentLabels || {})) {
      addAlias(legacyIntentAliases, alias, String(display || "").trim());
    }
    const canonicalIntentAliases = new Map();
    for (const entry of catalog.intents || []) {
      const display = String(entry.displayLabel || entry.label || "").trim();
      for (const alias of [entry.id, entry.modelLabel, entry.label, display]) {
        addAlias(canonicalIntentAliases, alias, display);
      }
    }
    const legacyEmotionAliases = new Map();
    const canonicalEmotionAliases = new Map();
    for (const entry of catalog.emotions || []) {
      const display = String(entry.label || "").trim();
      for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
        addAlias(legacyEmotionAliases, alias, display);
      }
      for (const alias of [entry.id, entry.modelLabel, display]) {
        addAlias(canonicalEmotionAliases, alias, display);
      }
    }
    intentDisplayAliases = new Map([...legacyIntentAliases, ...canonicalIntentAliases]);
    emotionDisplayAliases = new Map([...legacyEmotionAliases, ...canonicalEmotionAliases]);
    catalogLabelRevision = String(catalog.labelRevision || catalog.intentDisplayVersion || catalog.version || "");
    catalogReady = true;
    renderKaomojiPanel();
    refreshLabels();
    if (view === "persona") loadProfile(activeMember);
  } catch { }
}
document.addEventListener("click", event => { if (!event.target.closest("#emojiPopover, #btnEmoji")) byId("emojiPopover").classList.remove("show"); });
function closeMemberPicker() {
  byId("groupMemberTabs").querySelector(".member-picker")?.classList.remove("open");
  byId("groupMemberTabs").querySelector(".member-picker-trigger")?.setAttribute("aria-expanded", "false");
}
document.addEventListener("click", event => { if (!event.target.closest("#groupMemberTabs")) closeMemberPicker(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") { closeMemberPicker(); closeHistorySearch(); byId("emojiPopover").classList.remove("show"); } });
renderKaomojiPanel();
applySettings();
loadCatalog();
setInterval(() => { if (!catalogReady && !document.hidden) loadCatalog(); }, 30000);
async function startInitialLoad() {
  const attempt = ++startupAttempt;
  clearTimeout(startupAccountRetryTimer);
  startupAccountRetryTimer = null;
  startupAccountRetryUsed = false;
  showStartup("account", "正在连接当前微信账号…");
  let healthReady = false;
  try {
    const data = await api("/api/health");
    if (attempt !== startupAttempt || !startupActive) return;
    healthReady = data.data?.state === "ready";
    if (data.data?.state === "error") setStripStatus("数据源不可用");
  } catch { }
  if (attempt !== startupAttempt || !startupActive) return;
  showStartup(healthReady ? "sessions" : "account", healthReady ? "正在读取会话列表…" : "正在确认当前微信账号…");
  void loadSessions();
}
byId("startupRetry").addEventListener("click", retryStartup);
byId("startupContinue").addEventListener("click", () => { if (startupActive && accountUnavailable) completeStartup(); });
const updateValidationMode = window.desktopHost?.updateValidationMode === true;
const updateFinalReadyMode = window.desktopHost?.updateFinalReadyMode === true;
let updateCommitReady = !updateFinalReadyMode;
if (updateValidationMode) {
  // The updater checks that this script and its desktop bridge actually run
  // before opening a writable chat session in the new installation.
  byId("startupOverlay").classList.add("update-validation");
  text("startupStatus", "正在验证新版本…");
  void window.desktopHost.reportUiReady().catch(() => {});
} else if (updateFinalReadyMode) {
  text("startupStatus", "正在完成更新…");
  void window.desktopHost.reportUiReady().then(ready => {
    if (!ready) return;
    updateCommitReady = true;
    void startInitialLoad();
  }).catch(() => {});
} else {
  void startInitialLoad();
}
window.addEventListener("wechatvibe-service-restored", () => {
  if (updateValidationMode || !updateCommitReady) return;
  // A new bridge has no in-memory jobs, even if the earlier POST succeeded.
  // Keep all saved UI/results and let the persisted server cursor resume the job.
  autoIncrementalState.clear();
  requestedRecentSignatures.clear();
  incrementalFailed = analysisNetworkFailed = recentFailed = recentNetworkFailed = false;
  if (byId("settingsModal").classList.contains("show")) void loadRuntime();
  void loadSessions();
  if (currentUser && controller) {
    const member = activeMember;
    if (!historyState) switchSession(currentUser, true);
    else void loadProfile(member);
  }
});
if (!updateValidationMode) {
  setInterval(() => { if (updateCommitReady && currentUser && !document.hidden) loadMessages(generation, true); }, 4000);
  setInterval(() => { if (updateCommitReady && !document.hidden) loadSessions(); }, 15000);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden || updateValidationMode || !updateCommitReady) return;
  void loadSessions();
  if (currentUser) void loadMessages(generation, true, true);
  if (currentUser && view === "persona") void loadProfile(activeMember);
});
