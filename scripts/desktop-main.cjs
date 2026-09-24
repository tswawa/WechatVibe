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
const port = Number(process.env.CHATUI_PORT || 8805);

function fail() {
  dialog.showErrorBox("WechatVibe 启动失败", "本地服务未就绪，请检查运行文件是否完整。");
  app.quit();
}

app.whenReady().then(() => {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !fs.existsSync(launcher) ||
      (app.isPackaged && (!fs.existsSync(python) || !fs.existsSync(node)))) {
    fail();
    return;
  }
  const environment = {
    ...process.env,
    WECHATVIBE_CLIENT_ROOT: root,
    WECHATVIBE_PYTHON: python,
    WECHATVIBE_NODE: node,
    CHATUI_PORT: String(port),
    PATH: (path.isAbsolute(node) ? path.dirname(node) + path.delimiter : "") + (process.env.PATH || ""),
  };
  Object.assign(process.env, environment);
  execFile(python, [launcher, "--no-open"], {
    cwd: root, env: environment, windowsHide: true, timeout: 45000, maxBuffer: 65536,
  }, (error) => {
    if (error) {
      fail();
      return;
    }
    process.argv.push("--client-url", `http://127.0.0.1:${port}/`);
    require("./real-client-shell.cjs");
  });
}).catch(fail);
