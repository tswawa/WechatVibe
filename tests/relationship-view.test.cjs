"use strict";
// 关系倾向卡把已训练的 5 类关系分类器结果（逐条 results 里的 relationship 分布）
// 聚合成画像页可见的信号。纯函数负责统计，DOM 接线用静态断言钉住。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r/gu, "");

const source = read("chatui", "relationship-view.js");
const sandbox = { module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const View = sandbox.module.exports;

const messages = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
const dist = (top, p = 0.8) => [{ label: top, probability: p }, { label: "neutral", probability: 1 - p }];
const results = {
  "1": { relationship: dist("neutral", 0.9) },
  "2": { relationship: dist("warm", 0.7) },
  "3": { relationship: dist("romantic", 0.6) },
  "4": { relationship: dist("neutral", 0.85) },
};

it("exposes the single RelationshipView namespace for browser script loads", () => {
  const browser = { window: null };
  browser.window = browser;
  const context = { window: browser.window };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(typeof browser.window.RelationshipView.summarize, "function");
});

it("aggregates the top relationship label per analysed message", () => {
  const summary = View.summarize(results, messages);
  assert.equal(summary.classified, 4);
  assert.equal(summary.windowSize, 4);
  assert.equal(summary.dominant.key, "neutral");
  assert.equal(summary.dominant.count, 2);
  assert.equal(Math.round(summary.dominant.share * 100), 50);
  const warm = summary.rows.find(row => row.key === "warm");
  assert.equal(warm.count, 1);
  assert.equal(warm.label, "亲近友善");
});

it("ignores messages with no relationship and unknown labels", () => {
  const sparse = { "1": results["1"], "2": { relationship: [{ label: "garbage", probability: 0.9 }] }, "3": {} };
  const summary = View.summarize(sparse, messages);
  assert.equal(summary.classified, 1);
  assert.equal(summary.dominant.key, "neutral");
});

it("handles an empty window without dividing by zero", () => {
  const summary = View.summarize({}, []);
  assert.equal(summary.classified, 0);
  assert.equal(summary.dominant, null);
  assert.equal(summary.meanConfidence, 0);
  assert.ok(summary.rows.every(row => row.share === 0));
});

it("counts float message ids via string coercion", () => {
  const summary = View.summarize({ "9": { relationship: dist("distant") } }, [{ id: 9 }]);
  assert.equal(summary.classified, 1);
  assert.equal(summary.dominant.key, "distant");
});

it("wires the card into the portrait view and hides it for group chats", () => {
  const html = read("chatui", "index.html");
  assert.match(html, /id="relationshipCard"/u);
  assert.match(html, /id="relationshipBadge"/u);
  assert.match(html, /id="relationshipList"/u);
  assert.ok(html.indexOf("<script src=\"relationship-view.js\"") < html.indexOf("<script src=\"app.js\""),
    "relationship-view.js 必须在 app.js 之前加载");
  const app = read("chatui", "app.js");
  assert.match(app, /renderRelationshipTendency\(group\)/u);
  assert.match(app, /window\.RelationshipView/u);
  assert.match(app, /card\.hidden = !!group/u);
  assert.match(app, /view\.summarize\(labelState\.results, chatState\.messages\)/u);
});

it("uses theme tokens for the bars so custom accents are respected", () => {
  const css = read("chatui", "style.css");
  const block = css.slice(css.indexOf("/* Relationship tendency"), css.indexOf("/* MBTI Personality Lock"));
  assert.match(block, /\.relationship-fill\s*\{[^}]*var\(--theme-accent\)/u);
  assert.match(block, /\.relationship-row\.dominant \.relationship-label\s*\{[^}]*var\(--theme-accent-strong\)/u);
});
