"use strict";
// Instance-profile resolution. No instance is launched; this only checks the mapping.
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  PROFILE_ENV, profileName, profileFromArgv, runtimeDir, shellDataDir,
} = require("./runtime-paths.cjs");

const ROOT = path.join("C:", "synthetic", "client");

function withEnv(value, run) {
  const previous = process.env[PROFILE_ENV];
  if (value === undefined) delete process.env[PROFILE_ENV];
  else process.env[PROFILE_ENV] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[PROFILE_ENV];
    else process.env[PROFILE_ENV] = previous;
  }
}

// The default instance must resolve to exactly the paths used before profiles existed.
for (const value of [undefined, null, ""]) {
  assert.equal(profileName(value), null, `profileName(${JSON.stringify(value)})`);
}
assert.equal(runtimeDir(ROOT, null), path.join(ROOT, ".local", "real-client-runtime"));
assert.equal(shellDataDir(ROOT, null), path.join(ROOT, ".local", "real-client-shell"));
assert.equal(shellDataDir(ROOT, null, "real-client-shell-self-test"),
  path.join(ROOT, ".local", "real-client-shell-self-test"));

// A profile only appends; it never rewrites the base name.
assert.equal(runtimeDir(ROOT, "b"), path.join(ROOT, ".local", "real-client-runtime", "b"));
assert.equal(shellDataDir(ROOT, "b"), path.join(ROOT, ".local", "real-client-shell", "b"));
assert.equal(shellDataDir(ROOT, "b", "real-client-shell-self-test"),
  path.join(ROOT, ".local", "real-client-shell-self-test", "b"));

// Anything that could escape the directory or break a mutex name is rejected.
for (const bad of ["bad name", "../escape", "a/b", "a\\b", "semi;colon", "x".repeat(33),
  "dot.name", 5, {}]) {
  assert.throws(() => profileName(bad), /invalid instance profile/,
    `profileName(${JSON.stringify(bad)})`);
}

// The argument wins over the inherited variable; the variable is the fallback.
assert.equal(profileFromArgv(["electron", ".", "--profile", "alpha"]), "alpha");
assert.equal(profileFromArgv(["electron", ".", "--profile=alpha"]), "alpha");
withEnv("beta", () => {
  assert.equal(profileFromArgv(["electron", "."]), "beta");
  assert.equal(profileFromArgv(["electron", ".", "--profile", "alpha"]), "alpha");
  assert.equal(profileFromArgv(["electron", ".", "--profile"]), null);
});
withEnv(undefined, () => {
  assert.equal(profileFromArgv(["electron", "."]), null);
  assert.equal(profileFromArgv([]), null);
  assert.equal(profileFromArgv(undefined), null);
});
assert.throws(() => profileFromArgv(["electron", ".", "--profile", "bad name"]),
  /invalid instance profile/);

console.log("runtime-paths checks passed");
