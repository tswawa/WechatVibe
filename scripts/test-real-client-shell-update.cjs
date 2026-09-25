"use strict";

// Exercise shell IPC registration with synthetic Electron objects; no window or bridge is opened.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  const handles = new Map();
  const frames = { mainFrame: { url: "http://127.0.0.1:34567/" } };
  const contents = {
    mainFrame: frames.mainFrame,
    on() {}, once() {}, setWindowOpenHandler() {}, loadURL() {},
  };
  const window = { webContents: contents, isDestroyed: () => false, on() {} };
  const calls = { update: 0 };
  const app = {
    setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => Promise.resolve(), getVersion: () => "1.0.1",
  };
  const electron = {
    app, BrowserWindow: class { constructor() { return window; } }, clipboard: {},
    ipcMain: { on() {}, handle: (name, callback) => handles.set(name, callback) },
    session: { defaultSession: {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
      webRequest: { onBeforeRequest() {} },
    } }, shell: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "real-client-shell.cjs"), "utf8");
  vm.runInNewContext(source, {
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:fs") return { mkdirSync() {} };
      if (name === "node:path") return path;
      if (name === "./real-client-recovery.cjs") return { monitorBridge() {} };
      if (name === "./real-client-update.cjs") return {
        RELEASES_URL: "https://github.com/tswawa/WechatVibe/releases",
        checkForUpdates: async version => { calls.update++; assert.equal(version, "1.0.1"); return { status: "current" }; },
      };
      throw new Error(`Unexpected require: ${name}`);
    },
    __dirname, URL, process: {
      platform: "win32", env: {}, argv: ["electron", "shell", "--client-url", frames.mainFrame.url, "--self-test"],
      stderr: { write() {} },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const trusted = { sender: contents, senderFrame: frames.mainFrame };
  const subframe = { sender: contents, senderFrame: { url: frames.mainFrame.url } };
  const otherWindow = { sender: {}, senderFrame: frames.mainFrame };
  assert.equal(handles.get("real-client:app-version")(trusted), "1.0.1");
  assert.equal(handles.get("real-client:app-version")(subframe), null);
  assert.equal(handles.get("real-client:app-version")(otherWindow), null);
  assert.equal((await handles.get("real-client:check-updates")(subframe)).status, "blocked");
  assert.equal(calls.update, 0);
  const [first, second] = await Promise.all([
    handles.get("real-client:check-updates")(trusted),
    handles.get("real-client:check-updates")(trusted),
  ]);
  assert.equal(first.status, "current");
  assert.equal(second.status, "current");
  assert.equal(calls.update, 1);
  frames.mainFrame.url = "http://127.0.0.1:34567/other";
  assert.equal(handles.get("real-client:app-version")(trusted), null);
  assert.equal((await handles.get("real-client:check-updates")(trusted)).status, "blocked");
  process.stdout.write("real-client shell update IPC checks passed\n");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
