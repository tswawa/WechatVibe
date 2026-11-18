"use strict";
// 报告导出是纯前端能力：数据取屏幕上已加载的会话/标签/画像，本地生成自包含 HTML，
// 再交给桌面壳写盘。本测试盯住三件事：生成器的转义与统计、UI 接线、IPC 守卫。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r/gu, "");

// report.js is a UMD module: load it in a sandbox with a globalThis-shaped root.
const reportSource = read("chatui", "report.js");
const sandbox = { module: { exports: {} }, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(reportSource, sandbox);
const Report = sandbox.module.exports;

it("exposes a single Report namespace for browser script loads", () => {
  const browser = { window: null };
  browser.window = browser;
  const context = { window: browser.window };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(reportSource, context);
  assert.equal(typeof browser.window.Report.buildReportHtml, "function");
  assert.equal(typeof browser.window.Report.reportFileName, "function");
});

const sampleMessages = [
  { id: "1", side: "other", kind: "text", time: 1_700_000_000_000, text: "你好，下午方便吗" },
  { id: "2", side: "self", kind: "text", time: 1_700_000_006_000, text: "方便，几点？" },
  { id: "3", side: "other", kind: "text", time: 1_700_000_012_000, text: "三点吧" },
];
const sampleResults = {
  "1": { intentLabel: "问候", intentP: 0.9, emotionLabel: "平静", emotionP: 0.7 },
  "3": { intentLabel: "计划", intentP: 0.8 },
};
const sampleProfile = {
  affinity: 72, mbti: "ENFP", mood: "积极", dataStatus: "analyzed",
  traits: [{ label: "主动" }], keywords: [{ word: "会议" }], summary: "沟通顺畅",
};
const meta = { user: "张三", contactName: "张三", generatedAt: "2026-11-18T10:00:00.000Z", rangeLabel: "当前已加载窗口" };

it("escapes every piece of chat text so a message cannot inject markup", () => {
  const html = Report.buildReportHtml({
    messages: [{ id: "x", side: "other", kind: "text", time: 1, text: '<img src=x onerror="alert(1)">' }],
    results: {}, profile: null, meta,
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  // No script tag from user data anywhere in the document.
  assert.ok(!html.includes("<script"), "报告正文不得包含脚本标签");
});

it("counts analyzed messages and builds intent/emotion distributions", () => {
  const html = Report.buildReportHtml({ messages: sampleMessages, results: sampleResults, profile: null, meta });
  assert.ok(html.includes("<b>3</b><span>消息条数</span>"));
  assert.ok(html.includes("<b>2</b><span>已分析条数</span>"));
  assert.ok(html.includes("<b>67%</b><span>分析覆盖率</span>"));
  assert.ok(html.includes("问候"), "意图标签应出现在统计与明细");
  assert.ok(html.includes("计划"));
  assert.ok(html.includes("平静"), "情绪标签应出现");
});

it("renders a portrait summary when a profile is available", () => {
  const html = Report.buildReportHtml({ messages: sampleMessages, results: sampleResults, profile: sampleProfile, meta });
  for (const value of ["好感度", "72", "MBTI", "ENFP", "高频词", "会议", "沟通顺畅"])
    assert.ok(html.includes(value), `画像摘要缺少 ${value}`);
});

it("shows an explicit empty state when there is no portrait", () => {
  const html = Report.buildReportHtml({ messages: sampleMessages, results: {}, profile: null, meta });
  assert.ok(html.includes("尚未生成画像"));
});

it("caps the window at 2000 messages and marks non-text kinds", () => {
  const many = Array.from({ length: 2010 }, (_, i) => ({ id: String(i), side: "other", time: i, text: "m" }));
  const html = Report.buildReportHtml({ messages: many, results: {}, profile: null, meta });
  assert.ok(html.includes("共 2000 条消息"));
  assert.ok(!html.includes("共 2010 条消息"));
});

it("marks non-text messages and produces safe file names", () => {
  const html = Report.buildReportHtml({
    messages: [{ id: "1", side: "other", kind: "image", time: 1, text: "[图片]" }],
    results: {}, profile: null, meta,
  });
  assert.ok(html.includes("[image]"), "非文本消息应保留类型标记");
  const name = Report.reportFileName("张/三:*?", "2026-11-18T10:00:00.000Z");
  assert.ok(/^WechatVibe-.*\.html$/u.test(name));
  assert.ok(!/[\\/:*?"<>|]/u.test(name.slice("WechatVibe-".length, name.lastIndexOf("."))));
});

it("wires the export button and loads report.js before app.js", () => {
  const html = read("chatui", "index.html");
  assert.match(html, /id="btnExportReport"[^>]*type="button"/u);
  assert.ok(html.indexOf("<script src=\"report.js\"") < html.indexOf("<script src=\"app.js\""),
    "report.js 必须在 app.js 之前加载");
  const app = read("chatui", "app.js");
  assert.match(app, /byId\("btnExportReport"\)\?\.addEventListener\("click"/u);
  assert.match(app, /window\.Report\?\.buildReportHtml/u);
  assert.match(app, /host\.saveReport\(html, suggestedName\)/u);
});

it("guards the save-report IPC at both the preload and shell boundary", () => {
  const preload = read("scripts", "real-client-preload.cjs");
  assert.match(preload, /saveReport\(html, suggestedName\)/u);
  assert.match(preload, /ipcRenderer\.invoke\("real-client:save-report"/u);
  assert.match(preload, /navigator\.userActivation\.isActive/u);
  const shell = read("scripts", "real-client-shell.cjs");
  assert.match(shell, /ipcMain\.handle\("real-client:save-report"/u);
  assert.match(shell, /!trustedFrame\(event\)\s*\|\|\s*selfTest/u);
  assert.match(shell, /dialog\.showSaveDialog\(window/u);
  assert.match(shell, /fs\.writeFileSync\(choice\.filePath, html, "utf8"\)/u);
  // The report is never auto-opened or re-read: write bytes and stop.
  assert.ok(!/save-report[\s\S]{0,400}shell\.openPath/u.test(shell));
});
