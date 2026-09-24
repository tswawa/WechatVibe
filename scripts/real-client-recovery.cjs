// Keep the local bridge available while this project's desktop client is open.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function monitorBridge({ root, url, isOpen, onRecovered }) {
  const port = Number(new URL(url).port);
  const bundledPython = path.join(root, 'runtime', 'python', 'python.exe');
  const python = process.env.WECHATVIBE_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
  const launcher = path.join(root, 'scripts', 'start-real-client.py');
  const noAutoRecovery = path.join(root, '.local', 'real-client-runtime', 'no-auto-recovery.json');
  let checking = false;
  let recovering = false;
  let stopped = false;
  let retryAfter = 0;

  async function check() {
    if (stopped || !isOpen() || checking || recovering || fs.existsSync(noAutoRecovery) || Date.now() < retryAfter) return;
    checking = true;
    const reachable = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
    checking = false;
    if (reachable || stopped || !isOpen() || fs.existsSync(noAutoRecovery) ||
        (path.isAbsolute(python) && !fs.existsSync(python))) return;
    recovering = true;
    // The existing launcher verifies process identity and service ownership, and
    // never stops another process or creates a duplicate bridge.
    execFile(python, [launcher, '--no-open', '--recovery'],
      { cwd: root, windowsHide: true, env: { ...process.env, CHATUI_PORT: String(port) } }, error => {
        recovering = false;
        retryAfter = Date.now() + 10000;
        if (!error && !stopped && isOpen() && !fs.existsSync(noAutoRecovery)) onRecovered();
      });
  }

  const timer = setInterval(() => { void check(); }, 3000);
  timer.unref();
  void check();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { monitorBridge };
