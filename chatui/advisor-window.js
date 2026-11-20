"use strict";
(() => {
  // 主题色随创建 query 注入 iframe 首屏，避免默认绿先渲染一帧再被 THEME 消息改掉。
  // 手写解析而非 URLSearchParams：测试沙箱的 window 桩不提供该全局。
  const ACCENT = /^(green|blue|yellow|red|#[0-9a-f]{6})$/u;
  const queryAccent = (window.location?.search || "").match(/[?&]accent=([^&]+)/);
  const injectedAccent = queryAccent ? decodeURIComponent(queryAccent[1]) : "";
  let currentAccent = ACCENT.test(injectedAccent) ? injectedAccent : "green";
  const frameSrc = () => "advisor-frame.html" +
    (currentAccent === "green" ? "" : "?accent=" + encodeURIComponent(currentAccent));
  const frame = document.getElementById("advisorFrame");
  frame.src = frameSrc();
  document.getElementById("btnCloseAdvisor")?.addEventListener("click", () => window.advisorWindow?.hide());
  let init = null, loaded = false;
  const pending = new Map();
  let pendingScope = null;
  const bufferedTypes = new Set(["ADVISOR_SET_TEMPLATES", "ADVISOR_SET_THREAD", "ADVISOR_THEME",
    "ADVISOR_PROBLEM", "ADVISOR_SUBMIT_STATE", "ADVISOR_STOP_STATE", "ADVISOR_STREAM_UPDATE", "ADVISOR_SET_MODELS"]);
  const sameScope = (a, b) => a && b && ["account", "user", "agentId", "generation"].every(key => a[key] === b[key]);
  function buffer(data) {
    if (!bufferedTypes.has(data.type)) return;
    if (pendingScope && data.scope.generation < pendingScope.generation) return;
    if (!sameScope(pendingScope, data.scope)) { pending.clear(); pendingScope = data.scope; }
    if (data.type === "ADVISOR_STREAM_UPDATE" && pending.has(data.type)) {
      const previous = pending.get(data.type);
      if (previous.payload.threadId === data.payload.threadId && previous.payload.run?.id === data.payload.run?.id) {
        const messages = new Map((previous.payload.messages || []).map(message => [message.id, message]));
        for (const message of data.payload.messages || []) messages.set(message.id, message);
        data = { ...data, payload: { ...data.payload, messages: [...messages.values()].slice(-100) } };
      }
    }
    pending.delete(data.type);
    pending.set(data.type, data);
  }
  window.advisorWindow?.receive(data => {
    if (!data || data.envelope !== "advisor" || typeof data.nonce !== "string" || !data.scope) return;
    if (data.type === "ADVISOR_INIT") {
      const reset = init && init.nonce !== data.nonce;
      if (reset) { pending.clear(); pendingScope = null; }
      init = data;
      if (reset) { loaded = false; frame.src = frameSrc(); }
    }
    if ((data.type === "ADVISOR_INIT" || data.type === "ADVISOR_THEME") && ["light", "dark"].includes(data.payload?.theme))
      document.body.dataset.theme = data.payload.theme;
    if (data.type !== "ADVISOR_INIT" && typeof data.payload?.accent === "string" && ACCENT.test(data.payload.accent))
      currentAccent = data.payload.accent;
    if (loaded) frame.contentWindow.postMessage(data, "*");
    else buffer(data);
  });
  frame.addEventListener("load", () => {
    loaded = true;
    const replay = [...pending.values()]; pending.clear(); pendingScope = null;
    if (init) frame.contentWindow.postMessage(init, "*");
    for (const data of replay) if (init && data.nonce === init.nonce) frame.contentWindow.postMessage(data, "*");
  });
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== frame.contentWindow || !init || !data || data.envelope !== "advisor" || data.nonce !== init.nonce) return;
    window.advisorWindow?.send(data);
  });
})();
