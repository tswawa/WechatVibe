// Synthetic desktop startup checks: no Electron window or bridge is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'desktop-main.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function launch(isPackaged, stdout, options = {}) {
  const calls = { errors: [], launches: [], shellLoads: 0, profiles: [], quit: 0 };
  const env = { CHATUI_PORT: '8805', PATH: 'synthetic-path', ...(options.env || {}) };
  const processStub = {
    env, argv: options.argv || [], resourcesPath: path.join(__dirname, 'synthetic-resources'),
  };
  const app = {
    isPackaged,
    setPath: (name, value) => calls.profiles.push({ name, value }),
    whenReady: () => Promise.resolve(),
    quit: () => { calls.quit += 1; },
  };
  const fakeFs = { existsSync: () => true, mkdirSync: () => {} };
  const fakeChild = {
    execFile: (python, args, execOptions, done) => {
      calls.launches.push({ python, args, options: execOptions });
      queueMicrotask(() => done(options.execError || null, stdout));
    },
  };
  vm.runInNewContext(source, {
    require: name => {
      if (name === 'electron') return { app, dialog: { showErrorBox: (...args) => calls.errors.push(args) } };
      if (name === 'node:child_process') return fakeChild;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === './real-client-shell.cjs') {
        calls.shellLoads += 1;
        if (options.shellThrows) throw new Error('synthetic shell init failure');
        return {};
      }
      if (name === './runtime-paths.cjs') return require('./runtime-paths.cjs');
      throw new Error(`Unexpected import: ${name}`);
    },
    process: processStub, __dirname,
  });
  await tick();
  await tick();
  return { calls, processStub };
}

// Mirrors how desktop-main resolves `root` from app.isPackaged and resourcesPath.
function rootFor(isPackaged) {
  return isPackaged ? path.join(__dirname, 'synthetic-resources', 'client')
    : path.resolve(__dirname, '..');
}

function validResult(created) {
  return JSON.stringify({ version: 'real-ui-1', url: 'http://127.0.0.1:34567',
    instanceId: 'a'.repeat(64), created });
}

function cleanupLaunches(calls) {
  return calls.launches.filter(call => call.args.includes('--stop-owned-bridge'));
}

async function main() {
  const instanceId = 'a'.repeat(64);
  for (const isPackaged of [false, true]) {
    const { calls, processStub } = await launch(isPackaged, validResult(true));
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.launches[0].options.env.CHATUI_PORT, undefined);
    assert.deepEqual(Array.from(calls.launches[0].args).slice(-2), ['--no-open', '--json']);
    assert.equal(processStub.env.CHATUI_PORT, '34567');
    assert.equal(processStub.env.WECHATVIBE_INSTANCE_ID, instanceId);
    assert.equal(processStub.env.WECHATVIBE_BRIDGE_CREATED, '1');
    assert.deepEqual(Array.from(processStub.argv).slice(-2), ['--client-url', 'http://127.0.0.1:34567/']);
    assert.equal(calls.shellLoads, 1);
    assert.equal(calls.errors.length, 0);
    assert.equal(calls.quit, 0);
    assert.equal(calls.profiles.length, 1);
    assert.equal(calls.profiles[0].name, 'userData');
    // Unprofiled launches must keep the original directory, lock and env byte for byte.
    assert.equal(calls.profiles[0].value,
      path.join(rootFor(isPackaged), '.local', 'real-client-shell'));
    assert.equal(processStub.env.WECHATVIBE_PROFILE, undefined);
  }

  // A profile gives each instance its own user-data directory, Electron single-instance
  // lock, port and bridge, and is handed down to the launcher and the bridge.
  for (const argv of [['electron', '.', '--profile', 'secondary'],
    ['electron', '.', '--profile=secondary']]) {
    const profiled = await launch(true, validResult(true), { argv });
    assert.equal(profiled.calls.profiles[0].value,
      path.join(rootFor(true), '.local', 'real-client-shell', 'secondary'));
    assert.equal(profiled.calls.launches[0].options.env.WECHATVIBE_PROFILE, 'secondary');
    assert.equal(profiled.processStub.env.WECHATVIBE_PROFILE, 'secondary');
    // The inherited CHATUI_PORT is still dropped, so the port follows the profile.
    assert.equal(profiled.calls.launches[0].options.env.CHATUI_PORT, undefined);
    assert.equal(profiled.calls.errors.length, 0);
  }

  // With no --profile argument the module falls back to the inherited variable. The helper
  // resolves it from the real process (it is loaded as a normal module, not sandboxed), so
  // set that rather than the sandbox's stub.
  const previousProfile = process.env.WECHATVIBE_PROFILE;
  process.env.WECHATVIBE_PROFILE = 'beta';
  let viaEnv;
  try {
    viaEnv = await launch(true, validResult(true));
  } finally {
    if (previousProfile === undefined) delete process.env.WECHATVIBE_PROFILE;
    else process.env.WECHATVIBE_PROFILE = previousProfile;
  }
  assert.equal(viaEnv.calls.profiles[0].value,
    path.join(rootFor(true), '.local', 'real-client-shell', 'beta'));
  assert.equal(viaEnv.calls.launches[0].options.env.WECHATVIBE_PROFILE, 'beta');

  // An unusable profile must fail before any launcher or bridge work happens. An empty
  // value is not one of these: it means "default instance".
  for (const bad of ['bad name', '../escape', 'x'.repeat(33), 'semi;colon']) {
    const rejected = await launch(true, validResult(true),
      { argv: ['electron', '.', '--profile', bad] });
    assert.equal(rejected.calls.launches.length, 0, `profile ${JSON.stringify(bad)}`);
    assert.equal(rejected.calls.errors.length, 1, `profile ${JSON.stringify(bad)}`);
    assert.equal(rejected.calls.quit, 1, `profile ${JSON.stringify(bad)}`);
  }

  // A reused ready bridge is never stopped on a startup failure.
  const reused = await launch(true, validResult(false));
  assert.equal(reused.calls.shellLoads, 1);
  assert.equal(reused.processStub.env.WECHATVIBE_BRIDGE_CREATED, '0');
  assert.equal(cleanupLaunches(reused.calls).length, 0);

  // An invalid launcher result only stops the bridge this launch created.
  const invalidOwned = await launch(true, JSON.stringify({ version: 'real-ui-1',
    url: 'http://localhost:34567', instanceId, created: true }));
  assert.equal(invalidOwned.calls.shellLoads, 0);
  assert.equal(invalidOwned.calls.errors.length, 1);
  assert.equal(invalidOwned.calls.quit, 1);
  const ownedCleanups = cleanupLaunches(invalidOwned.calls);
  assert.equal(ownedCleanups.length, 1);
  assert.deepEqual(Array.from(ownedCleanups[0].args).slice(-2), ['--stop-owned-bridge', '--json']);
  assert.equal(ownedCleanups[0].options.env.WECHATVIBE_CLIENT_ROOT,
    path.join(__dirname, 'synthetic-resources', 'client'));

  const invalidReused = await launch(true, JSON.stringify({ version: 'real-ui-1',
    url: 'http://localhost:34567', instanceId, created: false }));
  assert.equal(invalidReused.calls.errors.length, 1);
  assert.equal(cleanupLaunches(invalidReused.calls).length, 0);

  // Corrupt stdout that still says "created":true must not orphan the bridge.
  const corrupt = await launch(true, 'x "created": true y');
  assert.equal(corrupt.calls.errors.length, 1);
  assert.equal(corrupt.calls.quit, 1);
  assert.equal(cleanupLaunches(corrupt.calls).length, 1);
  const corruptReused = await launch(true, 'not json at all');
  assert.equal(cleanupLaunches(corruptReused.calls).length, 0);

  // That cleanup must target the instance this launch created. The launcher decides which
  // bridge it may stop from its environment, and this failure path runs before the normal
  // launch environment reaches process.env, so a `--profile` given only in argv has to be
  // carried into the stop call — otherwise it stops the default instance's bridge.
  assert.equal(cleanupLaunches(corrupt.calls)[0].options.env.WECHATVIBE_PROFILE, undefined);
  const corruptProfiled = await launch(true, 'x "created": true y',
    { argv: ['electron', '.', '--profile', 'secondary'] });
  const profiledCleanups = cleanupLaunches(corruptProfiled.calls);
  assert.equal(profiledCleanups.length, 1);
  assert.equal(profiledCleanups[0].options.env.WECHATVIBE_PROFILE, 'secondary');

  // The launcher cleans up a bridge it started before reporting an error, so the
  // desktop must not issue a second stop.
  const launcherFailed = await launch(true, '', { execError: new Error('launcher failed') });
  assert.equal(launcherFailed.calls.launches.length, 1);
  assert.equal(launcherFailed.calls.errors.length, 1);
  assert.equal(launcherFailed.calls.quit, 1);
  assert.equal(cleanupLaunches(launcherFailed.calls).length, 0);

  // A synchronous shell require failure stops only a bridge this launch created.
  const shellOwned = await launch(true, validResult(true), { shellThrows: true });
  assert.equal(shellOwned.calls.errors.length, 1);
  assert.equal(shellOwned.calls.quit, 1);
  assert.equal(cleanupLaunches(shellOwned.calls).length, 1);
  const shellReused = await launch(true, validResult(false), { shellThrows: true });
  assert.equal(shellReused.calls.errors.length, 1);
  assert.equal(cleanupLaunches(shellReused.calls).length, 0);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
