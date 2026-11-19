"use strict";

const { app, dialog } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { PROFILE_ENV, profileFromArgv, shellDataDir } = require("./runtime-paths.cjs");

const root = app.isPackaged ? path.join(process.resourcesPath, "client") : path.resolve(__dirname, "..");
const bundledPython = path.join(root, "runtime", "python", "python.exe");
const bundledNode = path.join(root, "runtime", "node", "node.exe");
const projectPython = path.join(root, ".venv", "Scripts", "python.exe");
const python = process.env.WECHATVIBE_PYTHON || (fs.existsSync(bundledPython) ? bundledPython :
  fs.existsSync(projectPython) ? projectPython : "python");
const node = process.env.WECHATVIBE_NODE || (fs.existsSync(bundledNode) ? bundledNode : "node");
const launcher = path.join(root, "scripts", "start-real-client.py");
let profileReady = false;
let instanceProfile = null;
let failureDirectory = null;
// True only when this launch created the bridge (not when it reused a ready one).
let bridgeCreated = false;
try {
  // Set this before app ready so Electron's single-instance lock is per profile, not just
  // per installation: two profiles have to run side by side.
  instanceProfile = profileFromArgv(process.argv);
  const userData = shellDataDir(root, instanceProfile);
  failureDirectory = userData;
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  profileReady = true;
} catch (_) {
  // Report through the normal startup failure path once Electron is ready.
}

// Ask the launcher to stop the bridge only when this launch created it. The launcher
// re-verifies the recorded PID creation time, install identity and control token, so a
// reused or foreign service is never touched. A JSON-invalid result is matched leniently
// for "created":true so a corrupt stdout cannot orphan a bridge we just started.
function stopOwnedBridge(callback) {
  const owned = bridgeCreated;
  if (!owned) {
    callback();
    return;
  }
  const environment = {
    ...process.env, WECHATVIBE_CLIENT_ROOT: root, WECHATVIBE_PYTHON: python,
    // The launcher resolves which instance it may stop from this variable. This path runs
    // before the normal launch environment reaches process.env, so a `--profile` that only
    // exists in argv has to be carried here or the cleanup would stop the default instance.
    ...(instanceProfile ? { [PROFILE_ENV]: instanceProfile } : {}),
  };
  // Resolve this installation's saved port just as the initial launch does.
  delete environment.CHATUI_PORT;
  try {
    execFile(python, [launcher, "--stop-owned-bridge", "--json"], {
      cwd: root, env: environment, windowsHide: true, timeout: 30000, maxBuffer: 65536,
    }, () => callback());
  } catch (_) {
    callback();
  }
}

// The reason-code dialog alone cannot explain a failed launch, so launcher failures also
// append what the launcher printed into logs/desktop-launch.log.
function recordLaunchFailure(reason) {
  const text = String(reason || "").trim();
  if (!text) return "";
  try {
    const directory = path.join(root, "logs");
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(path.join(directory, "desktop-launch.log"),
                      `[${stamp}] ${text}\n`, "utf8");
  } catch (_) {
    // A read-only install still deserves the dialog, just without the log line.
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

const failureMessages = Object.freeze({
  profile_invalid: "实例配置无效。",
  runtime_missing: "运行文件缺失，请重新完整解压程序。",
  shell_identity: "启动进程身份校验失败。",
  port_conflict: "本地服务端口被其他程序占用。",
  installation_busy: "程序正在更新，请稍后重试。",
  bridge_exited: "本地服务在启动期间退出。",
  bridge_timeout: "本地服务未在规定时间内就绪。",
  record_access: "无法创建受保护的服务控制记录，请检查目录权限。",
  launcher_timeout: "启动器运行超时。",
  launcher_failed: "本地服务启动器执行失败。",
  launcher_result: "启动器返回了无效的服务信息。",
  shell_failed: "桌面窗口初始化失败。",
  desktop_failed: "桌面程序初始化失败。",
});

function fail(reason) {
  const code = Object.hasOwn(failureMessages, reason) ? reason : "desktop_failed";
  try {
    if (failureDirectory) {
      // One bounded record per instance. Never persist raw output, paths or stack traces.
      fs.writeFileSync(path.join(failureDirectory, "startup-failure.json"),
        JSON.stringify({ schema: 1, time: new Date().toISOString(), code }) + "\n", "utf8");
    }
  } catch (_) {}
  dialog.showErrorBox("WechatVibe 启动失败", `${failureMessages[code]}\n\n错误代码：${code}`);
  app.quit();
}

function failAfterCleanup(reason) {
  stopOwnedBridge(() => fail(reason));
}

app.whenReady().then(() => {
  if (!profileReady) {
    fail("profile_invalid");
    return;
  }
  if (!fs.existsSync(launcher) ||
      (app.isPackaged && (!fs.existsSync(python) || !fs.existsSync(node)))) {
    fail("runtime_missing");
    return;
  }
  const environment = {
    ...process.env,
    WECHATVIBE_CLIENT_ROOT: root,
    WECHATVIBE_PYTHON: python,
    WECHATVIBE_NODE: node,
    WECHATVIBE_SHELL_PID: String(process.pid),
    PATH: (path.isAbsolute(node) ? path.dirname(node) + path.delimiter : "") + (process.env.PATH || ""),
  };
  if (instanceProfile) {
    // Passed on to the launcher and the bridge so all three agree on the instance.
    environment[PROFILE_ENV] = instanceProfile;
  }
  // Desktop launches derive their port from this installation, even when a
  // terminal or parent process exported an older client's CHATUI_PORT.
  delete environment.CHATUI_PORT;
  execFile(python, [launcher, "--no-open", "--json"], {
    cwd: root, env: environment, windowsHide: true, timeout: 45000, maxBuffer: 65536,
  }, (error, stdout, stderr) => {
    if (error) {
      // The launcher stops a bridge it started before failing, so do not stop one here.
      recordLaunchFailure(["launcher failed:", error.message, stderr, stdout].filter(Boolean).join("\n"));
      let code = error.killed ? "launcher_timeout" : "launcher_failed";
      try {
        const reported = JSON.parse(stdout).startupFailure;
        if (Object.hasOwn(failureMessages, reported)) code = reported;
      } catch (_) {}
      fail(code);
      return;
    }
    let result;
    try {
      result = JSON.parse(stdout);
      bridgeCreated = result.created === true;
      const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(result.url);
      if (result.version !== "real-ui-1" || !match || !/^[a-f0-9]{64}$/.test(result.instanceId) ||
          Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error("Invalid launcher result");
      Object.assign(process.env, environment, {
        CHATUI_PORT: match[1], WECHATVIBE_INSTANCE_ID: result.instanceId,
        WECHATVIBE_BRIDGE_CREATED: bridgeCreated ? "1" : "0",
      });
      delete process.env.WECHATVIBE_SHELL_PID;
    } catch (invalid) {
      if (!bridgeCreated) bridgeCreated = /"created"\s*:\s*true/.test(String(stdout || ""));
      recordLaunchFailure(["invalid launcher result:", invalid.message, stderr, stdout].filter(Boolean).join("\n"));
      failAfterCleanup("launcher_result");
      return;
    }
    process.argv.push("--client-url", `${result.url}/`);
    try {
      require("./real-client-shell.cjs");
    } catch (shellError) {
      recordLaunchFailure(["shell failed:", shellError && shellError.stack || String(shellError)].join("\n"));
      failAfterCleanup("shell_failed");
    }
  });
}).catch(error => {
  recordLaunchFailure(["startup failed:", error && error.stack || String(error)].join("\n"));
  fail("desktop_failed");
});
