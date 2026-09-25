// Synthetic desktop startup checks: no Electron window or bridge is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'desktop-main.cjs'), 'utf8');

async function launch(isPackaged, stdout) {
  const calls = { errors: [], launches: [], shellLoads: 0, profiles: [], quit: 0 };
  const env = { CHATUI_PORT: '8805', PATH: 'synthetic-path' };
  const processStub = {
    env, argv: [], resourcesPath: path.join(__dirname, 'synthetic-resources'),
  };
  const app = {
    isPackaged,
    setPath: (name, value) => calls.profiles.push({ name, value }),
    whenReady: () => Promise.resolve(),
    quit: () => { calls.quit += 1; },
  };
  const fakeFs = { existsSync: () => true, mkdirSync: () => {} };
  const fakeChild = {
    execFile: (python, args, options, done) => {
      calls.launches.push({ python, args, options });
      queueMicrotask(() => done(null, stdout));
    },
  };
  vm.runInNewContext(source, {
    require: name => {
      if (name === 'electron') return { app, dialog: { showErrorBox: (...args) => calls.errors.push(args) } };
      if (name === 'node:child_process') return fakeChild;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === './real-client-shell.cjs') { calls.shellLoads += 1; return {}; }
      throw new Error(`Unexpected import: ${name}`);
    },
    process: processStub, __dirname,
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, processStub };
}

async function main() {
  const instanceId = 'a'.repeat(64);
  const result = JSON.stringify({ version: 'real-ui-1', url: 'http://127.0.0.1:34567', instanceId });
  for (const isPackaged of [false, true]) {
    const { calls, processStub } = await launch(isPackaged, result);
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.launches[0].options.env.CHATUI_PORT, undefined);
    assert.deepEqual(Array.from(calls.launches[0].args).slice(-2), ['--no-open', '--json']);
    assert.equal(processStub.env.CHATUI_PORT, '34567');
    assert.equal(processStub.env.WECHATVIBE_INSTANCE_ID, instanceId);
    assert.deepEqual(Array.from(processStub.argv).slice(-2), ['--client-url', 'http://127.0.0.1:34567/']);
    assert.equal(calls.shellLoads, 1);
    assert.equal(calls.errors.length, 0);
    assert.equal(calls.profiles.length, 1);
    assert.equal(calls.profiles[0].name, 'userData');
  }

  const invalid = await launch(true, JSON.stringify({ version: 'real-ui-1', url: 'http://localhost:34567', instanceId }));
  assert.equal(invalid.calls.shellLoads, 0);
  assert.equal(invalid.calls.errors.length, 1);
  assert.equal(invalid.calls.quit, 1);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
