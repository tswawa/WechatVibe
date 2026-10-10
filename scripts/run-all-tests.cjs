"use strict";
// Runs the three independent test suites at the same time and reports every result.
//
// The suites share nothing: the Node tests, the desktop-script tests and the Python
// tests each own their own processes, fixtures and temporary directories, and none of
// them asserts on the other's files. Running them one after another made the wall
// clock the sum of all three. The only ordering that still matters is the type check,
// which stays first because a type error would make every later failure noise. Sources
// are only read, so the overlap is safe here too.
const { spawn } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testFiles = readdirSync(path.join(root, "tests"))
  .filter(name => name.endsWith(".test.ts") || name.endsWith(".test.cjs"))
  .sort()
  .map(name => path.join("tests", name));

const suites = [
  { name: "node", command: process.execPath, args: ["--import", "tsx", "--test", ...testFiles] },
  { name: "scripts", command: process.execPath, args: ["scripts/run-node-script-tests.cjs"] },
  // run-python-tests.py re-executes itself into the project interpreter when the
  // current one is not it, so this stays a plain `python` launch like the npm script.
  { name: "python", command: "python", args: ["scripts/run-python-tests.py"] },
];

// `node scripts/run-all-tests.cjs --only=node,scripts` runs a subset, and
// `--skip-typecheck` skips the type check when only a runtime path changed.
const selection = process.argv.slice(2);
const only = (selection.find(argument => argument.startsWith("--only=")) || "").slice("--only=".length);
const skipTypecheck = selection.includes("--skip-typecheck");
const wanted = only ? new Set(only.split(",").map(name => name.trim()).filter(Boolean)) : null;
const chosen = suites.filter(suite => !wanted || wanted.has(suite.name));
if (!chosen.length) {
  process.stderr.write(`no suite matches --only=${only}\n`);
  process.exit(1);
}

function run(suite) {
  return new Promise(resolve => {
    const started = Date.now();
    process.stdout.write(`\n===== ${suite.name} tests =====\n`);
    const finish = code => resolve({ ...suite, code, seconds: (Date.now() - started) / 1000 });
    spawn(suite.command, suite.args, { cwd: root, stdio: "inherit", windowsHide: true })
      .on("error", error => {
        process.stderr.write(`${error.message}\n`);
        finish(1);
      }).on("close", finish);
  });
}

function typecheck() {
  return new Promise((resolve, reject) => {
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    spawn(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.electron.json"],
      { cwd: root, stdio: "inherit", windowsHide: true })
      .on("error", reject)
      .on("close", code => code === 0 ? resolve() : reject(new Error("typecheck failed")));
  });
}

(skipTypecheck ? Promise.resolve() : typecheck())
  .then(() => Promise.all(chosen.map(run)))
  .then(results => {
    process.stdout.write("\n===== summary =====\n");
    for (const result of results.sort((a, b) => b.seconds - a.seconds))
      process.stdout.write(`${result.name}: ${result.code === 0 ? "pass" : "FAIL"}`
        + ` (${result.seconds.toFixed(1)}s)\n`);
    const failed = results.filter(result => result.code !== 0);
    if (failed.length) {
      process.exitCode = failed[0].code || 1;
      return;
    }
    process.stdout.write("ALL_SUITES_PASSED\n");
  })
  .catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
