"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const read = (...parts) => readFileSync(path.join(__dirname, "..", ...parts), "utf8");
// The module is a browser script, so load it the way the frame does instead of requiring it.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(read("chatui", "advisor-steps.js"), sandbox);
const steps = sandbox.module.exports;
// Objects come from another realm, so compare plain copies.
const plain = list => Array.from(list, step => ({ state: step.state, text: step.text }));

function collect(events) {
  return events.reduce((list, event) => steps.collect(list, event), []);
}

it("keeps coarse labels in the order they arrive", () => {
  const list = collect([
    { type: "status", state: "reading", text: "正在读取会话资料" },
    { type: "status", state: "preparing", text: "已读取 12 条消息，正在整理上下文" },
    { type: "status", state: "thinking", text: "正在调用模型" },
  ]);
  assert.deepEqual(plain(list), [
    { state: "reading", text: "正在读取会话资料" },
    { state: "preparing", text: "已读取 12 条消息，正在整理上下文" },
    { state: "thinking", text: "正在调用模型" },
  ]);
});

it("drops repeats, unknown states and anything that is not a short label", () => {
  const list = collect([
    { state: "reading", text: "正在读取会话资料" },
    { state: "reading", text: "正在读取会话资料" },
    { state: "answering", text: "正在回答" },
    { state: "reading", text: "" },
    { state: "reading", text: "x".repeat(steps.MAX_LABEL + 1) },
    { state: "reading", text: 42 },
    { state: "reading", text: "正在读取会话资料", messageId: "msg:secret" },
  ]);
  assert.deepEqual(plain(list), [{ state: "reading", text: "正在读取会话资料" }]);
});

it("keeps only the newest steps so the list cannot grow without bound", () => {
  const list = collect([1, 2, 3, 4, 5, 6].map(index => ({
    state: "preparing", text: `第 ${index} 步`,
  })));
  assert.equal(list.length, steps.MAX_STEPS);
  assert.deepEqual(plain(list).map(step => step.text), ["第 3 步", "第 4 步", "第 5 步", "第 6 步"]);
});

it("tolerates a missing or malformed list without throwing", () => {
  assert.deepEqual(plain(steps.collect(undefined, { state: "reading", text: "正在读取会话资料" })),
                   [{ state: "reading", text: "正在读取会话资料" }]);
  assert.deepEqual(plain(steps.collect([null, "x", { state: "thinking" }], null)), []);
});

it("the frame renders the list, hides it once the answer streams and ships the module", () => {
  const frame = read("chatui", "advisor-frame.js");
  assert.match(frame, /AdvisorSteps/);
  assert.match(frame, /if \(running && currentRun\?\.phaseEvent\) runSteps = collectStep\(runSteps, currentRun\.phaseEvent\)/);
  assert.match(frame, /id = "advisorSteps"/);
  assert.match(frame, /row\.dataset\.state = index === runSteps\.length - 1 \? "active" : "done"/);
  assert.match(frame, /phase === "answering"/);
  assert.match(read("chatui", "advisor-frame.html"), /<script src="advisor-steps\.js"><\/script>/);
  const css = read("chatui", "advisor.css");
  assert.match(css, /\.advisor-step\[data-state="active"\]/);
  assert.match(css, /prefers-reduced-motion/);
});
