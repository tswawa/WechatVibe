"use strict";

(function () {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value, limit) => typeof value === "string" && value.length <= limit;
  const terminal = new Set(["done", "error", "stopped", "cancelled"]);
  const byId = id => document.getElementById(id);
  const agentName = byId("agentName"), agentMenu = byId("agentMenu"), menuButton = byId("btnAgentMenu");
  const modelName = byId("modelName"), modelMenu = byId("modelMenu"), modelButton = byId("btnModelMenu");
  const newThread = byId("btnNewThread"), newThreadLabel = byId("newThreadLabel");
  const historyButton = byId("btnHistory"), historyMenu = byId("historyMenu");
  const timeline = byId("advisorTimeline"), welcome = byId("advisorWelcome"), welcomeText = byId("welcomeText");
  const input = byId("advisorInput"), send = byId("btnAdvisorSend"), stop = byId("btnStopRun"), retry = byId("btnRetryRun");
  const note = byId("advisorComposerNote");
  const controls = byId("timelineControls");
  let sessionNonce = null, scope = null, templates = [], catalogReady = false, engineState = "unknown";
  let threadId = null, renderedScope = "", currentRun = null, submitting = false, stopping = false, retryKind = "load", problem = "";
  let runSteps = [], stepRunId = "";
  let lastSavedMessage = null;
  let templateSignature = "";
  let modelProfiles = [], assistantProfileId = "", analysisLabel = "", modelSignature = "";
  let modelPending = false, modelPendingTimer = 0, modelsLoaded = false;
  let newThreadConfirm = false, newThreadTimer = 0;
  let threads = [], activeThreadId = "", threadsError = "";
  const messageNodes = new Map();
  function transientMessage(message) {
    if (message.role !== "status") return false;
    return message.status === "reasoning" || message.event?.type === "reasoning" ||
      ["busy", "preparing", "running", "answering", "generating", "thinking", "reading", "compacting", "compressing", "retry"].includes(message.event?.state) ||
      /^(正在生成|正在回答|正在思考|发送中|正在停止|已停止生成|已停止)$/.test(message.text.trim());
  }
  function validScope(value) {
    return object(value) && text(value.account, 240) && text(value.user, 240) && text(value.agentId, 240) &&
      Number.isSafeInteger(value.generation) && value.generation >= 0;
  }
  function sameScope(value) {
    return scope && value.account === scope.account && value.user === scope.user &&
      value.agentId === scope.agentId && value.generation === scope.generation;
  }
  function sendToParent(type, payload = {}) {
    if (sessionNonce && scope) window.parent.postMessage({ envelope: "advisor", nonce: sessionNonce, type, payload, scope }, "*");
  }
  function paintText(container, content, live) {
    if (typeof window.AdvisorTimeline?.renderInto === "function") {
      window.AdvisorTimeline.renderInto(container, content, live);
    } else container.textContent = content;
  }
  function disposeNode(node) {
    window.AdvisorTimeline?.disposeInto?.(node.bubble);
    node.wrap.remove();
  }
  function makeMessage(message) {
    const wrap = document.createElement("div"), bubble = document.createElement("div");
    wrap.className = `advisor-msg ${message.role}`; wrap.dataset.msgId = message.id;
    bubble.className = "advisor-bubble"; wrap.appendChild(bubble);
    return { wrap, bubble };
  }
  function updateMessage(message, live = false) {
    let node = messageNodes.get(message.id);
    if (!node) { node = makeMessage(message); messageNodes.set(message.id, node); }
    node.wrap.dataset.delivery = message.delivery || "";
    if (message.role === "user") node.wrap.title = message.delivery === "failed" ? "发送失败，可重试" : message.delivery === "pending" ? "正在提交" : "";
    const stateKey = message.role === "status" ? JSON.stringify(message.event || { state: message.status }) : "";
    if (node.bubble.dataset.rawText !== message.text || node.bubble.dataset.live !== String(live) || node.bubble.dataset.stateKey !== stateKey) {
      node.bubble.dataset.rawText = message.text; node.bubble.dataset.live = String(live);
      node.bubble.dataset.stateKey = stateKey;
      if (message.role === "assistant") paintText(node.bubble, message.text, live);
      else if (message.role === "status" && typeof window.AdvisorTimeline?.statusInto === "function") {
        window.AdvisorTimeline.statusInto(node.bubble, message.event || { text: message.text, state: message.status });
      } else node.bubble.textContent = message.text;
    }
    return node.wrap;
  }
  function statusRow(id, content, kind = "status", event) {
    if (!content) {
      const node = messageNodes.get(id); if (node) disposeNode(node); messageNodes.delete(id); return;
    }
    const row = updateMessage({ id, role: "status", text: content, status: kind, event }); row.dataset.status = kind;
    if (id === "ui:run") { row.classList.add("advisor-current-status"); row.dataset.runId = currentRun?.id || ""; }
    if (timeline.children[timeline.children.length - 1] !== row) timeline.appendChild(row);
    updateLayout();
  }
  function collectStep(steps, event) {
    const api = window.AdvisorSteps;
    return api && typeof api.collect === "function" ? api.collect(steps, event) : steps;
  }
  // A compact list of what the run is doing right now. It only shows coarse labels sent by the
  // bridge and disappears as soon as the answer itself starts streaming.
  function renderSteps() {
    let host = document.getElementById("advisorSteps");
    const running = !!currentRun && !terminal.has(currentRun.state);
    if (!running || !runSteps.length || currentRun?.phase === "answering" || problem) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "advisorSteps"; host.className = "advisor-steps";
      host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite");
      host.setAttribute("aria-label", "执行步骤");
    }
    host.textContent = "";
    runSteps.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "advisor-step";
      row.dataset.state = index === runSteps.length - 1 ? "active" : "done";
      const mark = document.createElement("span");
      mark.className = "advisor-step-mark"; mark.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "advisor-step-text"; label.textContent = step.text;
      row.append(mark, label);
      host.appendChild(row);
    });
    const anchor = messageNodes.get("ui:run");
    timeline.insertBefore(host, anchor && anchor.parentNode === timeline ? anchor.nextSibling : null);
    updateLayout();
  }
  function updateLayout() {
    const hasMessages = messageNodes.size > 0;
    document.body.classList.toggle("advisor-empty", !hasMessages);
    welcome.hidden = hasMessages; timeline.hidden = !hasMessages;
  }
  function renderTemplates() {
    const signature = JSON.stringify([scope?.agentId, catalogReady, engineState, templates.map(template => [template.id, template.name, template.welcome])]);
    if (signature === templateSignature) return;
    templateSignature = signature;
    const selected = templates.find(template => template.id === scope?.agentId);
    agentName.textContent = selected?.name || (catalogReady ? "未启用模板" : "模板未读取");
    welcomeText.textContent = selected?.welcome?.trim() || `嗨，我是你的${selected?.name || "狗头军师"}`;
    menuButton.disabled = templates.length < 2;
    agentMenu.replaceChildren();
    for (const template of templates) {
      const button = document.createElement("button"); button.type = "button";
      button.className = "advisor-agent-choice" + (template.id === scope?.agentId ? " active" : "");
      button.setAttribute("role", "menuitemradio"); button.setAttribute("aria-checked", String(template.id === scope?.agentId));
      button.textContent = template.name; button.title = template.name;
      button.addEventListener("click", () => {
        agentMenu.hidden = true; menuButton.setAttribute("aria-expanded", "false");
        if (template.id !== scope?.agentId) sendToParent("ADVISOR_SWITCH_TEMPLATE", { agentId: template.id });
      });
      agentMenu.appendChild(button);
    }
    agentMenu.hidden = true; menuButton.setAttribute("aria-expanded", "false");
    updateControls();
  }
  function modelOptionRow({ option, name, meta, checked, profileId }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "advisor-model-option" + (checked ? " active" : "");
    button.dataset.modelOption = option;
    if (profileId) button.dataset.profileId = profileId;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(checked));
    button.title = meta ? `${name} · ${meta}` : name;
    const tick = document.createElement("span");
    tick.className = "advisor-model-tick"; tick.setAttribute("aria-hidden", "true");
    tick.textContent = checked ? "✓" : "";
    const body = document.createElement("span"); body.className = "advisor-model-text";
    const label = document.createElement("span"); label.className = "advisor-model-option-name";
    label.textContent = name;
    const detail = document.createElement("span"); detail.className = "advisor-model-option-meta";
    detail.textContent = meta;
    body.appendChild(label); body.appendChild(detail);
    button.appendChild(tick); button.appendChild(body);
    button.addEventListener("click", () => {
      closeModelMenu();
      // Clicking the row that is already active is a no-op, so the menu never reposts a switch.
      if (!checked) chooseModel(option === "follow" ? null : profileId);
    });
    return button;
  }
  function modelHintRow(textValue, className = "advisor-model-hint") {
    const row = document.createElement("div");
    row.className = className; row.textContent = textValue;
    return row;
  }
  function modelOptions() {
    return Array.from(modelMenu.children).filter(child => child.dataset && child.dataset.modelOption);
  }
  function closeModelMenu(focusTrigger = false) {
    modelMenu.hidden = true; modelButton.setAttribute("aria-expanded", "false");
    if (focusTrigger && typeof modelButton.focus === "function") modelButton.focus();
  }
  function openModelMenu(focusLast = false) {
    if (modelButton.disabled) return;
    renderModels();
    modelMenu.hidden = false; modelButton.setAttribute("aria-expanded", "true");
    const options = modelOptions(), target = options[focusLast ? options.length - 1 : 0];
    if (target && typeof target.focus === "function") target.focus();
  }
  function clearModelPending() {
    if (!modelPending) return;
    modelPending = false;
    if (modelPendingTimer) { clearTimeout(modelPendingTimer); modelPendingTimer = 0; }
    renderModels();
  }
  function chooseModel(profileId) {
    if (modelPending) return;
    modelPending = true; renderModels();
    // The host answers with a fresh ADVISOR_SET_MODELS on success and ADVISOR_PROBLEM on
    // failure; the timeout only keeps the chip from sticking if neither arrives.
    modelPendingTimer = setTimeout(clearModelPending, 10000);
    sendToParent("ADVISOR_SELECT_MODEL", { profileId });
  }
  function moveModelFocus(step) {
    const options = modelOptions();
    if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const next = index < 0 ? (step > 0 ? 0 : options.length - 1)
      : (index + step + options.length) % options.length;
    if (typeof options[next].focus === "function") options[next].focus();
  }
  function renderModels() {
    const signature = JSON.stringify([modelProfiles.map(profile => [profile.id, profile.name, profile.model]),
      assistantProfileId, analysisLabel, modelPending, modelsLoaded]);
    if (signature === modelSignature) return;
    modelSignature = signature;
    const selected = modelProfiles.find(profile => profile.id === assistantProfileId);
    // The chip always answers "which model is answering right now": a pinned profile by name,
    // otherwise the analysis line it follows, so the two are never confusable.
    let chipText = "未配置模型";
    if (modelPending) chipText = "切换中…";
    else if (selected) chipText = selected.name;
    else if (!modelsLoaded) chipText = "模型";
    else if (analysisLabel) chipText = `跟随分析 · ${analysisLabel}`;
    else if (modelProfiles.length) chipText = "跟随分析";
    modelName.textContent = chipText;
    modelButton.dataset.mode = selected ? "profile" : modelProfiles.length ? "follow" : "empty";
    modelButton.disabled = modelPending;
    modelButton.setAttribute("aria-busy", String(modelPending));
    modelMenu.replaceChildren();
    // Without a saved profile there is nothing to follow: the assistant needs an API model, so
    // the only useful thing the menu can say is where models come from.
    if (modelProfiles.length) {
      modelMenu.appendChild(modelOptionRow({ option: "follow", name: "跟随分析",
        meta: analysisLabel ? `当前：${analysisLabel}` : "使用分析所选的模型",
        checked: !selected, profileId: "" }));
      modelMenu.appendChild(modelHintRow("已保存的模型", "advisor-model-section"));
      for (const profile of modelProfiles) {
        modelMenu.appendChild(modelOptionRow({ option: "profile", name: profile.name,
          meta: profile.model || profile.protocol || "", checked: profile.id === assistantProfileId,
          profileId: profile.id }));
      }
    } else {
      modelMenu.appendChild(modelHintRow("还没有添加模型，在「设置 → 模型配置」中添加后即可切换。"));
    }
    modelMenu.appendChild(modelHintRow("只影响聊天助手，不改变分析所用的模型。", "advisor-model-foot"));
    modelMenu.hidden = true; modelButton.setAttribute("aria-expanded", "false");
  }
  function renderThread(thread, run, draft) {
    const nextScope = JSON.stringify([scope.account, scope.user, scope.agentId, scope.generation]);
    const changed = threadId !== thread.id || renderedScope !== nextScope;
    if (changed) {
      for (const node of messageNodes.values()) disposeNode(node);
      timeline.replaceChildren(); messageNodes.clear();
      threadId = thread.id; renderedScope = nextScope; problem = "";
      if (activeThreadId !== thread.id) { activeThreadId = thread.id; renderThreads(); }
      resetNewThreadConfirm();
    }
    currentRun = run || null; submitting = false; stopping = false;
    const messages = thread.messages.filter(message => !transientMessage(message));
    lastSavedMessage = messages.at(-1) || null;
    const activeIds = new Set(messages.map(message => message.id));
    for (const [id, node] of messageNodes) {
      if (!id.startsWith("ui:") && !activeIds.has(id)) { disposeNode(node); messageNodes.delete(id); }
    }
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const node = updateMessage(message, message.role === "assistant" && message.runId === run?.id && !terminal.has(run?.state));
      if (timeline.children[index] !== node) timeline.insertBefore(node, timeline.children[index] || null);
    }
    if (text(draft, 16000) && input.value !== draft) input.value = draft;
    updateControls(); updateLayout();
    if (nearBottom || changed) timeline.scrollTop = timeline.scrollHeight;
  }
  function formatThreadTime(ms) {
    if (!ms) return "";
    const when = new Date(ms), now = new Date();
    const sameDay = when.toDateString() === now.toDateString();
    const yesterday = new Date(now.getTime() - 86400000).toDateString() === when.toDateString();
    const clock = String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
    if (sameDay) return "今天 " + clock;
    if (yesterday) return "昨天 " + clock;
    if (when.getFullYear() === now.getFullYear()) return (when.getMonth() + 1) + "月" + when.getDate() + "日";
    return when.getFullYear() + "年" + (when.getMonth() + 1) + "月" + when.getDate() + "日";
  }
  function renderThreads() {
    historyButton.title = threads.length ? "历史会话（" + threads.length + " 段）" : "历史会话";
    if (threadsError) {
      // A failed load clears the row list: showing another contact's conversations would
      // only fail later, with an error that points at the wrong place.
      historyMenu.replaceChildren();
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "advisor-history-empty advisor-history-retry";
      retry.textContent = threadsError;
      retry.addEventListener("click", () => {
        // Acknowledge the click before the round trip, otherwise a second failure looks
        // exactly like the button doing nothing.
        threadsError = "正在读取历史…";
        renderThreads();
        sendToParent("ADVISOR_HISTORY_REQUEST");
      });
      historyMenu.appendChild(retry);
      return;
    }
    if (!threads.length) {
      historyMenu.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "advisor-history-empty";
      empty.textContent = "还没有历史会话";
      historyMenu.appendChild(empty);
      return;
    }
    const nodes = threads.map(thread => {
      const row = document.createElement("button");
      row.type = "button"; row.className = "advisor-history-row"; row.setAttribute("role", "menuitem");
      row.dataset.threadId = thread.id;
      if (thread.id === activeThreadId) { row.classList.add("is-active"); row.setAttribute("aria-current", "true"); }
      const head = document.createElement("span");
      head.className = "advisor-history-title"; head.textContent = thread.title || "新对话";
      const meta = document.createElement("span");
      meta.className = "advisor-history-meta";
      meta.textContent = [formatThreadTime(thread.updatedAtMs), thread.messageCount + " 条消息"].filter(Boolean).join(" · ");
      const preview = document.createElement("span");
      preview.className = "advisor-history-preview";
      preview.textContent = (thread.previewRole === "assistant" ? "助手：" : "") + (thread.preview || "");
      row.appendChild(head); row.appendChild(meta); row.appendChild(preview);
      // Deleting is a two-step action on the row itself: the first click arms it, the second
      // removes the conversation. It never falls through to "open this conversation".
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "advisor-history-delete";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", "删除这段会话");
      remove.addEventListener("click", event => {
        // The row would otherwise treat this click as "open this conversation".
        event.stopPropagation?.();
        if (row.dataset.confirmDelete !== "1") {
          row.dataset.confirmDelete = "1";
          remove.textContent = "确认删除";
          return;
        }
        closeHistoryMenu();
        sendToParent("ADVISOR_DELETE_THREAD", { threadId: thread.id });
      });
      row.appendChild(remove);
      row.addEventListener("click", () => {
        closeHistoryMenu();
        if (thread.id !== activeThreadId) sendToParent("ADVISOR_OPEN_THREAD", { threadId: thread.id });
      });
      return row;
    });
    historyMenu.replaceChildren(...nodes);
  }
  function openHistoryMenu() {
    historyMenu.hidden = false; historyButton.setAttribute("aria-expanded", "true");
    // Nothing cached yet: show the loading row before the round trip, so opening the menu
    // always produces visible feedback even when the previous request failed.
    if (!threads.length) threadsError = "正在读取历史…";
    renderThreads();
    sendToParent("ADVISOR_HISTORY_REQUEST");
  }
  function closeHistoryMenu() {
    historyMenu.hidden = true; historyButton.setAttribute("aria-expanded", "false");
  }
  // The one reason the composer cannot send, ordered by what the user can act on first.
  function composerBlocker() {
    // Before the first handshake nothing is known yet; a hint here would be a guess.
    if (!sessionNonce) return "";
    if (!scope?.account || !scope?.user) return "先在左侧选择一个微信会话";
    if (!scope?.agentId) return "还没有启用的助手模板";
    if (!catalogReady) return "助手模板还没读取完，请稍后重试";
    // `engineState` covers both a missing runtime and a selected profile without a usable key,
    // so the hint names both remedies instead of guessing which one it is.
    if (engineState === "missing") return "助手引擎不可用：运行 npm run setup:advisor-engine，或检查所选模型的 API Key 是否已保存";
    return "";
  }
  function validThreadSummary(value) {
    return object(value) && text(value.id, 240) && text(value.title, 60) && text(value.preview, 60) &&
      ["", "user", "assistant", "status"].includes(value.previewRole) &&
      Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 &&
      Number.isSafeInteger(value.createdAtMs) && Number.isSafeInteger(value.updatedAtMs);
  }
  function threadHasMessages() {
    return [...messageNodes.keys()].some(key => !key.startsWith("ui:"));
  }
  function renderNewThread() {
    newThread.dataset.confirm = newThreadConfirm ? "1" : "0";
    newThreadLabel.textContent = newThreadConfirm ? "确认新建" : "新建";
    const title = newThreadConfirm ? "再次点击确认：当前对话会被清空" : "新建对话";
    newThread.title = title; newThread.setAttribute("aria-label", title);
  }
  function resetNewThreadConfirm() {
    if (!newThreadConfirm) return;
    newThreadConfirm = false;
    if (newThreadTimer) { clearTimeout(newThreadTimer); newThreadTimer = 0; }
    renderNewThread();
  }
  function updateControls() {
    const running = !!currentRun && !terminal.has(currentRun.state);
    // The host forwards one coarse status at a time (`run.phaseEvent`), so the list grows here
    // by remembering each distinct label this run has shown.
    if (currentRun?.id !== stepRunId) { stepRunId = currentRun?.id || ""; runSteps = []; }
    if (running && currentRun?.phaseEvent) runSteps = collectStep(runSteps, currentRun.phaseEvent);
    const resetCommand = /^\s*\/reset\s*$/.test(input.value);
    send.disabled = submitting || (!resetCommand && (running || !catalogReady || engineState !== "available")) || !scope?.account || !scope?.user || !scope?.agentId;
    // A disabled send button with no explanation reads as a broken app: say what is missing.
    const blocker = !running && !submitting && !resetCommand ? composerBlocker() : "";
    note.hidden = !blocker; note.textContent = blocker;
    send.title = blocker || "发送";
    stop.hidden = !running || resetCommand; send.hidden = running && !resetCommand;
    newThread.disabled = submitting;
    stop.disabled = stopping; stop.setAttribute("aria-label", stopping ? "正在停止" : "停止生成");
    stop.title = stopping ? "正在停止" : "停止生成";
    retry.hidden = !problem && currentRun?.state !== "error";
    controls.hidden = retry.hidden;
    const phase = currentRun?.phaseEvent || { state: currentRun?.phase || "preparing" };
    const labels = { preparing: "正在准备", starting: "正在准备", awaiting: "正在等待", answering: "正在回答",
      running: "正在回答", thinking: "正在思考", busy: "正在回答", retry: "正在重试", compressing: "正在压缩上下文", compacting: "正在压缩上下文" };
    const event = problem ? { state: "error", text: problem } : submitting ? { state: "preparing", text: "正在提交" } :
      stopping ? { state: "stopping", text: "正在停止" } : phase;
    const savedError = !problem && !submitting && !stopping && currentRun?.state === "error" &&
      lastSavedMessage?.role === "status" && lastSavedMessage.status === "error" &&
      lastSavedMessage.text === "生成失败：" + currentRun.error;
    const content = submitting || stopping || problem ? event.text : running ? phase.text || labels[phase.state] || "正在准备" :
      currentRun?.state === "stopped" ? "已停止" : currentRun?.state === "error" && !savedError ? currentRun.error || "生成失败" : "";
    statusRow("ui:run", content, event.state, event);
    renderSteps();
  }
  function applyStream(payload) {
    if (payload.threadId !== threadId) return;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    currentRun = payload.run;
    for (const message of payload.messages) {
      if (transientMessage(message)) continue;
      lastSavedMessage = message;
      const existed = messageNodes.has(message.id);
      const node = updateMessage(message, message.role === "assistant" && message.runId === currentRun?.id && !terminal.has(currentRun?.state));
      if (!existed) {
        const status = messageNodes.get("ui:run")?.wrap;
        timeline.insertBefore(node, status?.parentNode === timeline ? status : null);
      }
    }
    updateControls(); updateLayout();
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }
  function validMessage(message) {
    return object(message) && text(message.id, 240) && ["user", "assistant", "status"].includes(message.role) && text(message.text, 2000000) &&
      (message.delivery === undefined || ["pending", "failed"].includes(message.delivery)) &&
      (message.runId === undefined || text(message.runId, 240)) &&
      (message.event === undefined || (object(message.event) &&
        Object.keys(message.event).every(key => ["seq", "type", "text", "state", "messageId", "skillId", "next", "attempt"].includes(key)) &&
        (message.event.state === undefined || text(message.event.state, 60)) &&
        (message.event.text === undefined || text(message.event.text, 2000000)) &&
        (message.event.next === undefined || (Number.isSafeInteger(message.event.next) && message.event.next >= 0)) &&
        (message.event.attempt === undefined || (Number.isSafeInteger(message.event.attempt) && message.event.attempt >= 0))));
  }
  function validRun(run) {
    return object(run) && text(run.id, 240) && text(run.state, 60) &&
      (run.phase === undefined || text(run.phase, 60)) &&
      (run.phaseEvent === undefined || (object(run.phaseEvent) &&
        (run.phaseEvent.state === undefined || text(run.phaseEvent.state, 60)) &&
        (run.phaseEvent.text === undefined || text(run.phaseEvent.text, 20000)) &&
        (run.phaseEvent.next === undefined || (Number.isSafeInteger(run.phaseEvent.next) && run.phaseEvent.next >= 0)) &&
        (run.phaseEvent.attempt === undefined || (Number.isSafeInteger(run.phaseEvent.attempt) && run.phaseEvent.attempt >= 0))));
  }
  function validPayload(type, payload) {
    if (!object(payload)) return false;
    const permitted = {
      ADVISOR_INIT: ["activeAgentId", "enabledTemplates", "thread", "draft", "catalogReady", "engineState", "theme", "run"],
      ADVISOR_THEME: ["theme"], ADVISOR_SET_TEMPLATES: ["enabledTemplates", "activeAgentId", "catalogReady", "engineState"],
      ADVISOR_SET_THREAD: ["thread", "run", "agentId", "draft"],
      ADVISOR_STREAM_UPDATE: ["threadId", "run", "messages"],
      ADVISOR_PROBLEM: ["error", "retryKind"], ADVISOR_SUBMIT_STATE: ["pending"], ADVISOR_STOP_STATE: ["pending"],
      ADVISOR_COPY_RESULT: ["copied"], ADVISOR_SET_MODELS: ["profiles", "assistantProfileId", "analysisLabel"],
      ADVISOR_SET_THREADS: ["threads", "activeThreadId", "error"]
    };
    if (!permitted[type] || Object.keys(payload).some(key => !permitted[type].includes(key))) return false;
    if (type === "ADVISOR_INIT" || type === "ADVISOR_SET_TEMPLATES") {
      if (!Array.isArray(payload.enabledTemplates) || payload.enabledTemplates.length > 200 ||
        !payload.enabledTemplates.every(item => object(item) && text(item.id, 240) && text(item.name, 60) &&
          (item.welcome === undefined || text(item.welcome, 120))) ||
        !text(payload.activeAgentId, 240) || typeof payload.catalogReady !== "boolean" ||
        !["available", "missing", "unknown"].includes(payload.engineState)) return false;
    }
    if (type === "ADVISOR_INIT" || type === "ADVISOR_SET_THREAD") {
      if (!object(payload.thread) || !text(payload.thread.id, 240) || !Array.isArray(payload.thread.messages) ||
        !payload.thread.messages.every(validMessage) || !text(payload.draft, 16000)) return false;
      if (payload.run && !validRun(payload.run)) return false;
    }
    if (type === "ADVISOR_STREAM_UPDATE" && (!text(payload.threadId, 240) || !Array.isArray(payload.messages) ||
      payload.messages.length > 200 || !payload.messages.every(validMessage) || !validRun(payload.run))) return false;
    if (["ADVISOR_INIT", "ADVISOR_THEME"].includes(type) && !["light", "dark"].includes(payload.theme)) return false;
    if (type === "ADVISOR_PROBLEM" && (!text(payload.error, 20000) || !["send", "poll", "load", "catalog"].includes(payload.retryKind))) return false;
    if (["ADVISOR_SUBMIT_STATE", "ADVISOR_STOP_STATE"].includes(type) && typeof payload.pending !== "boolean") return false;
    if (type === "ADVISOR_COPY_RESULT" && typeof payload.copied !== "boolean") return false;
    if (type === "ADVISOR_SET_THREADS") {
      if (!Array.isArray(payload.threads) || payload.threads.length > 200 ||
        !payload.threads.every(validThreadSummary) || !text(payload.activeThreadId, 240) ||
        (payload.error !== undefined && !text(payload.error, 120))) return false;
    }
    if (type === "ADVISOR_SET_MODELS") {
      if (!Array.isArray(payload.profiles) || payload.profiles.length > 200 ||
        !payload.profiles.every(item => object(item) && text(item.id, 240) && text(item.name, 64) &&
          (item.model === undefined || text(item.model, 256)) &&
          (item.protocol === undefined || text(item.protocol, 40))) ||
        (payload.analysisLabel !== undefined && !text(payload.analysisLabel, 64)) ||
        !(payload.assistantProfileId === null || text(payload.assistantProfileId, 240))) return false;
    }
    return true;
  }
  menuButton.addEventListener("click", () => {
    agentMenu.hidden = !agentMenu.hidden; menuButton.setAttribute("aria-expanded", String(!agentMenu.hidden));
  });
  modelButton.addEventListener("click", () => {
    if (modelMenu.hidden) openModelMenu(); else closeModelMenu();
  });
  modelButton.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault?.();
    openModelMenu(event.key === "ArrowUp");
  });
  modelMenu.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault?.(); moveModelFocus(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault?.(); openModelMenu(event.key === "End");
    } else if (event.key === "Escape") {
      event.preventDefault?.(); closeModelMenu(true);
    } else if (event.key === "Tab") closeModelMenu();
  });
  document.addEventListener("click", event => {
    if (!event.target.closest?.(".advisor-agent-control, .advisor-model-control")) {
      agentMenu.hidden = true; menuButton.setAttribute("aria-expanded", "false");
      modelMenu.hidden = true; modelButton.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      agentMenu.hidden = true; menuButton.setAttribute("aria-expanded", "false");
      modelMenu.hidden = true; modelButton.setAttribute("aria-expanded", "false");
    }
  });
  newThread.addEventListener("click", () => {
    if (newThread.disabled) return;
    // A replaced conversation has no list to restore it from, so it takes a second click.
    if (!newThreadConfirm && threadHasMessages()) {
      newThreadConfirm = true; renderNewThread();
      newThreadTimer = setTimeout(resetNewThreadConfirm, 4000);
      return;
    }
    resetNewThreadConfirm();
    sendToParent("ADVISOR_NEW_THREAD");
  });
  // Always open and refresh instead of toggling: a menu can be left logically open but
  // invisible (e.g. after the list failed and the composer moved on), and then every click
  // only called closeHistoryMenu() -- which looked like the button did nothing at all.
  historyButton.addEventListener("click", () => openHistoryMenu());
  historyButton.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault?.();
    if (historyMenu.hidden) openHistoryMenu();
    historyMenu.querySelector(".advisor-history-row")?.focus?.();
  });
  document.addEventListener("click", event => {
    if (historyMenu.hidden) return;
    const target = event.target;
    if (!historyButton.contains(target) && !historyMenu.contains(target)) closeHistoryMenu();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !historyMenu.hidden) closeHistoryMenu(); });
  stop.addEventListener("click", () => sendToParent("ADVISOR_STOP"));
  retry.addEventListener("click", () => sendToParent("ADVISOR_RETRY", { retryKind: currentRun?.state === "error" ? "send" : retryKind }));
  function submitMessage() {
    const value = input.value;
    if (!value.trim() || value.length > 16000 || send.disabled) return;
    runSteps = []; stepRunId = "";
    submitting = true; updateControls();
    sendToParent("ADVISOR_SEND", { text: value, agentId: scope.agentId });
  }
  send.addEventListener("click", submitMessage);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(); }
  });
  input.addEventListener("input", () => {
    sendToParent("ADVISOR_DRAFT_UPDATE", { draft: input.value, agentId: scope?.agentId }); updateControls();
  });
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!object(data) || data.envelope !== "advisor" || !/^adv_[0-9a-f]{32}$/.test(data.nonce) ||
      Object.keys(data).some(key => !["envelope", "nonce", "type", "payload", "scope"].includes(key)) ||
      !validScope(data.scope) || !validPayload(data.type, data.payload)) return;
    if (data.type === "ADVISOR_INIT") {
      if (sessionNonce && sessionNonce !== data.nonce) return;
      sessionNonce = data.nonce; scope = data.scope; templates = data.payload.enabledTemplates;
      catalogReady = data.payload.catalogReady; engineState = data.payload.engineState;
      document.body.className = `advisor-frame-body theme-${data.payload.theme}`;
      renderTemplates(); renderThread(data.payload.thread, data.payload.run, data.payload.draft);
      sendToParent("ADVISOR_FRAME_READY"); return;
    }
    if (!sessionNonce || data.nonce !== sessionNonce) return;
    if (["ADVISOR_SET_TEMPLATES", "ADVISOR_SET_THREAD"].includes(data.type)) {
      if (data.scope.generation < scope.generation || (data.scope.generation === scope.generation && !sameScope(data.scope))) return;
      scope = data.scope;
    } else if (!sameScope(data.scope)) return;
    const payload = data.payload;
    if (data.type === "ADVISOR_SET_TEMPLATES") {
      templates = payload.enabledTemplates; catalogReady = payload.catalogReady; engineState = payload.engineState; renderTemplates();
    } else if (data.type === "ADVISOR_SET_MODELS") {
      modelProfiles = payload.profiles; assistantProfileId = payload.assistantProfileId || "";
      analysisLabel = payload.analysisLabel || ""; modelsLoaded = true;
      clearModelPending(); renderModels();
    } else if (data.type === "ADVISOR_SET_THREADS") {
      threads = payload.threads; activeThreadId = payload.activeThreadId;
      threadsError = payload.error || ""; renderThreads();
    } else if (data.type === "ADVISOR_SET_THREAD") {
      closeHistoryMenu();
      renderTemplates(); renderThread(payload.thread, payload.run, payload.draft);
    } else if (data.type === "ADVISOR_STREAM_UPDATE") applyStream(payload);
    else if (data.type === "ADVISOR_THEME") {
      document.body.classList.toggle("theme-light", payload.theme === "light");
      document.body.classList.toggle("theme-dark", payload.theme === "dark");
    }
    else if (data.type === "ADVISOR_PROBLEM") {
      problem = payload.error; retryKind = payload.retryKind;
      // A failed switch never sends new models, so this is what releases the busy chip.
      if (payload.error) clearModelPending();
      updateControls();
    } else if (data.type === "ADVISOR_SUBMIT_STATE") {
      submitting = payload.pending; if (submitting) { problem = ""; statusRow("ui:problem", ""); } updateControls();
    } else if (data.type === "ADVISOR_STOP_STATE") { stopping = payload.pending; updateControls(); }
  });
  renderModels(); renderNewThread(); renderThreads(); updateControls(); updateLayout();
})();
