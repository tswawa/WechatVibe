"use strict";

const { app, dialog } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = app.isPackaged ? path.join(process.resourcesPath, "client") : path.resolve(__dirname, "..");
const bundledPython = path.join(root, "runtime", "python", "python.exe");
const bundledNode = path.join(root, "runtime", "node", "node.exe");
const projectPython = path.join(root, ".venv", "Scripts", "python.exe");
const python = process.env.WECHATVIBE_PYTHON || (fs.existsSync(bundledPython) ? bundledPython :
  fs.existsSync(projectPython) ? projectPython : "python");
const node = process.env.WECHATVIBE_NODE || (fs.existsSync(bundledNode) ? bundledNode : "node");
const launcher = path.join(root, "scripts", "start-real-client.py");
let profileReady = false;
try {
  // Set this before app ready so Electron's single-instance lock is per installation.
  const userData = path.join(root, ".local", "real-client-shell");
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  profileReady = true;
} catch (_) {
  // Report through the normal startup failure path once Electron is ready.
}

function fail() {
  dialog.showErrorBox("WechatVibe 启动失败", "本地服务未就绪，请检查运行文件是否完整。");
  app.quit();
}

app.whenReady().then(() => {
  if (!profileReady || !fs.existsSync(launcher) ||
      (app.isPackaged && (!fs.existsSync(python) || !fs.existsSync(node)))) {
    fail();
    return;
  }
  const environment = {
    ...process.env,
    WECHATVIBE_CLIENT_ROOT: root,
    WECHATVIBE_PYTHON: python,
    WECHATVIBE_NODE: node,
    PATH: (path.isAbsolute(node) ? path.dirname(node) + path.delimiter : "") + (process.env.PATH || ""),
  };
  // Desktop launches derive their port from this installation, even when a
  // terminal or parent process exported an older client's CHATUI_PORT.
  delete environment.CHATUI_PORT;
  execFile(python, [launcher, "--no-open", "--json"], {
    cwd: root, env: environment, windowsHide: true, timeout: 45000, maxBuffer: 65536,
  }, (error, stdout) => {
    if (error) {
      fail();
      return;
    }
    let result;
    try {
      result = JSON.parse(stdout);
      const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(result.url);
      if (result.version !== "real-ui-1" || !match || !/^[a-f0-9]{64}$/.test(result.instanceId) ||
          Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error("Invalid launcher result");
      Object.assign(process.env, environment, {
        CHATUI_PORT: match[1], WECHATVIBE_INSTANCE_ID: result.instanceId,
      });
    } catch (_) {
      fail();
      return;
    }
    process.argv.push("--client-url", `${result.url}/`);
    require("./real-client-shell.cjs");
  });
}).catch(fail);
