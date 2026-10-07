"use strict";

// Instance-profile paths for the Electron side.
//
// A profile names a second, independent instance of the same installation: it moves the
// Electron user-data directory and the runtime directory, so two profiles get two windows,
// two bridges and two account pins out of one checkout. Without a profile every path here
// is byte-for-byte what it was before profiles existed.

const path = require("node:path");

const PROFILE_ENV = "WECHATVIBE_PROFILE";
// The profile reaches a directory name and a mutex name, so keep it to a safe alphabet.
const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function profileName(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw new Error("invalid instance profile");
  }
  return value;
}

/** `--profile <name>` or `--profile=<name>` wins over the inherited environment. */
function profileFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index]);
    if (item === "--profile") {
      return profileName(args[index + 1]);
    }
    if (item.startsWith("--profile=")) {
      return profileName(item.slice("--profile=".length));
    }
  }
  return profileName(process.env[PROFILE_ENV]);
}

function runtimeDir(root, profile) {
  const base = path.join(root, ".local", "real-client-runtime");
  return profile ? path.join(base, profile) : base;
}

function shellDataDir(root, profile, name) {
  const base = path.join(root, ".local", name || "real-client-shell");
  return profile ? path.join(base, profile) : base;
}

module.exports = { PROFILE_ENV, profileName, profileFromArgv, runtimeDir, shellDataDir };
