"use strict";

(function () {
  const TERMINAL = new Set(["done", "error", "stopped", "cancelled"]);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value, limit) => typeof value === "string" && value.length <= limit;
  const id = value => text(value, 240) && value.length > 0;
  function nonce(prefix) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }
  function stored(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function storedObject(key) {
    try { const value = JSON.parse(stored(key, "{}")); return object(value) ? value : {}; } catch { return {}; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); return true; } catch { return false; }
  }
  function validCatalog(value) {
    return object(value) && Array.isArray(value.agents) && Array.isArray(value.skills) &&
      value.agents.every(agent => object(agent) && id(agent.id) && text(agent.name, 60) &&
        text(agent.description, 240) && text(agent.prompt, 16000) && typeof agent.enabled === "boolean" &&
        (agent.welcome === undefined || text(agent.welcome, 120)) &&
        Array.isArray(agent.skillIds) && agent.skillIds.every(id)) &&
      value.skills.every(skill => object(skill) && id(skill.id) && text(skill.name, 60)) &&
      ["available", "missing"].includes(value.engine?.state);
  }
  function validModelProfiles(value) {
    return object(value) && Array.isArray(value.profiles) && value.profiles.length <= 200 &&
      // 64 is `MAX_PROFILE_NAME` in bridge/model_source.py: a longer-than-60 name used to fail
      // this check and discard the whole list, so the cap has to match the store.
      value.profiles.every(profile => object(profile) && id(profile.id) && text(profile.name, 64) &&
        (profile.model === undefined || text(profile.model, 256)) &&
        (profile.protocol === undefined || text(profile.protocol, 40))) &&
      (value.label === undefined || text(value.label, 60)) &&
      // `api` is the analysis line's active profile: it carries `id`/`protocol`/`model`, but
      // never a `name` — requiring one here rejected every real document and emptied the picker.
      (value.api === undefined || value.api === null || (object(value.api) &&
        (value.api.id === undefined || id(value.api.id)) &&
        (value.api.name === undefined || text(value.api.name, 64)))) &&
      (value.assistantProfileId === null || value.assistantProfileId === undefined || id(value.assistantProfileId));
  }
  function validThreadSummary(value) {
  return object(value) && id(value.id) && text(value.title, 60) && text(value.preview, 60) &&
    (value.previewRole === "" || value.previewRole === "user" || value.previewRole === "assistant" ||
      value.previewRole === "status") && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 &&
    Number.isSafeInteger(value.createdAtMs) && Number.isSafeInteger(value.updatedAtMs);
}
function validThread(value, scope) {
    return object(value) && id(value.id) && value.account === scope.account && value.user === scope.user &&
      value.agentId === scope.agentId && Array.isArray(value.messages) && value.messages.every(message =>
        object(message) && id(message.id) && ["user", "assistant", "status"].includes(message.role) && text(message.text, 2000000));
  }
  function errorText(value) {
    if (text(value?.message, 20000) && value.message) return value.message;
    if (text(value?.error, 20000) && value.error) return value.error;
    if (text(value?.error?.message, 20000) && value.error.message) return value.error.message;
    return "服务返回无效数据";
  }
  const Advisor = {
    panelVisible: false,
    activeAgentId: stored("advisor_active_agent", ""),
    currentAccount: "", currentUser: "", currentRunId: null,
    generation: 0, loadSerial: 0, catalogSerial: 0,
    frameReady: false, handshakeNonce: nonce("adv_"),
    catalog: { agents: [], skills: [], engine: { state: "missing" } },
    catalogReady: false, catalogError: "", catalogBusy: false,
    modelProfiles: [], assistantProfileId: "", analysisLabel: "", historySerial: 0,
    drafts: storedObject("advisor_drafts_v1"), threadCache: storedObject("advisor_threads_v1"),
    pendingRequests: storedObject("advisor_pending_v1"),
    pollAbortController: null, submitPending: false, stopPending: false,
    threadProjection: null, lastProblem: null, cacheSaveTimer: null,
    clearedAccounts: new Set(), currentView: "chat", pollError: false,

    scopeKey(account, user, agentId) { return JSON.stringify([account || "", user || "", agentId || ""]); },
    captureScope() {
      return Object.freeze({ account: this.currentAccount, user: this.currentUser,
        agentId: this.activeAgentId, generation: this.generation });
    },
    isCurrent(scope) {
      return scope.generation === this.generation && scope.account === this.currentAccount &&
        scope.user === this.currentUser && scope.agentId === this.activeAgentId && !this.clearedAccounts.has(scope.account);
    },
    getDraft(account, user, agentId) { return this.drafts[this.scopeKey(account, user, agentId)] || ""; },
    setDraft(account, user, agentId, draft) {
      if (!account || !user || !agentId || this.clearedAccounts.has(account) || !text(draft, 16000)) return;
      const key = this.scopeKey(account, user, agentId);
      if (draft) this.drafts[key] = draft; else delete this.drafts[key];
      save("advisor_drafts_v1", this.drafts);
    },
    getCachedThread(account, user, agentId) {
      const value = this.threadCache[this.scopeKey(account, user, agentId)];
      return validThread(value, { account, user, agentId }) ? value : { id: "", account, user, agentId, messages: [] };
    },
    setCachedThread(account, user, agentId, thread) {
      if (this.clearedAccounts.has(account) || !validThread(thread, { account, user, agentId })) return;
      this.threadCache[this.scopeKey(account, user, agentId)] = thread;
      if (this.cacheSaveTimer === null) this.cacheSaveTimer = setTimeout(() => this.flushThreadCache(), 1000);
    },
    flushThreadCache() {
      clearTimeout(this.cacheSaveTimer); this.cacheSaveTimer = null;
      save("advisor_threads_v1", this.threadCache);
    },
    getEnabledTemplates() { return this.catalogReady ? this.catalog.agents.filter(agent => agent.enabled) : []; },
    getReplyContext() {
      const agent = this.getEnabledTemplates().find(item => item.id === this.activeAgentId);
      return { ready: this.catalogReady, agentId: agent?.id || "",
        agentRevision: Number.isSafeInteger(agent?.revision) && agent.revision > 0 ? agent.revision : 0 };
    },
    notifyReplyContext() {
      const context = this.getReplyContext(), key = JSON.stringify(context);
      if (key === this.replyContextKey) return;
      this.replyContextKey = key;
      window.dispatchEvent(new CustomEvent("advisor-selection-changed", { detail: context }));
    },
    async fetchJson(url, options = {}) {
      try {
        const response = await fetch(url, options);
        let data;
        try { data = await response.json(); } catch { return { error: `服务响应不是 JSON（HTTP ${response.status}）` }; }
        if (!response.ok) return { error: errorText(data), status: response.status };
        return data;
      } catch (error) {
        return error.name === "AbortError" ? { aborted: true } : { error: error.message || String(error) };
      }
    },
    postToFrame(type, payload = {}, scope = this.captureScope()) {
      if (typeof window.desktopHost?.sendAdvisorEnvelope !== "function") return;
      const envelope = { envelope: "advisor", nonce: this.handshakeNonce, type, payload, scope };
      Promise.resolve(window.desktopHost.sendAdvisorEnvelope(envelope)).catch(() => {});
    },
    problem(error, scope = this.captureScope(), retryKind = "load") {
      if (!this.isCurrent(scope)) return;
      const payload = { error: errorText(error), retryKind };
      this.lastProblem = { scope, payload };
      this.postToFrame("ADVISOR_PROBLEM", payload, scope);
    },
    clearProblem(retryKind, scope = this.captureScope()) {
      if (!this.isCurrent(scope) || !this.lastProblem || !this.isCurrent(this.lastProblem.scope) ||
        (retryKind && this.lastProblem.payload.retryKind !== retryKind)) return;
      const previousKind = this.lastProblem.payload.retryKind;
      this.lastProblem = null;
      this.postToFrame("ADVISOR_PROBLEM", { error: "", retryKind: previousKind }, scope);
    },
    projectionForScope(scope = this.captureScope()) {
      const cached = this.getCachedThread(scope.account, scope.user, scope.agentId);
      const pending = this.pendingRequests[this.scopeKey(scope.account, scope.user, scope.agentId)];
      const thread = { ...cached, messages: [...cached.messages] };
      if (pending && id(pending.requestId) && text(pending.message, 16000) &&
        !thread.messages.some(message => message.id === pending.requestId || message.requestId === pending.requestId)) {
        thread.messages.push({ id: pending.requestId, requestId: pending.requestId, role: "user", text: pending.message,
          delivery: pending.delivery || "pending", createdAtMs: pending.createdAtMs || Date.now() });
      }
      const saved = this.threadProjection;
      return { thread, run: saved && this.isCurrent(saved.scope) && saved.thread.id === thread.id ? saved.run : cached._advisorRun || null };
    },
    syncThreadToFrame(thread, run = null, scope = this.captureScope()) {
      if (!this.isCurrent(scope)) return;
      const pending = this.pendingRequests[this.scopeKey(scope.account, scope.user, scope.agentId)];
      if (pending && id(pending.requestId) && !thread.messages.some(message => message.id === pending.requestId || message.requestId === pending.requestId)) {
        thread = { ...thread, messages: [...thread.messages, { id: pending.requestId, requestId: pending.requestId,
          role: "user", text: pending.message, delivery: pending.delivery || "pending", createdAtMs: pending.createdAtMs }] };
      }
      this.threadProjection = { scope, thread, run };
      this.postToFrame("ADVISOR_SET_THREAD", { thread, run, agentId: scope.agentId,
        draft: this.getDraft(scope.account, scope.user, scope.agentId) }, scope);
    },
    syncReadyFrame() {
      const scope = this.captureScope(), projection = this.projectionForScope(scope);
      this.postToFrame("ADVISOR_SET_TEMPLATES", { enabledTemplates: this.getEnabledTemplates(), activeAgentId: scope.agentId,
        catalogReady: this.catalogReady, engineState: this.catalogReady ? this.catalog.engine.state : "unknown" }, scope);
      this.postToFrame("ADVISOR_SET_MODELS", this.modelPayload(), scope);
      this.syncThreadToFrame(projection.thread, projection.run, scope);
      this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: this.submitPending }, scope);
      this.postToFrame("ADVISOR_STOP_STATE", { pending: this.stopPending }, scope);
      if (this.lastProblem && this.isCurrent(this.lastProblem.scope)) this.postToFrame("ADVISOR_PROBLEM", this.lastProblem.payload, scope);
    },
    syncTemplatesToFrame() {
      const oldScope = this.captureScope(), oldRun = this.currentRunId;
      const enabled = this.getEnabledTemplates(), previous = this.activeAgentId;
      if (!enabled.some(agent => agent.id === previous)) this.activeAgentId = enabled[0]?.id || "";
      if (previous !== this.activeAgentId) {
        void this.stopForScope(oldScope, oldRun);
        this.generation++; this.abortCurrentPoll(); this.submitPending = false;
        save("advisor_active_agent", this.activeAgentId);
      }
      this.postToFrame("ADVISOR_SET_TEMPLATES", { enabledTemplates: enabled, activeAgentId: this.activeAgentId,
        catalogReady: this.catalogReady, engineState: this.catalogReady ? this.catalog.engine.state : "unknown" });
      this.notifyReplyContext();
      if (previous !== this.activeAgentId) void this.loadThread();
    },
    async loadCatalog() {
      const serial = ++this.catalogSerial; this.catalogBusy = true; this.renderRepository();
      const data = await this.fetchJson("/api/advisor/catalog");
      if (serial !== this.catalogSerial) return false;
      this.catalogBusy = false;
      if (!validCatalog(data)) {
        this.catalogError = errorText(data); this.catalogReady = false;
        this.syncTemplatesToFrame(); this.renderRepository(); this.problem(data, this.captureScope(), "catalog"); return false;
      }
      this.catalog = data; this.catalogReady = true; this.catalogError = "";
      this.clearProblem("catalog");
      this.syncTemplatesToFrame(); this.renderRepository(); return true;
    },
    async loadModelProfiles() {
      // The assistant may pick its own saved profile while analysis keeps running as it is, so
      // the menu reads the local model-source document instead of the catalog. This endpoint
      // never contacts a provider, which keeps the local mode free of any model-connectors call.
      const data = await this.fetchJson("/api/model-source");
      if (!validModelProfiles(data)) {
        this.modelProfiles = []; this.assistantProfileId = ""; this.analysisLabel = ""; this.syncModelsToFrame(); return false;
      }
      // `api` is the profile the analysis line would hand the assistant when it follows it.
      // The stored `label` is not used here: in local mode it reads "本地 Laya", which the
      // assistant can never run on — the last activated API profile is what it would inherit.
      // `api` has no `name` of its own, so the label comes from the profile row with that id.
      this.modelProfiles = data.profiles.map(profile => ({ id: profile.id, name: profile.name,
        model: profile.model || "", protocol: profile.protocol || "" }));
      this.assistantProfileId = data.assistantProfileId || "";
      this.analysisLabel = data.profiles.find(profile => profile.id === data.api?.id)?.name || "";
      this.syncModelsToFrame(); return true;
    },
    modelPayload() {
      return { profiles: this.modelProfiles, assistantProfileId: this.assistantProfileId,
        analysisLabel: this.analysisLabel };
    },
    syncModelsToFrame() {
      this.postToFrame("ADVISOR_SET_MODELS", this.modelPayload());
    },
    async selectModelProfile(profileId) {
      const scope = this.captureScope();
      // `null` means "follow analysis again"; it is the only way back from a pinned profile.
      if (profileId !== null && (!id(profileId) || !this.modelProfiles.some(profile => profile.id === profileId))) return;
      const result = await this.fetchJson("/api/model-source/select",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId }) });
      if (!this.isCurrent(scope)) return;
      if (result?.error || (result?.profileId ?? null) !== profileId) {
        this.problem({ error: result?.status === 400 ? "模型档案不存在或已更改" : errorText(result) }, scope, "catalog"); return;
      }
      // Only the assistant selection moved; the engine state follows the profile, so the
      // catalog has to be read again. The analysis mode is deliberately left untouched, and so
      // is `analysisLabel`: the analysis line keeps whatever source it already had.
      this.assistantProfileId = profileId || "";
      this.syncModelsToFrame();
      await this.loadCatalog();
    },
    async mutateCatalog(url, payload, onError) {
      const serial = ++this.catalogSerial;
      const data = await this.fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (serial !== this.catalogSerial) return false;
      if (!validCatalog(data)) {
        const error = errorText(data);
        if (typeof onError === "function") onError(error);
        else { this.catalogError = error; this.renderRepository(); if (typeof alert === "function") alert(error); }
        return false;
      }
      this.catalog = data; this.catalogReady = true; this.catalogError = "";
      this.clearProblem("catalog");
      this.syncTemplatesToFrame(); this.renderRepository(); return true;
    },
    saveTemplate(agent) {
      if (!this.catalogReady) return Promise.resolve(false);
      return this.mutateCatalog("/api/advisor/templates", { action: "save", agent: {
        ...(agent.id ? { id: agent.id } : {}), name: String(agent.name || "").trim().slice(0, 60),
        description: String(agent.description || "").trim().slice(0, 240), prompt: String(agent.prompt || "").trim().slice(0, 16000),
        welcome: String(agent.welcome || "").trim().slice(0, 120),
        skillIds: (agent.skillIds || []).filter(value => this.catalog.skills.some(skill => skill.id === value)) } });
    },
    enableTemplate(id, enabled) {
      return this.mutateCatalog("/api/advisor/templates", { action: "enable", id, enabled: !!enabled });
    },
    deleteTemplate(id) {
      const agent = this.catalog.agents.find(item => item.id === id);
      return agent ? this.mutateCatalog("/api/advisor/templates", { action: "delete", id }) : Promise.resolve(false);
    },
    async importSkill({ name, description, content }, onError) {
      if (!text(content, 24000) || /https?:\/\/|(?:file:\/\/)|(?:^|[^\w])[a-zA-Z]:[\\\/]|<\s*script|javascript:/i.test(content)) {
        if (onError) onError("技能内容不符合要求"); else if (typeof alert === "function") alert("技能内容不符合要求"); return false;
      }
      return this.mutateCatalog("/api/advisor/skills", { name: String(name || "").trim().slice(0, 60),
        description: String(description || "").trim().slice(0, 240), content }, onError);
    },
    deleteSkill(skillId, onError) {
      return this.mutateCatalog("/api/advisor/skills", { action: "delete", id: skillId }, onError);
    },
    abortCurrentPoll() {
      this.pollAbortController?.abort(); this.pollAbortController = null; this.currentRunId = null;
      this.pollError = false; this.stopPending = false;
    },
    acknowledgePending(scope, pending, run) {
      const key = this.scopeKey(scope.account, scope.user, scope.agentId);
      if (!pending || this.pendingRequests[key]?.requestId !== pending.requestId || this.clearedAccounts.has(scope.account) ||
        run?.threadId !== pending.threadId || !id(run.messageId)) return false;
      delete this.pendingRequests[key]; save("advisor_pending_v1", this.pendingRequests);
      const thread = this.getCachedThread(scope.account, scope.user, scope.agentId);
      if (thread.id === pending.threadId && !thread.messages.some(item => item.id === run.messageId)) {
        thread.messages.push({ id: run.messageId, requestId: pending.requestId, role: "user", text: pending.message,
          createdAtMs: pending.createdAtMs || Date.now() });
        this.setCachedThread(scope.account, scope.user, scope.agentId, thread);
      }
      this.flushThreadCache(); return true;
    },
    async loadThread(scope = this.captureScope(), threadId = undefined) {
      if (!this.isCurrent(scope)) return;
      const serial = ++this.loadSerial;
      const projection = this.projectionForScope(scope);
      this.syncThreadToFrame(projection.thread, projection.run, scope);
      if (!scope.account || !scope.user || !scope.agentId || !this.catalogReady) return;
      const query = new URLSearchParams({ account: scope.account, user: scope.user, agentId: scope.agentId });
      if (threadId) query.set("threadId", threadId);
      const data = await this.fetchJson(`/api/advisor/thread?${query}`);
      if (!this.isCurrent(scope) || serial !== this.loadSerial) return;
      if (!validThread(data?.thread, scope)) { this.problem(data, scope); return; }
      const pending = this.pendingRequests[this.scopeKey(scope.account, scope.user, scope.agentId)];
      if (pending && data.run?.requestId === pending.requestId && data.thread.id === pending.threadId &&
        data.thread.messages.some(item => item.id === data.run.messageId && item.role === "user"))
        this.acknowledgePending(scope, pending, data.run);
      this.clearProblem("load", scope);
      this.setCachedThread(scope.account, scope.user, scope.agentId, data.thread);
      this.syncThreadToFrame(data.thread, data.run, scope);
      if (data.run?.id && !TERMINAL.has(data.run.state)) void this.pollEvents(data.run.id, scope);
    },
    async startRun(message, agentId = this.activeAgentId) {
      const scope = this.captureScope();
      if (!this.isCurrent(scope) || !scope.account || !scope.user || !id(scope.agentId) || agentId !== scope.agentId ||
        !text(message, 16000) || !message.trim() || this.submitPending) return;
      if (/^\s*\/reset\s*$/.test(message)) { await this.newThread(agentId, true); return; }
      if (this.currentRunId) return;
      if (!this.catalogReady || !this.catalog.agents.some(agent => agent.id === agentId && agent.enabled)) {
        this.problem({ error: "模板未启用" }, scope, "catalog"); return;
      }
      if (this.catalog.engine.state !== "available") { this.problem({ error: "军师引擎未安装" }, scope, "catalog"); return; }
      this.submitPending = true;
      this.clearProblem("send", scope);
      const key = this.scopeKey(scope.account, scope.user, scope.agentId);
      let pending = this.pendingRequests[key];
      if (!pending || pending.message !== message || pending.account !== scope.account || pending.user !== scope.user ||
        pending.agentId !== scope.agentId || !/^req_[0-9a-f]{32}$/.test(pending.requestId)) {
        const thread = this.getCachedThread(scope.account, scope.user, scope.agentId);
        pending = { account: scope.account, user: scope.user, agentId: scope.agentId,
          threadId: thread.id, message, requestId: nonce("req_"), createdAtMs: Date.now() };
      }
      pending.delivery = "pending";
      this.pendingRequests[key] = pending; save("advisor_pending_v1", this.pendingRequests);
      this.setDraft(scope.account, scope.user, scope.agentId, "");
      const pendingProjection = this.projectionForScope(scope);
      this.syncThreadToFrame(pendingProjection.thread, null, scope);
      this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: true }, scope);
      if (!pending.threadId) {
        await this.loadThread(scope);
        if (!this.isCurrent(scope)) return;
        pending.threadId = this.getCachedThread(scope.account, scope.user, scope.agentId).id;
        if (!pending.threadId || this.currentRunId) {
          this.submitPending = false; pending.delivery = "failed"; save("advisor_pending_v1", this.pendingRequests);
          if (!this.getDraft(scope.account, scope.user, scope.agentId)) this.setDraft(scope.account, scope.user, scope.agentId, message);
          this.syncThreadToFrame(this.projectionForScope(scope).thread, null, scope);
          this.problem({ error: "会话暂时不可用，请重试" }, scope, "send"); return;
        }
        save("advisor_pending_v1", this.pendingRequests);
      }
      const payload = { account: scope.account, user: scope.user, agentId: scope.agentId,
        threadId: pending.threadId, message, requestId: pending.requestId };
      this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: true }, scope);
      const result = await this.fetchJson("/api/advisor/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!this.isCurrent(scope)) {
        if (id(result?.run?.id) && result.run.threadId === pending.threadId) {
          this.acknowledgePending(scope, pending, result.run);
          void this.stopForScope(scope, result.run.id);
        }
        return;
      }
      this.submitPending = false;
      if (!id(result?.run?.id) || result.run.threadId !== pending.threadId) {
        pending.delivery = "failed"; save("advisor_pending_v1", this.pendingRequests);
        if (!this.getDraft(scope.account, scope.user, scope.agentId)) this.setDraft(scope.account, scope.user, scope.agentId, message);
        this.syncThreadToFrame(this.projectionForScope(scope).thread, null, scope);
        this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: false }, scope); this.problem(result, scope, "send"); return;
      }
      delete this.pendingRequests[key]; save("advisor_pending_v1", this.pendingRequests);
      const thread = this.getCachedThread(scope.account, scope.user, scope.agentId);
      const messageId = id(result.run.messageId) ? result.run.messageId : pending.requestId;
      if (!thread.messages.some(item => item.id === messageId)) thread.messages.push({ id: messageId,
        requestId: pending.requestId, role: "user", text: message, createdAtMs: pending.createdAtMs || Date.now() });
      thread._advisorRun = result.run;
      this.setCachedThread(scope.account, scope.user, scope.agentId, thread);
      this.flushThreadCache();
      if (this.getDraft(scope.account, scope.user, scope.agentId) === message) this.setDraft(scope.account, scope.user, scope.agentId, "");
      this.syncThreadToFrame(thread, result.run, scope);
      if (!TERMINAL.has(result.run.state)) void this.pollEvents(result.run.id, scope); else await this.loadThread(scope);
    },
    applyEvent(thread, event, runId, buffers) {
      if (event.type === "text") {
        const messageId = id(event.messageId) ? event.messageId : `${runId}:assistant`;
        const content = (buffers[messageId] || "") + (event.text || ""); buffers[messageId] = content;
        let message = thread.messages.find(item => item.id === messageId);
        if (!message) { message = { id: messageId, runId, role: "assistant", text: "", createdAtMs: Date.now() }; thread.messages.push(message); }
        if (!message.text.startsWith(content) || content.length >= message.text.length) message.text = content;
        return message;
      }
      return null;
    },
    async pollEvents(runId, scope = this.captureScope()) {
      if (!this.isCurrent(scope)) return;
      this.abortCurrentPoll();
      const controller = new AbortController(); this.pollAbortController = controller; this.currentRunId = runId;
      let after = 0; const buffers = {};
      let phaseEvent = this.threadProjection?.run?.phaseEvent || null;
      while (!controller.signal.aborted && this.isCurrent(scope) && this.currentRunId === runId) {
        const query = new URLSearchParams({ account: scope.account, user: scope.user, runId, after: String(after) });
        const data = await this.fetchJson(`/api/advisor/events?${query}`, { signal: controller.signal });
        if (controller.signal.aborted || !this.isCurrent(scope) || this.currentRunId !== runId) return;
        if (!Array.isArray(data?.events) || data.run?.id !== runId) { this.pollError = true; this.problem(data, scope, "poll"); return; }
        this.clearProblem("poll", scope);
        let thread = this.getCachedThread(scope.account, scope.user, scope.agentId);
        const changedMessages = new Map();
        for (const rawEvent of data.events) {
          if (!object(rawEvent) || !Number.isSafeInteger(rawEvent.seq) || rawEvent.seq <= after ||
            !["status", "text", "reasoning", "skill", "done", "error"].includes(rawEvent.type) ||
            (rawEvent.text !== undefined && !text(rawEvent.text, 2000000)) ||
            (rawEvent.state !== undefined && !text(rawEvent.state, 60)) ||
            (rawEvent.next !== undefined && (!Number.isSafeInteger(rawEvent.next) || rawEvent.next < 0)) ||
            (rawEvent.attempt !== undefined && (!Number.isSafeInteger(rawEvent.attempt) || rawEvent.attempt < 0))) continue;
          const event = Object.fromEntries(Object.entries(rawEvent).filter(([key]) =>
            ["seq", "type", "text", "state", "messageId", "skillId", "next", "attempt"].includes(key)));
          after = event.seq;
          const changed = this.applyEvent(thread, event, runId, buffers);
          if (changed) {
            changedMessages.set(changed.id, changed);
            phaseEvent = { state: "answering" };
          } else if (event.type === "reasoning" && event.text?.trim()) phaseEvent = { state: "thinking" };
          else if (event.type === "status") phaseEvent = event;
          else if (event.type === "error") phaseEvent = { state: "error", text: event.text || "生成失败" };
          else if (event.type === "skill") phaseEvent = { state: "thinking", text: `正在使用技能 · ${event.skillId || event.text || ""}` };
        }
        if (!data.events.length && data.run.phase && phaseEvent?.state !== data.run.phase)
          phaseEvent = { state: data.run.phase };
        const previousRun = this.threadProjection?.run;
        const run = { ...data.run, ...(phaseEvent ? { phaseEvent } : {}) };
        const runSignature = value => JSON.stringify([value?.state, value?.phase, value?.error,
          value?.phaseEvent?.state, value?.phaseEvent?.text, value?.phaseEvent?.next, value?.phaseEvent?.attempt]);
        const runChanged = runSignature(run) !== runSignature(previousRun);
        if (validThread(data.thread, scope)) {
          thread = data.thread;
        }
        thread._advisorRun = run;
        if (changedMessages.size || runChanged || TERMINAL.has(run.state)) this.setCachedThread(scope.account, scope.user, scope.agentId, thread);
        this.threadProjection = { scope, thread, run };
        if (TERMINAL.has(run.state)) {
          this.currentRunId = null; this.stopPending = false;
          this.flushThreadCache(); this.syncThreadToFrame(thread, run, scope); return;
        }
        if (changedMessages.size || runChanged) this.postToFrame("ADVISOR_STREAM_UPDATE", {
          threadId: thread.id, run, messages: [...changedMessages.values()]
        }, scope);
        await new Promise(resolve => setTimeout(resolve, data.events.length ? 50 : 200));
      }
    },
    async stopForScope(scope, runId) {
      if (!runId || !scope.account || !scope.user) return;
      return this.fetchJson("/api/advisor/stop", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: scope.account, user: scope.user, runId }) });
    },
    async stopRun() {
      const scope = this.captureScope(), runId = this.currentRunId;
      if (!runId || !this.isCurrent(scope) || this.stopPending) return;
      this.stopPending = true; this.postToFrame("ADVISOR_STOP_STATE", { pending: true }, scope);
      const result = await this.fetchJson("/api/advisor/stop", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: scope.account, user: scope.user, runId }) });
      if (!this.isCurrent(scope) || this.currentRunId !== runId) return;
      this.stopPending = false; this.postToFrame("ADVISOR_STOP_STATE", { pending: false }, scope);
      if (result?.run?.id !== runId) { this.problem(result, scope, "poll"); return; }
      if (TERMINAL.has(result.run.state)) {
        this.abortCurrentPoll(); this.syncThreadToFrame(this.getCachedThread(scope.account, scope.user, scope.agentId), result.run, scope);
        await this.loadThread(scope);
      } else if (this.pollError) void this.pollEvents(runId, scope);
    },
    async newThread(agentId = this.activeAgentId, resetCommand = false) {
      const scope = this.captureScope();
      if (!scope.account || !scope.user || agentId !== scope.agentId || this.submitPending) return;
      this.submitPending = true;
      this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: true }, scope);
      const result = await this.fetchJson("/api/advisor/new-thread", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: scope.account, user: scope.user, agentId: scope.agentId }) });
      if (!this.isCurrent(scope)) return;
      this.submitPending = false;
      if (!validThread(result?.thread, scope)) {
        this.postToFrame("ADVISOR_SUBMIT_STATE", { pending: false }, scope); this.problem(result, scope, "send"); return;
      }
      this.clearProblem(null, scope);
      this.generation++; this.abortCurrentPoll(); const next = this.captureScope();
      if (resetCommand && /^\s*\/reset\s*$/.test(this.getDraft(scope.account, scope.user, scope.agentId))) {
        this.setDraft(scope.account, scope.user, scope.agentId, "");
      }
      delete this.pendingRequests[this.scopeKey(scope.account, scope.user, scope.agentId)]; save("advisor_pending_v1", this.pendingRequests);
      this.setCachedThread(scope.account, scope.user, scope.agentId, result.thread); this.syncThreadToFrame(result.thread, result.run, next);
      this.flushThreadCache();
      await this.loadThreads(next);
    },
    retryRun() {
      if (this.currentRunId) { void this.pollEvents(this.currentRunId); return; }
      const scope = this.captureScope(), pending = this.pendingRequests[this.scopeKey(scope.account, scope.user, scope.agentId)];
      const previous = this.getCachedThread(scope.account, scope.user, scope.agentId).messages.filter(item => item.role === "user").at(-1);
      return this.startRun(pending?.message || this.getDraft(scope.account, scope.user, scope.agentId) || previous?.text || "");
    },
    async openThread(threadId) {
      const scope = this.captureScope();
      if (!this.isCurrent(scope) || !scope.account || !scope.user || !id(scope.agentId) ||
        !id(threadId) || this.submitPending) return;
      if (this.getCachedThread(scope.account, scope.user, scope.agentId).id === threadId) return;
      // Leaving a conversation that is still generating stops it, exactly like switching person.
      this.generation++; this.abortCurrentPoll();
      // The bump above invalidates the captured scope, so the load runs under a fresh one;
      // reusing `scope` made every history switch stop the run and then load nothing.
      const next = this.captureScope();
      await this.loadThread(next, threadId);
      if (!this.isCurrent(next)) return;
      await this.loadThreads(next);
    },
    async deleteThread(threadId) {
      const scope = this.captureScope();
      if (!this.isCurrent(scope) || !scope.account || !scope.user || !id(scope.agentId) ||
        !id(threadId) || this.submitPending) return;
      const wasActive = this.getCachedThread(scope.account, scope.user, scope.agentId).id === threadId;
      if (wasActive) {
        // The conversation on screen is going away, so its run has to stop first.
        this.generation++; this.abortCurrentPoll();
      }
      try {
        await this.fetchJson("/api/advisor/threads/delete", { method: "POST",
          body: JSON.stringify({ account: scope.account, user: scope.user, agentId: scope.agentId, threadId }) });
      } catch (error) {
        this.problem(error, scope, "load");
        await this.loadThreads(scope);
        return;
      }
      if (!this.isCurrent(scope)) return;
      if (wasActive) await this.loadThread(this.captureScope());
      await this.loadThreads(this.captureScope());
    },
    async loadThreads(scope = this.captureScope()) {
      if (!this.isCurrent(scope) || !scope.account || !scope.user || !scope.agentId || !this.catalogReady) return;
      const serial = ++this.historySerial;
      const query = new URLSearchParams({ account: scope.account, user: scope.user, agentId: scope.agentId });
      // Reading the cached thread must not be able to abort the refresh: without this the
      // frame stayed on「正在读取历史…」for ever and the menu looked broken.
      let activeId = "";
      try {
        activeId = this.getCachedThread(scope.account, scope.user, scope.agentId).id || "";
      } catch (_) {
        activeId = "";
      }
      let data = null, failure = "";
      try {
        data = await this.fetchJson(`/api/advisor/threads?${query}`);
      } catch (error) {
        data = null;
        // Keep the reason: "读取失败" alone cannot be acted on, and the console is the only
        // other place it would show up.
        failure = String(error?.code || error?.message || error || "").slice(0, 40);
        console.warn("advisor history load failed", error);
      }
      if (!this.isCurrent(scope) || serial !== this.historySerial) return;
      if (!data || !Array.isArray(data.threads) || !data.threads.every(validThreadSummary)) {
        this.clearProblem("load", scope);
        this.postToFrame("ADVISOR_SET_THREADS", {
          threads: [],
          error: (failure ? `历史读取失败：${failure}，点此重试` : "历史读取失败，点此重试").slice(0, 120),
          activeThreadId: activeId,
        }, scope);
        return;
      }
      this.clearProblem("load", scope);
      this.postToFrame("ADVISOR_SET_THREADS", {
        threads: data.threads, activeThreadId: activeId,
      }, scope);
    },
    onSessionChanged(account, user) {
      account = typeof account === "string" ? account : ""; user = typeof user === "string" ? user : "";
      if (this.currentAccount === account && this.currentUser === user) return;
      this.flushThreadCache();
      void this.stopForScope(this.captureScope(), this.currentRunId);
      this.generation++; this.abortCurrentPoll(); this.submitPending = false;
      this.currentAccount = account; this.currentUser = user; void this.loadThread();
      void this.loadThreads(this.captureScope());
    },
    onAccountCleared(account) {
      this.clearedAccounts.add(account);
      const oldScope = this.captureScope(), oldRun = this.currentRunId;
      if (oldScope.account === account) {
        this.generation++; this.abortCurrentPoll(); this.submitPending = false;
        this.currentAccount = ""; this.currentUser = "";
      }
      if (this.threadProjection?.scope.account === account) this.threadProjection = null;
      if (this.lastProblem?.scope.account === account) this.lastProblem = null;
      let storageFailed = false;
      for (const [storageKey, data] of [["advisor_drafts_v1", this.drafts], ["advisor_threads_v1", this.threadCache],
        ["advisor_pending_v1", this.pendingRequests]]) {
        for (const key of Object.keys(data)) {
          let matches = data[key]?.account === account || key.startsWith(`${account}::`);
          try { matches ||= JSON.parse(key)[0] === account; } catch {}
          if (matches) delete data[key];
        }
        if (!save(storageKey, data)) storageFailed = true;
      }
      if (oldScope.account === account) {
        this.syncThreadToFrame(this.getCachedThread("", "", this.activeAgentId));
        if (oldRun) void this.fetchJson("/api/advisor/stop", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: oldScope.account, user: oldScope.user, runId: oldRun }) });
      }
      if (storageFailed) throw new Error("军师本地缓存清理失败");
    },
    onViewChanged(view) {
      const keepPanel = view === "chat" || view === "persona";
      if (!keepPanel && this.currentRunId) void this.stopForScope(this.captureScope(), this.currentRunId);
      this.currentView = view;
      if (!keepPanel && this.panelVisible) void this.togglePanel(false);
    },
    async togglePanel(force) {
      if (typeof window.desktopHost?.toggleAdvisor !== "function") {
        if (typeof alert === "function") alert("聊天助手需要在桌面客户端中使用"); return false;
      }
      try {
        const result = await window.desktopHost.toggleAdvisor(force);
        if (typeof result?.error === "string" && result.error) throw new Error(result.error);
        const visible = typeof result === "boolean" ? result : result?.visible;
        if (typeof visible !== "boolean") throw new Error("军师窗口未返回状态");
        this.panelVisible = visible;
        document.getElementById("btnToolbarAdvisor")?.classList.toggle("active", visible);
        if (!visible && this.currentRunId) void this.stopRun();
        if (visible) {
          if (!this.catalogReady) await this.loadCatalog(); else await this.loadThread();
          void this.loadModelProfiles();
          this.initFrameHandshake();
        }
        return visible;
      } catch (error) {
        if (typeof alert === "function") alert(error.message || "军师窗口打开失败"); return false;
      }
    },
    initFrameHandshake() {
      const projection = this.projectionForScope();
      this.postToFrame("ADVISOR_INIT", { activeAgentId: this.activeAgentId, enabledTemplates: this.getEnabledTemplates(),
        thread: projection.thread, run: projection.run,
        draft: this.getDraft(this.currentAccount, this.currentUser, this.activeAgentId), catalogReady: this.catalogReady,
        engineState: this.catalogReady ? this.catalog.engine.state : "unknown",
        theme: document.body.classList.contains("theme-light") ? "light" : "dark" });
    },
    validFrameRequest(data) {
      if (!object(data) || data.envelope !== "advisor" || data.nonce !== this.handshakeNonce || !object(data.payload)) return false;
      if (Object.keys(data).some(key => !["envelope", "nonce", "type", "payload", "scope"].includes(key))) return false;
      const allowed = { ADVISOR_FRAME_READY: [], ADVISOR_SWITCH_TEMPLATE: ["agentId"], ADVISOR_SEND: ["text", "agentId"],
        ADVISOR_STOP: [], ADVISOR_RETRY: ["retryKind"], ADVISOR_NEW_THREAD: [],
        ADVISOR_DRAFT_UPDATE: ["draft", "agentId"], ADVISOR_COPY: ["text"], ADVISOR_SELECT_MODEL: ["profileId"],
        ADVISOR_OPEN_THREAD: ["threadId"], ADVISOR_HISTORY_REQUEST: [],
        ADVISOR_DELETE_THREAD: ["threadId"] };
      if (!allowed[data.type] || Object.keys(data.payload).some(key => !allowed[data.type].includes(key))) return false;
      if (data.type === "ADVISOR_FRAME_READY") return true;
      if (!object(data.scope) || !this.isCurrent(data.scope) ||
        Object.keys(data.scope).some(key => !["account", "user", "agentId", "generation"].includes(key))) return false;
      if (data.payload.agentId !== undefined && (!id(data.payload.agentId) ||
        (data.type !== "ADVISOR_SWITCH_TEMPLATE" && data.payload.agentId !== this.activeAgentId))) return false;
      if (data.type === "ADVISOR_SWITCH_TEMPLATE") return this.getEnabledTemplates().some(agent => agent.id === data.payload.agentId);
      if (data.type === "ADVISOR_SELECT_MODEL") return data.payload.profileId === null ||
        (id(data.payload.profileId) && this.modelProfiles.some(profile => profile.id === data.payload.profileId));
      if (data.type === "ADVISOR_SEND") return text(data.payload.text, 16000) && data.payload.text.trim().length > 0;
      if (data.type === "ADVISOR_DRAFT_UPDATE") return text(data.payload.draft, 16000);
      if (data.type === "ADVISOR_COPY") return text(data.payload.text, 2000000);
      if (data.type === "ADVISOR_RETRY") return ["send", "poll", "load", "catalog"].includes(data.payload.retryKind);
      return true;
    },
    setupFrameCommunication() {
      if (typeof window.desktopHost?.onAdvisorEnvelope !== "function") return;
      window.desktopHost.onAdvisorEnvelope(data => {
        if (object(data) && data.type === "ADVISOR_WINDOW_READY" && Object.keys(data).length === 1) {
          this.frameReady = false; this.handshakeNonce = nonce("adv_"); this.initFrameHandshake(); return;
        }
        if (object(data) && data.type === "ADVISOR_WINDOW_CLOSED" && Object.keys(data).length === 1) {
          this.panelVisible = false; this.frameReady = false;
          document.getElementById("btnToolbarAdvisor")?.classList.remove("active");
          if (this.currentRunId) void this.stopRun(); return;
        }
        if (!this.validFrameRequest(data)) return;
        const { type, payload } = data;
        if (type === "ADVISOR_FRAME_READY") { this.frameReady = true; this.syncReadyFrame(); return; }
        if (type === "ADVISOR_SWITCH_TEMPLATE") {
          if (payload.agentId === this.activeAgentId) return;
          void this.stopForScope(this.captureScope(), this.currentRunId);
          this.generation++; this.abortCurrentPoll(); this.submitPending = false; this.activeAgentId = payload.agentId;
          save("advisor_active_agent", this.activeAgentId); this.syncTemplatesToFrame(); void this.loadThread();
        } else if (type === "ADVISOR_SEND") void this.startRun(payload.text, payload.agentId);
        else if (type === "ADVISOR_SELECT_MODEL") void this.selectModelProfile(payload.profileId);
        else if (type === "ADVISOR_NEW_THREAD") void this.newThread();
      else if (type === "ADVISOR_HISTORY_REQUEST") void this.loadThreads();
      else if (type === "ADVISOR_DELETE_THREAD") void this.deleteThread(payload.threadId);
        else if (type === "ADVISOR_OPEN_THREAD") void this.openThread(payload.threadId);
        else if (type === "ADVISOR_STOP") void this.stopRun();
        else if (type === "ADVISOR_DRAFT_UPDATE") this.setDraft(this.currentAccount, this.currentUser, this.activeAgentId, payload.draft);
        else if (type === "ADVISOR_RETRY") {
          if (payload.retryKind === "catalog") void this.loadCatalog();
          else if (payload.retryKind === "load") void this.loadThread(); else void this.retryRun();
        } else if (type === "ADVISOR_COPY") void this.copyText(payload.text);
      });
    },
    async copyText(value) {
      const scope = this.captureScope();
      try {
        let copied = false;
        if (typeof window.desktopHost?.copyDraft === "function") copied = await window.desktopHost.copyDraft(value);
        if (!copied && window.navigator?.clipboard?.writeText) { await window.navigator.clipboard.writeText(value); copied = true; }
        if (this.isCurrent(scope)) this.postToFrame("ADVISOR_COPY_RESULT", { copied }, scope);
      } catch { if (this.isCurrent(scope)) this.postToFrame("ADVISOR_COPY_RESULT", { copied: false }, scope); }
    },
    openRepository() { void this.loadCatalog(); },
    renderRepository() {
      const container = document.getElementById("advisorRepoContainer"); if (!container) return; container.replaceChildren();
      const header = element("div", "advisor-repo-header"), titleWrap = element("div", "advisor-repo-title-wrap");
      titleWrap.appendChild(element("h2", "advisor-repo-title", "助手仓库"));
      header.appendChild(titleWrap); const actions = element("div", "advisor-repo-actions");
      actions.appendChild(button("新建助手", () => this.showImportAssistantModal(), "advisor-btn advisor-btn-primary", !this.catalogReady));
      actions.appendChild(button("刷新", () => this.loadCatalog(), "advisor-btn", this.catalogBusy));
      header.appendChild(actions); container.appendChild(header);
      if (this.catalogError) container.appendChild(element("div", "advisor-repo-error", this.catalogError));
      const grid = element("div", "advisor-card-grid");
      if (this.catalogReady) for (const agent of this.catalog.agents) {
        const card = element("div", `advisor-agent-card${agent.enabled ? " enabled" : ""}`), top = element("div", "advisor-card-top");
        const identity = element("div", "advisor-card-identity"); identity.appendChild(element("h3", "advisor-card-name", agent.name));
        top.appendChild(identity);
        const toggle = button("", () => this.enableTemplate(agent.id, !agent.enabled), `advisor-switch${agent.enabled ? " checked" : ""}`);
        toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-checked", String(agent.enabled));
        toggle.setAttribute("aria-label", `${agent.enabled ? "停用" : "启用"}${agent.name}`); top.appendChild(toggle); card.appendChild(top);
        if (agent.description) card.appendChild(element("p", "advisor-card-desc", agent.description));
        const tags = element("div", "advisor-card-skills");
        for (const skillId of agent.skillIds) tags.appendChild(element("span", "advisor-skill-tag", this.catalog.skills.find(item => item.id === skillId)?.name || skillId));
        card.appendChild(tags); const bottom = element("div", "advisor-card-bottom");
        bottom.appendChild(button("编辑", () => this.showEditAgentModal(agent)));
        bottom.appendChild(button("删除", () => {
          if (typeof confirm === "function" && confirm(`删除「${agent.name}」？`)) void this.deleteTemplate(agent.id);
        }));
        card.appendChild(bottom); grid.appendChild(card);
      }
      container.appendChild(grid);
      if (this.catalogReady && this.catalog.agents.length === 0)
        container.appendChild(element("div", "advisor-repo-empty", "暂无助手"));
    },
    showEditAgentModal(agent) {
      if (!agent) {
        this.showImportAssistantModal();
        return;
      }
      const modal = makeModal("编辑助手");
      const name = field(modal.card, "名称", agent?.name || "", 60), description = field(modal.card, "描述", agent?.description || "", 240);
      const welcome = field(modal.card, "欢迎语", agent?.welcome || "", 120);
      const prompt = field(modal.card, "提示词", agent?.prompt || "", 16000, true);
      const group = element("div", "advisor-form-group"), skillHeader = element("div", "advisor-skill-header");
      skillHeader.appendChild(element("label", "advisor-form-label", "技能"));
      const selected = new Set(agent?.skillIds || []), list = element("div", "advisor-skill-list");
      list.tabIndex = 0; list.setAttribute("aria-label", "技能");
      let deleting = false;
      const toggleDelete = button("移除技能", () => {
        deleting = !deleting; toggleDelete.classList.toggle("active", deleting);
        toggleDelete.setAttribute("aria-pressed", String(deleting)); renderSkills();
      }, "advisor-skill-delete-toggle");
      toggleDelete.setAttribute("aria-pressed", "false"); skillHeader.appendChild(toggleDelete);
      function renderSkills() {
        list.replaceChildren();
        for (const [index, skill] of Advisor.catalog.skills.entries()) {
          const row = element("div", "advisor-skill-row");
          row.style.gridColumn = String(Math.floor(index % 10 / 5) + 1);
          row.style.gridRow = String(Math.floor(index / 10) * 5 + index % 5 + 1);
          const label = element("label", "advisor-skill-choice"), checkbox = document.createElement("input");
          checkbox.type = "checkbox"; checkbox.value = skill.id; checkbox.checked = selected.has(skill.id);
          checkbox.addEventListener("change", () => checkbox.checked ? selected.add(skill.id) : selected.delete(skill.id));
          label.title = skill.name;
          label.appendChild(checkbox); label.appendChild(element("span", "advisor-skill-name", skill.name)); row.appendChild(label);
          if (deleting) {
            const remove = button("\u00d7", () => {
              selected.delete(skill.id); renderSkills();
            }, "advisor-skill-remove");
            remove.setAttribute("aria-label", "从当前助手移除" + skill.name); remove.title = "从当前助手移除" + skill.name;
            remove.hidden = !selected.has(skill.id); row.appendChild(remove);
          }
          list.appendChild(row);
        }
      }
      renderSkills(); group.appendChild(skillHeader); group.appendChild(list);
      modal.card.appendChild(group);
      finishModal(modal, "保存", async () => {
        if (!name.value.trim() || !prompt.value.trim()) { if (typeof alert === "function") alert("请输入名称和提示词"); return false; }
        return this.saveTemplate({ id: agent?.id, name: name.value, description: description.value, prompt: prompt.value, welcome: welcome.value,
          skillIds: [...selected].filter(skillId => this.catalog.skills.some(skill => skill.id === skillId)) });
      });
    },
    showImportSkillModal() {
      const modal = makeModal("导入技能"), name = field(modal.card, "名称", "", 60), description = field(modal.card, "描述", "", 240);
      const content = field(modal.card, "SKILL.md", "", 24000, true);
      finishModal(modal, "导入", () => this.importSkill({ name: name.value, description: description.value, content: content.value }, modal.reportError));
    },
    showImportAssistantModal() {
      const modal = makeModal("新建助手");
      modal.card.classList.add("advisor-import-modal");
      let preview = null, serial = 0, closed = false, busy = false, committing = false, requestId = nonce("req_");
      const cancelPreview = value => value && this.fetchJson("/api/advisor/import/cancel", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: value.id }) });
      const close = () => { if (committing) return; closed = true; serial++; void cancelPreview(preview); modal.overlay.remove(); };
      const url = field(modal.card, "GitHub 地址", "", 2048), sources = element("div", "advisor-import-sources");
      const summary = element("div", "advisor-import-summary"); summary.hidden = true;
      const name = field(modal.card, "名称", "", 60), description = field(modal.card, "描述", "", 240);
      const welcome = field(modal.card, "欢迎语", "", 120), prompt = field(modal.card, "提示词", "", 16000, true);
      const acknowledgement = element("label", "advisor-import-ack"), accept = document.createElement("input");
      accept.type = "checkbox"; acknowledgement.appendChild(accept); acknowledgement.appendChild(document.createTextNode("使用只读适配版本"));
      acknowledgement.hidden = true;
      const actions = element("div", "advisor-modal-actions"), cancel = button("取消", close);
      const create = button("导入并创建", async () => {
        if (busy || closed) return;
        if (!preview) await load({ kind: "github", url: url.value.trim() });
        if (closed || !preview || (preview.compatibility.state === "partial" && !accept.checked)) return;
        busy = true; committing = true; update(); modal.reportError("");
        const result = await this.fetchJson("/api/advisor/import/commit", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previewId: preview.id, requestId, acceptPartial: accept.checked,
            agent: { name: name.value.trim(), description: description.value.trim(), prompt: prompt.value, welcome: welcome.value.trim() } }) });
        busy = false; committing = false;
        if (!closed && validCatalog(result) && id(result.importedAgentId)) {
          this.catalog = result; this.catalogReady = true; this.catalogError = "";
          this.syncTemplatesToFrame(); this.renderRepository(); close();
        } else if (!closed) { modal.reportError(errorText(result)); update(); }
      }, "advisor-btn advisor-btn-primary", true);
      const update = () => {
        create.disabled = busy || (!preview && !url.value.trim()) || (preview?.compatibility.state === "partial" && !accept.checked);
        cancel.disabled = committing; for (const item of sources.children) item.disabled = busy;
      };
      accept.addEventListener("change", update);
      url.addEventListener("input", () => {
        if (preview) { void cancelPreview(preview); preview = null; summary.hidden = true; acknowledgement.hidden = true; }
        update();
      });
      const load = async source => {
        if (closed || busy) return;
        const sequence = ++serial; busy = true; update(); modal.reportError("");
        void cancelPreview(preview); preview = null; requestId = nonce("req_");
        const result = await this.fetchJson("/api/advisor/import/preview", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source }) });
        const value = result?.preview;
        if (closed || sequence !== serial) { void cancelPreview(value); return; }
        busy = false;
        if (!object(value) || !/^imp_[a-f0-9]{32}$/.test(value.id) || !text(value.name, 60) ||
          !text(value.description, 240) || !text(value.defaultPrompt, 16000) || !text(value.welcome, 120) ||
          !Number.isSafeInteger(value.resourceCount) || value.resourceCount < 0 || value.resourceCount > 128 ||
          !["readonly", "partial"].includes(value.compatibility?.state) || !Array.isArray(value.compatibility.warnings)) {
          modal.reportError(errorText(result)); summary.hidden = true; acknowledgement.hidden = true; update(); return;
        }
        preview = value; name.value = value.name; description.value = value.description;
        welcome.value = value.welcome; prompt.value = value.defaultPrompt; accept.checked = false;
        summary.replaceChildren();
        summary.appendChild(element("div", "advisor-import-state", value.compatibility.state === "readonly" ? "只读可用" : "只读适配"));
        summary.appendChild(element("div", "advisor-import-resource-count", `${value.resourceCount} 份参考资料`));
        for (const warning of value.compatibility.warnings) if (text(warning, 2000)) summary.appendChild(element("div", "advisor-import-warning", warning));
        summary.hidden = false; acknowledgement.hidden = value.compatibility.state !== "partial"; update();
      };
      sources.appendChild(button("读取", () => load({ kind: "github", url: url.value.trim() })));
      for (const [kind, label] of [["file", "文件 / ZIP"], ["directory", "文件夹"]]) sources.appendChild(button(label, async () => {
        if (busy) return;
        if (typeof window.desktopHost?.chooseAssistantPackage !== "function") { modal.reportError("请在桌面客户端选择文件"); return; }
        let selected;
        try { selected = await window.desktopHost.chooseAssistantPackage(kind); }
        catch { modal.reportError("文件选择失败，请重试"); return; }
        if (closed || !selected) return;
        if (!/^imp_[a-f0-9]{32}$/.test(selected.token)) { modal.reportError(errorText(selected)); return; }
        void load({ kind: "local", token: selected.token });
      }));
      modal.card.insertBefore(sources, name.parentNode); modal.card.insertBefore(summary, name.parentNode);
      modal.card.insertBefore(acknowledgement, name.parentNode);
      actions.appendChild(cancel); actions.appendChild(create); modal.card.appendChild(actions);
    },
    init() {
      this.setupFrameCommunication(); void this.loadCatalog();
      if (typeof window.MutationObserver === "function") {
        new window.MutationObserver(() => this.postToFrame("ADVISOR_THEME", {
          theme: document.body.classList.contains("theme-light") ? "light" : "dark"
        })).observe(document.body, { attributes: true, attributeFilter: ["class"] });
      }
    }
  };
  function element(tag, className, content) {
    const result = document.createElement(tag); result.className = className; if (content !== undefined) result.textContent = content; return result;
  }
  function button(label, action, className = "advisor-btn", disabled = false) {
    const result = element("button", className, label); result.type = "button"; result.disabled = disabled; result.addEventListener("click", action); return result;
  }
  function makeModal(title) {
    const overlay = element("div", "advisor-modal-overlay"), card = element("div", "advisor-modal-card");
    card.appendChild(element("h3", "advisor-modal-title", title));
    const error = element("div", "advisor-modal-error"); error.setAttribute("role", "alert"); error.hidden = true;
    card.appendChild(error); overlay.appendChild(card); document.body.appendChild(overlay);
    return { overlay, card, reportError(value) { error.textContent = value; error.hidden = !value; } };
  }
  function field(card, label, value, maxLength, multiline = false) {
    const group = element("div", "advisor-form-group"); group.appendChild(element("label", "advisor-form-label", label));
    const input = element(multiline ? "textarea" : "input", multiline ? "advisor-textarea-form" : "advisor-input");
    input.value = value; input.maxLength = maxLength; if (multiline) input.rows = 6; group.appendChild(input); card.appendChild(group); return input;
  }
  function finishModal(modal, label, action) {
    const actions = element("div", "advisor-modal-actions"); actions.appendChild(button("取消", () => modal.overlay.remove()));
    const submit = button(label, async () => {
      submit.disabled = true; modal.reportError("");
      try { if (await action()) modal.overlay.remove(); }
      catch { modal.reportError("操作失败，请重试"); }
      finally { submit.disabled = false; }
    }, "advisor-btn advisor-btn-primary"); actions.appendChild(submit); modal.card.appendChild(actions);
  }
  // Settings owns the saved profiles. The assistant panel keeps running behind that modal, so
  // closing it is the moment the cached list can be stale — re-read instead of waiting for the
  // next open.
  window.addEventListener("model-source-settings-closed", () => {
    if (Advisor.panelVisible) void Advisor.loadModelProfiles();
  });
  window.Advisor = Advisor;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Advisor.init()); else Advisor.init();
})();
