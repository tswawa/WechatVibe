const { app, BrowserWindow, clipboard, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { monitorBridge } = require("./real-client-recovery.cjs");

const ROOT = process.env.WECHATVIBE_CLIENT_ROOT ?
  path.resolve(process.env.WECHATVIBE_CLIENT_ROOT) : path.resolve(__dirname, "..");
const THEMES = Object.freeze({
  dark: { color: "#1b1b1b", symbolColor: "#e6e7eb", height: 36 },
  light: { color: "#edf3f7", symbolColor: "#28333d", height: 36 },
});
const DOC_URLS = new Set([
  "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
  "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
  "https://github.com/tswawa",
  "https://github.com/tswawa/WechatVibe",
]);

function clientUrl(value) {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value)) return null;
  const url = new URL(value);
  const port = Number(url.port);
  return port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}/` : null;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = clientUrl(argument("--client-url"));
const selfTest = process.argv.includes("--self-test");
if (process.platform !== "win32" || !url) {
  process.stderr.write("real-client shell requires Windows and a validated loopback URL\n");
  app.exit(1);
} else {
  app.setAppUserModelId("com.local.wechatvibe.real-client");
  const userData = path.join(ROOT, ".local", selfTest ? "real-client-shell-self-test" : "real-client-shell");
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  let window = null;
  let stopBridgeMonitor = null;
  let exiting = false;
  const testState = { themes: [], blockedPopups: 0, themeWaiter: null };

  function trustedFrame(event) {
    return window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === url;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.focus();
      }
    });

    ipcMain.on("real-client:set-theme", (event, theme) => {
      if (!trustedFrame(event) || !Object.hasOwn(THEMES, theme)) return;
      window.setTitleBarOverlay(THEMES[theme]);
      if (selfTest) {
        testState.themes.push({ theme, ...THEMES[theme] });
        if (testState.themes.length === 2 && testState.themeWaiter) testState.themeWaiter();
      }
    });

    ipcMain.on("real-client:open-doc", (event, target, trusted, active) => {
      if (!trustedFrame(event) || trusted !== true || active !== true || typeof target !== "string") return;
      let parsed;
      try {
        parsed = new URL(target);
      } catch (_) {
        return;
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !DOC_URLS.has(parsed.href)) return;
      if (!selfTest) {
        void shell.openExternal(parsed.href);
      }
    });

    ipcMain.handle("real-client:copy-draft", (event, value) => {
      if (!trustedFrame(event) || typeof value !== "string" || !value.trim() || value.length > 1_000_000) return false;
      clipboard.writeText(value);
      return true;
    });

    ipcMain.handle("real-client:exit-app", (event) => {
      if (!trustedFrame(event)) return false;
      exiting = true;
      stopBridgeMonitor?.();
      setImmediate(() => app.quit());
      return true;
    });

    app.whenReady().then(() => {
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.on("will-download", (event) => event.preventDefault());
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        try {
          const scheme = new URL(details.url).protocol;
          callback({ cancel: scheme === "file:" || scheme === "ftp:" });
        } catch (_) {
          callback({ cancel: true });
        }
      });
      window = new BrowserWindow({
        width: 1180,
        height: 780,
        minWidth: 720,
        minHeight: 520,
        icon: path.join(ROOT, "chatui", "assets", "wechatvibe-icon.ico"),
        show: !selfTest,
        resizable: true,
        titleBarStyle: "hidden",
        titleBarOverlay: THEMES.dark,
        webPreferences: {
          preload: path.join(__dirname, "real-client-preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
          devTools: false,
        },
      });
      const contents = window.webContents;
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.on("will-navigate", (event, target) => {
        if (target !== url) event.preventDefault();
      });
      contents.on("will-redirect", (event, target) => {
        if (target !== url) event.preventDefault();
      });
      contents.setWindowOpenHandler((details) => {
        if (selfTest) testState.blockedPopups += 1;
        return { action: "deny" };
      });
      contents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
        if (selfTest && isMainFrame) {
          process.stdout.write(JSON.stringify({ ok: false, code, description, url: validatedUrl }) + "\n");
          app.exit(1);
        }
      });
      if (selfTest) {
        contents.once("did-finish-load", async () => {
          try {
            const themeDone = new Promise((resolve) => { testState.themeWaiter = resolve; });
            const result = await contents.executeJavaScript(
              "(async () => ({ platform: window.desktopHost?.platform, accepted: window.desktopHost?.setTheme('light'), darkAccepted: window.desktopHost?.setTheme('dark'), rejected: window.desktopHost?.setTheme('invalid'), frozen: Object.isFrozen(window.desktopHost), copyDraftExposed: typeof window.desktopHost?.copyDraft === 'function', emptyCopyRejected: await window.desktopHost?.copyDraft('') === false, nodeAccess: typeof require, popup: window.open('https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/') === null }))()",
            );
            await themeDone;
            process.stdout.write(JSON.stringify({ ok: true, hidden: !window.isVisible(), ...result,
              themes: testState.themes, blockedPopups: testState.blockedPopups }) + "\n");
            app.quit();
          } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + "\n");
            app.exit(1);
          }
        });
      }
      window.on("closed", () => { window = null; stopBridgeMonitor?.(); });
      if (!selfTest) stopBridgeMonitor = monitorBridge({
        root: ROOT, url,
        isOpen: () => !exiting && !!window && !window.isDestroyed(),
        onRecovered: () => { if (!exiting && window && !window.isDestroyed()) window.webContents.send("real-client:bridge-restored"); },
      });
      void contents.loadURL(url);
    }).catch((error) => {
      process.stderr.write(String(error) + "\n");
      app.exit(1);
    });
    app.on("before-quit", () => { exiting = true; stopBridgeMonitor?.(); });
    app.on("window-all-closed", () => app.quit());
  }
}
