// Synthetic recovery checks: no bridge, Python process, or socket is opened.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'real-client-recovery.cjs'), 'utf8');

function fixture(markerPresent) {
  const calls = [];
  let tick;
  let recovered = 0;
  const fakeFs = {
    existsSync: target => target.endsWith('no-auto-recovery.json') ? markerPresent : false,
  };
  const fakeNet = {
    createConnection: () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit('error', new Error('synthetic offline')));
      return socket;
    },
  };
  const fakeChild = {
    execFile: (_python, args, _options, done) => calls.push({ args, done }),
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    require: name => ({ 'node:child_process': fakeChild, 'node:fs': fakeFs,
      'node:net': fakeNet, 'node:path': path })[name],
    process: { env: { WECHATVIBE_PYTHON: 'python' } },
    URL,
    setInterval: callback => { tick = callback; return { unref() {} }; },
    clearInterval: () => {},
  });
  const stop = module.exports.monitorBridge({
    root: path.join(__dirname, 'synthetic root'),
    url: 'http://127.0.0.1:54321',
    isOpen: () => true,
    onRecovered: () => { recovered += 1; },
  });
  return { calls, tick: () => tick(), stop,
    setMarker: value => { markerPresent = value; },
    recovered: () => recovered };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const blocked = fixture(true);
  await flush();
  assert.equal(blocked.calls.length, 0);
  blocked.setMarker(false);
  blocked.tick();
  await flush();
  assert.equal(blocked.calls.length, 1);
  assert.deepEqual(Array.from(blocked.calls[0].args).slice(-2), ['--no-open', '--recovery']);
  blocked.setMarker(true);
  blocked.calls[0].done(null);
  await flush();
  assert.equal(blocked.recovered(), 0);
  blocked.stop();

  const available = fixture(false);
  await flush();
  assert.equal(available.calls.length, 1);
  available.calls[0].done(null);
  await flush();
  assert.equal(available.recovered(), 1);
  available.stop();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
