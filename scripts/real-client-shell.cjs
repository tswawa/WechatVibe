const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { monitorBridge } = require("./real-client-recovery.cjs");
const { checkForUpdates, downloadAndStageUpdate, errorStatus, RELEASES_URL } = require("./real-client-update.cjs");
const { createUpdateProxyFetch } = require("./real-client-update-proxy.cjs");
const { ModelDownload } = require("./real-client-model.cjs");

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
  RELEASES_URL,
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
const instanceId = process.env.WECHATVIBE_INSTANCE_ID;
const updateValidation = process.env.WECHATVIBE_UPDATE_VALIDATE === "1";
const updateFinalReady = !updateValidation &&
  typeof process.env.WECHATVIBE_UPDATE_FINAL_READY_FILE === "string" &&
  typeof process.env.WECHATVIBE_UPDATE_FINAL_READY_NONCE === "string";
const updateReadyFile = updateValidation ? process.env.WECHATVIBE_UPDATE_READY_FILE :
  process.env.WECHATVIBE_UPDATE_FINAL_READY_FILE;
const updateReadyNonce = updateValidation ? process.env.WECHATVIBE_UPDATE_READY_NONCE :
  process.env.WECHATVIBE_UPDATE_FINAL_READY_NONCE;
if (process.platform !== "win32" || !url || (!selfTest && !/^[a-f0-9]{64}$/.test(instanceId || ""))) {
  process.stderr.write("real-client shell requires Windows and a validated loopback URL\n");
  app.exit(1);
} else {
  app.setAppUserModelId("com.local.wechatvibe.real-client");
  const userData = path.join(ROOT, ".local", selfTest ? "real-client-shell-self-test" : "real-client-shell");
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  let window = null;
  let stopBridgeMonitor = null;
  let validationTimer = null;
  let exiting = false;
  let updateHandoff = "none";
  let quitRequestedDuringHandoff = false;
  let bridgeExitState = "idle";
  let updateCheckPromise = null;
  let updateController = null;
  let updateNetwork = null;
  let modelDownload = null;
  let savedUpdateFallbackActive = false;
  const testState = { themes: [], blockedPopups: 0, themeWaiter: null };

  async function checkWithUpdateNetwork(version) {
    if (!updateNetwork) return { status: "server-error" };
    const options = { fetchImpl: updateNetwork.fetchImpl };
    const first = await checkForUpdates(version, options);
    if ((first.status === "offline" || first.status === "timeout") &&
        !savedUpdateFallbackActive && await updateNetwork.enableSavedLoopbackFallback()) {
      savedUpdateFallbackActive = true;
      return checkForUpdates(version, options);
    }
    return first;
  }

  async function stageWithUpdateNetwork(version, installRoot, onProgress) {
    const options = { fetchImpl: updateNetwork.fetchImpl };
    try {
      return await downloadAndStageUpdate(version, installRoot, onProgress, options);
    } catch (error) {
      const status = errorStatus(error);
      if (!savedUpdateFallbackActive && (status === "offline" || status === "timeout") &&
          await updateNetwork.enableSavedLoopbackFallback()) {
        savedUpdateFallbackActive = true;
        return downloadAndStageUpdate(version, installRoot, onProgress, options);
      }
      throw error;
    }
  }

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

    ipcMain.handle("real-client:app-version", (event) => {
      if (!trustedFrame(event)) return null;
      return app.getVersion();
    });

    ipcMain.handle("real-client:model-download-state", (event) => {
      if (!trustedFrame(event)) return { phase: "blocked" };
      return modelDownload?.getState() || { phase: "idle" };
    });

    ipcMain.handle("real-client:model-download", (event) => {
      if (!trustedFrame(event) || selfTest || updateValidation || !modelDownload) return { phase: "blocked" };
      return modelDownload.start();
    });

    ipcMain.handle("real-client:model-choose-directory", async (event) => {
      if (!trustedFrame(event) || selfTest || updateValidation || !window) return null;
      const choice = await dialog.showOpenDialog(window, {
        title: "选择 Laya 模型目录", properties: ["openDirectory"],
      });
      return choice.canceled ? null : choice.filePaths[0] || null;
    });

    ipcMain.handle("real-client:check-updates", (event) => {
      if (!trustedFrame(event)) return { status: "blocked" };
      if (updateController) return updateController.check();
      if (!updateCheckPromise) {
        updateCheckPromise = checkWithUpdateNetwork(app.getVersion())
          .finally(() => { updateCheckPromise = null; });
      }
      return updateCheckPromise;
    });

    ipcMain.handle("real-client:update-state", (event) => {
      if (!trustedFrame(event)) return { phase: "blocked" };
      return updateController?.getState() || { phase: "idle", currentVersion: app.getVersion() };
    });

    ipcMain.handle("real-client:begin-update", (event) => {
      if (!trustedFrame(event) || !updateController) return { phase: "blocked" };
      return updateController.begin();
    });

    ipcMain.handle("real-client:rollback-update", (event) => {
      if (!trustedFrame(event) || !updateController) return { phase: "blocked" };
      return updateController.rollback();
    });

    ipcMain.handle("real-client:update-ui-ready", async (event) => {
      if ((!updateValidation && !updateFinalReady) || !trustedFrame(event) || selfTest ||
          !window.isVisible() || window.isMinimized() ||
          typeof updateReadyFile !== "string" || typeof updateReadyNonce !== "string" ||
          !path.isAbsolute(updateReadyFile) || path.resolve(updateReadyFile) !== updateReadyFile ||
          !/^[a-f0-9]{32,64}$/.test(updateReadyNonce) ||
          !/^[a-f0-9]{64}$/.test(instanceId || "")) return false;
      try {
        const installRoot = path.resolve(ROOT, "..", "..");
        const workDir = path.dirname(path.resolve(updateReadyFile));
        const parent = path.dirname(installRoot);
        if (path.dirname(workDir).toLowerCase() !== parent.toLowerCase() ||
            !path.basename(workDir).startsWith(".wechatvibe-update-") ||
            !/^ui-(?:final-)?ready-[a-f0-9-]{20,80}\.json$/.test(path.basename(updateReadyFile)) ||
            fs.lstatSync(workDir).isSymbolicLink() ||
            fs.realpathSync.native(workDir).toLowerCase() !== workDir.toLowerCase()) return false;
        fs.writeFileSync(updateReadyFile, JSON.stringify({
          nonce: updateReadyNonce, expectedVersion: app.getVersion(), instanceId,
        }), { flag: "wx", mode: 0o600 });
        if (updateValidation) return true;
        const journalFile = path.join(workDir, "journal.json");
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && window && !window.isDestroyed()) {
          try {
            const stat = fs.statSync(journalFile);
            if (stat.isFile() && stat.size < 32768) {
              const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
              if (journal.phase === "succeeded" && journal.guiStarted === true &&
                  journal.expectedVersion === app.getVersion() &&
                  path.resolve(journal.installRoot).toLowerCase() === installRoot.toLowerCase()) {
                if (validationTimer) clearTimeout(validationTimer);
                validationTimer = null;
                return true;
              }
              if (["failed", "rolled_back"].includes(journal.phase)) return false;
            }
          } catch (_) { /* The helper may be replacing its atomic journal. */ }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (_) { /* A bad marker must never release chat loading. */ }
      return false;
    });

    ipcMain.handle("real-client:exit-app", (event) => {
      if (!trustedFrame(event)) return false;
      exiting = true;
      stopBridgeMonitor?.();
      setImmediate(() => app.quit());
      return true;
    });

    app.whenReady().then(() => {
      updateNetwork = createUpdateProxyFetch({
        session: session.defaultSession,
        ProxyAgent: require(path.join(ROOT, "node_modules", "undici")).ProxyAgent,
      });
      modelDownload = new ModelDownload({
        root: ROOT, python: process.env.WECHATVIBE_PYTHON || path.join(ROOT, "runtime", "python", "python.exe"),
        fetchImpl: updateNetwork.fetchImpl,
        enableFallback: () => updateNetwork.enableSavedLoopbackFallback(),
        onState: state => {
          if (window && !window.isDestroyed()) window.webContents.send("real-client:model-download-state", state);
        },
      });
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
      if (updateValidation || updateFinalReady) {
        validationTimer = setTimeout(() => app.quit(), updateValidation ? 60000 : 90000);
      }
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
              "(async () => ({ platform: window.desktopHost?.platform, accepted: window.desktopHost?.setTheme('light'), darkAccepted: window.desktopHost?.setTheme('dark'), rejected: window.desktopHost?.setTheme('invalid'), frozen: Object.isFrozen(window.desktopHost), startupAccessible: document.querySelector('#startupOverlay')?.hidden === true && !document.querySelector('#appWindow')?.hasAttribute('inert'), copyDraftExposed: typeof window.desktopHost?.copyDraft === 'function', emptyCopyRejected: await window.desktopHost?.copyDraft('') === false, nodeAccess: typeof require, popup: window.open('https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/') === null }))()",
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
      window.on("close", event => {
        if (updateHandoff === "preparing") {
          quitRequestedDuringHandoff = true;
          event.preventDefault();
        }
      });
      window.on("closed", () => { window = null; stopBridgeMonitor?.(); });
      if (!selfTest && !updateValidation) {
        const startBridgeMonitor = () => {
          if (stopBridgeMonitor || !window || window.isDestroyed()) return;
          stopBridgeMonitor = monitorBridge({
            root: ROOT, url, instanceId,
            isOpen: () => !exiting && !!window && !window.isDestroyed(),
            onRecovered: () => {
              if (!exiting && window && !window.isDestroyed())
                window.webContents.send("real-client:bridge-restored");
            },
          });
        };
        const { createUpdateController } = require("./real-client-update-controller.cjs");
        updateController = createUpdateController({
          app, root: ROOT, port: Number(new URL(url).port), instanceId,
          checkImpl: checkWithUpdateNetwork,
          stageImpl: stageWithUpdateNetwork,
          onState: state => {
            if (window && !window.isDestroyed()) window.webContents.send("real-client:update-state", state);
          },
          pauseRecovery: () => {
            updateHandoff = "preparing";
            exiting = true;
            const drained = stopBridgeMonitor?.();
            stopBridgeMonitor = null;
            return drained;
          },
          resumeRecovery: () => {
            updateHandoff = "none";
            if (quitRequestedDuringHandoff) setImmediate(() => app.quit());
            else { exiting = false; startBridgeMonitor(); }
          },
          quit: () => { updateHandoff = "ready"; app.quit(); },
        });
        startBridgeMonitor();
      }
      void contents.loadURL(url);
    }).catch((error) => {
      process.stderr.write(String(error) + "\n");
      app.exit(1);
    });
    app.on("before-quit", event => {
      exiting = true;
      modelDownload?.cancel();
      if (validationTimer) clearTimeout(validationTimer);
      const recoveryDrain = stopBridgeMonitor?.() || Promise.resolve();
      if (updateHandoff === "preparing") {
        quitRequestedDuringHandoff = true;
        event.preventDefault();
        return;
      }
      if (selfTest || updateValidation || updateHandoff === "ready" || bridgeExitState === "done") return;
      event.preventDefault();
      if (bridgeExitState === "running") return;
      bridgeExitState = "running";
      const bundledPython = path.join(ROOT, "runtime", "python", "python.exe");
      const python = process.env.WECHATVIBE_PYTHON ||
        (fs.existsSync(bundledPython) ? bundledPython : "python");
      const launcher = path.join(ROOT, "scripts", "start-real-client.py");
      const finish = (error, stdout) => {
        bridgeExitState = "done";
        let stopped = false;
        try {
          const result = JSON.parse(stdout);
          stopped = !error && (result.stopped === true || result.alreadyStopped === true);
        } catch (_) { /* A missing result is a shutdown failure. */ }
        if (!stopped) {
          dialog.showErrorBox("WechatVibe 退出提示",
            "本地分析服务未能安全关闭，程序文件可能仍被占用。请在任务管理器中检查此安装目录的后台进程。");
        }
        app.quit();
      };
      void Promise.resolve(recoveryDrain).catch(() => {}).then(() => {
        try {
          execFile(python, [launcher, "--stop-owned-bridge", "--json"], {
            cwd: ROOT, windowsHide: true, timeout: 90000, maxBuffer: 65536,
            env: { ...process.env, CHATUI_PORT: String(new URL(url).port),
              WECHATVIBE_CLIENT_ROOT: ROOT, WECHATVIBE_PYTHON: python },
          }, finish);
        } catch (error) {
          finish(error, "");
        }
      });
    });
    app.on("window-all-closed", () => app.quit());
  }
}
