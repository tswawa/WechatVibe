"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdateController, readRollback } = require("./real-client-update-controller.cjs");

function removeOwnedTree(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeOwnedTree(item);
    else fs.unlinkSync(item);
  }
  fs.rmdirSync(root);
}

async function main() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wechatvibe-controller-"));
  try {
    const installRoot = path.join(parent, "WechatVibe");
    const clientRoot = path.join(installRoot, "resources", "client");
    fs.mkdirSync(clientRoot, { recursive: true });
    const work = path.join(parent, ".wechatvibe-update-valid");
    fs.mkdirSync(path.join(work, "backup"), { recursive: true });
    fs.writeFileSync(path.join(work, "backup", "WechatVibe.exe"), "previous binary");
    fs.writeFileSync(path.join(work, "journal.json"), JSON.stringify({
      schema: 1, phase: "succeeded", installRoot,
      expectedVersion: "1.0.2", previousVersion: "1.0.1",
    }));
    const damaged = path.join(parent, ".wechatvibe-update-damaged");
    fs.mkdirSync(path.join(damaged, "backup"), { recursive: true });
    fs.writeFileSync(path.join(damaged, "backup", "WechatVibe.exe"), "wrong binary");
    fs.writeFileSync(path.join(damaged, "journal.json"), JSON.stringify({
      schema: 1, phase: "succeeded", installRoot: path.join(parent, "Other"),
      expectedVersion: "1.0.2", previousVersion: "1.0.0",
    }));
    assert.equal(readRollback(parent, installRoot, "1.0.2")?.version, "1.0.1");
    assert.equal(readRollback(parent, installRoot, "1.0.3"), null);

    const controller = createUpdateController({
      app: { getVersion: () => "1.0.2", isPackaged: false }, root: clientRoot,
      port: 34567, instanceId: "0".repeat(64),
      checkImpl: async () => ({ status: "current", latestVersion: "1.0.2" }),
      stageImpl: async () => { throw new Error("No download expected"); },
    });
    assert.equal(controller.getState().rollbackVersion, "1.0.1");
    assert.equal((await controller.check()).phase, "current");
    assert.equal((await controller.begin()).phase, "current");
  } finally {
    removeOwnedTree(parent);
  }
  process.stdout.write("real-client update controller checks passed\n");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
