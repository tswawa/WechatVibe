"use strict";

const { randomBytes } = require("node:crypto");
const path = require("node:path");
const WIDTH = 440;
const TITLEBAR_HEIGHT = 36;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const OUTBOUND = new Set(["ADVISOR_INIT", "ADVISOR_SET_TEMPLATES", "ADVISOR_SET_THREAD", "ADVISOR_SET_CONTEXT",
  "ADVISOR_SET_MODELS", "ADVISOR_STREAM_UPDATE", "ADVISOR_PROBLEM", "ADVISOR_SUBMIT_STATE", "ADVISOR_STOP_STATE",
  "ADVISOR_COPY_RESULT", "ADVISOR_THEME", "ADVISOR_SET_DRAFT", "ADVISOR_SET_THREADS"]);
const INBOUND = new Set(["ADVISOR_FRAME_READY", "ADVISOR_SWITCH_TEMPLATE", "ADVISOR_SEND", "ADVISOR_STOP",
  "ADVISOR_RETRY", "ADVISOR_NEW_THREAD", "ADVISOR_DRAFT_UPDATE", "ADVISOR_COPY", "ADVISOR_SELECT_MODEL",
  "ADVISOR_OPEN_THREAD", "ADVISOR_HISTORY_REQUEST", "ADVISOR_DELETE_THREAD"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);

function validEnvelope(value, types) {
  try {
    return object(value) && value.envelope === "advisor" && typeof value.nonce === "string" &&
      /^adv_[a-f0-9]{32}$/.test(value.nonce) && types.has(value.type) && object(value.payload) && object(value.scope) &&
      Object.keys(value).every(key => ["envelope", "nonce", "type", "payload", "scope"].includes(key)) &&
      Object.keys(value.scope).every(key => ["account", "user", "agentId", "generation"].includes(key)) &&
      ["account", "user", "agentId"].every(key => typeof value.scope[key] === "string" && value.scope[key].length <= 256) &&
      Number.isSafeInteger(value.scope.generation) && value.scope.generation >= 0 &&
      Buffer.byteLength(JSON.stringify(value)) <= MAX_ENVELOPE_BYTES;
  } catch { return false; }
}

function companionBounds(content) {
  return { x: content.width - WIDTH, y: TITLEBAR_HEIGHT,
    width: WIDTH, height: Math.max(0, content.height - TITLEBAR_HEIGHT) };
}

function attachAdvisorCompanion(options) {
  const { WebContentsView, ipcMain, screen, clipboard, mainWindow, clientUrl, trustedMainFrame } = options;
  const address = new URL("advisor-window.html", clientUrl).href;
  let child = null, showing = false, closing = false, arranging = false, modal = false, theme = "dark", latestInit = null, currentScope = null;
  let expandedBy = 0;
  const minimum = mainWindow.getMinimumSize();
  const themes = { dark: "#1b1b1b", light: "#ffffff" };
  function trustedChild(event) {
    return child && !child.webContents.isDestroyed() && event.sender === child.webContents &&
      event.senderFrame === child.webContents.mainFrame && event.senderFrame.url === address;
  }
  function emit(data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("advisor:to-main", data);
  }
  function layout() {
    if (arranging || mainWindow.isDestroyed()) return;
    if (showing && child && !child.webContents.isDestroyed()) child.setBounds(companionBounds(mainWindow.getContentBounds()));
    mainWindow.webContents.send("advisor:layout", { width: showing ? WIDTH : 0,
      mainWidth: mainWindow.getContentBounds().width - (showing ? WIDTH : 0) });
  }
  function expand() {
    if (showing) return true;
    const bounds = mainWindow.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    if (area.width < minimum[0] + WIDTH) return false;
    arranging = true;
    try {
      mainWindow.setMinimumSize(minimum[0] + WIDTH, minimum[1]);
      if (!mainWindow.isMaximized()) {
        const content = mainWindow.getContentBounds(), frame = bounds.width - content.width;
        mainWindow.setContentSize(Math.min(content.width + WIDTH, area.width - frame - 2), content.height);
        expandedBy = Math.max(0, mainWindow.getContentBounds().width - content.width);
        const actual = mainWindow.getBounds();
        const x = Math.max(area.x, Math.min(actual.x, area.x + area.width - actual.width));
        if (x !== actual.x) mainWindow.setBounds({ x });
      }
    } finally { arranging = false; }
    return true;
  }
  function conceal(notify = true) {
    if (!showing) return;
    showing = false;
    const targetWidth = Math.max(minimum[0], mainWindow.getContentBounds().width - expandedBy);
    mainWindow.webContents.send("advisor:layout", { width: 0,
      mainWidth: mainWindow.isMaximized() ? mainWindow.getContentBounds().width : targetWidth });
    if (child && !child.webContents.isDestroyed()) child.setVisible(false);
    arranging = true;
    try {
      mainWindow.setMinimumSize(...minimum);
      if (!mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
        const content = mainWindow.getContentBounds();
        mainWindow.setContentSize(targetWidth, content.height);
      }
      expandedBy = 0;
    } finally { arranging = false; }
    layout();
    if (notify) emit({ type: "ADVISOR_WINDOW_CLOSED" });
  }
  function create() {
    if (child && !child.webContents.isDestroyed()) return child;
    child = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, "advisor-preload.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false,
        additionalArguments: ["--advisor-channel=" + randomBytes(16).toString("hex")] },
    });
    const own = child;
    own.setBackgroundColor(themes[theme]); own.setVisible(false);
    mainWindow.contentView.addChildView(own);
    own.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    own.webContents.on("will-navigate", (event, target) => { if (target !== address) event.preventDefault(); });
    own.webContents.on("will-redirect", (event, target) => { if (target !== address) event.preventDefault(); });
    own.webContents.on("will-attach-webview", event => event.preventDefault());
    own.webContents.on("did-finish-load", () => {
      if (closing || own.webContents.isDestroyed()) return;
      emit({ type: "ADVISOR_WINDOW_READY" });
    });
    void own.webContents.loadURL(address); return own;
  }
  ipcMain.handle("advisor:toggle", (event, force) => {
    if (!trustedMainFrame(event) || (force !== undefined && typeof force !== "boolean") || closing) return { visible: false };
    const next = force === undefined ? !showing : force;
    if (!next) { conceal(); return { visible: false }; }
    if (!expand()) return { visible: false, error: "屏幕可用宽度不足，请调整系统缩放或移至更大的屏幕" };
    const companion = create(); showing = true; layout(); companion.setVisible(!modal); if (!modal) companion.webContents.focus();
    return { visible: true };
  });
  ipcMain.on("advisor:from-main", (event, data) => {
    if (!trustedMainFrame(event) || !validEnvelope(data, OUTBOUND) || closing) return;
    if (data.type === "ADVISOR_INIT") latestInit = data;
    if (data.type === "ADVISOR_INIT" || data.type === "ADVISOR_SET_TEMPLATES" || data.type === "ADVISOR_SET_THREAD") currentScope = data.scope;
    if (child && !child.webContents.isDestroyed()) child.webContents.send("advisor:to-window", data);
  });
  ipcMain.on("advisor:from-window", (event, data, activated) => {
    if (!trustedChild(event) || !validEnvelope(data, INBOUND) || !latestInit || data.nonce !== latestInit.nonce) return;
    if (data.type !== "ADVISOR_FRAME_READY" && (!showing || modal)) return;
    if (data.type !== "ADVISOR_FRAME_READY" && (!currentScope ||
      ["account", "user", "agentId", "generation"].some(key => data.scope[key] !== currentScope[key]))) return;
    if (data.type === "ADVISOR_COPY") {
      const text = data.payload.text;
      const copied = activated === true && showing && !modal && child.webContents.isFocused() && typeof text === "string" && text.length <= 1_000_000;
      if (copied) clipboard.writeText(text);
      child.webContents.send("advisor:to-window", { ...data, type: "ADVISOR_COPY_RESULT", payload: { copied } });
      return;
    }
    emit(data);
  });
  ipcMain.on("advisor:hide", event => { if (trustedChild(event)) conceal(); });
  ipcMain.on("advisor:modal", (event, value) => {
    if (!trustedMainFrame(event) || typeof value !== "boolean") return;
    modal = value;
    if (child && !child.webContents.isDestroyed()) child.setVisible(showing && !modal);
  });
  mainWindow.on("resize", layout);
  mainWindow.webContents.on("did-finish-load", layout);
  screen.on?.("display-metrics-changed", layout);
  return {
    setTheme(value) {
      if (!Object.hasOwn(themes, value)) return;
      theme = value;
      if (child && !child.webContents.isDestroyed()) child.setBackgroundColor(themes[value]);
    },
    close() {
      closing = true; showing = false;
      mainWindow.off("resize", layout);
      if (!mainWindow.isDestroyed()) mainWindow.webContents.off("did-finish-load", layout);
      screen.off?.("display-metrics-changed", layout);
      for (const channel of ["advisor:from-main", "advisor:from-window", "advisor:hide", "advisor:modal"]) ipcMain.removeAllListeners(channel);
      ipcMain.removeHandler("advisor:toggle");
      if (child) {
        if (!mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(child);
        if (!child.webContents.isDestroyed()) child.webContents.close({ waitForBeforeUnload: false });
      }
      child = null;
    },
  };
}

module.exports = { attachAdvisorCompanion, companionBounds, validEnvelope, WIDTH };
