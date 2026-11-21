"use strict";
// The reasoning panel shows sealed-at-rest model thinking. It must never inject
// the text as HTML, and copy/fullscreen/decrypt failures need explicit fallbacks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r/gu, "");
const html = read("chatui", "index.html");
const app = read("chatui", "app.js");
const css = read("chatui", "style.css");

it("places the reasoning card after 互动风格 in the persona grid", () => {
  const radar = html.indexOf('id="radarCard"');
  const reasoning = html.indexOf('id="reasoningCard"');
  const gridEnd = html.indexOf("Grid Row 2", radar);
  assert.ok(radar >= 0 && reasoning > radar && reasoning < gridEnd,
    "思考过程卡应在互动风格之后、同一 grid 内");
  assert.match(html, /class="persona-card reasoning-card" id="reasoningCard"/u);
  assert.match(css, /\.reasoning-card \{[^}]*min-height:/u);
  assert.match(css, /\.persona-grid:has\(#reasoningCard\) \{ grid-template-columns: repeat\(2,/u);
});

it("puts fullscreen and copy SVG icon buttons in the card header", () => {
  const card = html.slice(html.indexOf('id="reasoningCard"'), html.indexOf("Grid Row 2"));
  assert.match(card, /id="btnReasoningFullscreen"[^>]*title="全屏查看完整思考过程"/u);
  assert.match(card, /id="btnReasoningCopy"[^>]*title="复制思考过程"/u);
  const iconButtons = card.match(/class="card-icon-btn"[\s\S]*?<\/button>/gu) || [];
  assert.equal(iconButtons.length, 2, "卡片头部应有两个图标按钮");
  for (const button of iconButtons)
    assert.match(button, /<svg /u, "每个按钮带一个 SVG 图标");
});

it("has a fullscreen overlay with its own copy and close controls", () => {
  const overlay = html.slice(html.indexOf('id="reasoningOverlay"'));
  assert.match(overlay, /role="dialog" aria-modal="true"/u);
  assert.match(overlay, /id="btnReasoningOverlayCopy"/u);
  assert.match(overlay, /id="btnReasoningOverlayClose"/u);
  assert.match(overlay, /id="reasoningOverlayBody"/u);
});

it("renders reasoning as textContent, never innerHTML", () => {
  const body = app.slice(app.indexOf("async function loadReasoning"));
  const copy = app.slice(app.indexOf("async function copyReasoning"), app.indexOf("function setReasoningOverlay"));
  const overlay = app.slice(app.indexOf("function setReasoningOverlay"));
  for (const segment of [body, copy, overlay]) {
    assert.ok(!/innerHTML/u.test(segment), "思考文本不得走 innerHTML");
  }
  assert.match(body, /body\.textContent = reasoningText/u);
  assert.match(overlay, /body\.textContent = reasoningText/u);
});

it("loads from the sealed backend endpoint and handles decrypt failure", () => {
  assert.match(app, /api\(`\/api\/reasoning\?user=\$\{encodeURIComponent\(user\)\}`\)/u);
  assert.match(app, /data\?\.error === "reasoning-unreadable"/u);
  assert.match(app, /思考过程读取失败，请稍后重试/u);
  assert.match(app, /void loadReasoning\(chatState\.currentUser\)/u);
});

it("keeps copy and fullscreen disabled until text is available", () => {
  const body = app.slice(app.indexOf("async function loadReasoning"), app.indexOf("async function copyReasoning"));
  assert.match(body, /copy\.disabled = !reasoningText/u);
  assert.match(body, /fullscreen\.disabled = !reasoningText/u);
});

it("falls back to textarea copy and reports clipboard failures", () => {
  const copy = app.slice(app.indexOf("async function copyReasoning"), app.indexOf("function setReasoningOverlay"));
  assert.match(copy, /navigator\.clipboard\?\.writeText/u);
  assert.match(copy, /document\.execCommand\("copy"\)/u);
  assert.match(copy, /复制失败，请手动选中文本复制/u);
});

it("closes the overlay via button, backdrop and Escape", () => {
  const bindings = app.slice(app.indexOf('byId("btnReasoningFullscreen")?.addEventListener'));
  assert.match(bindings, /btnReasoningOverlayClose/u);
  assert.match(bindings, /event\.target === event\.currentTarget/u);
  assert.match(bindings, /event\.key === "Escape"/u);
});

it("exposes the reasoning route in the backend", () => {
  const http = read("bridge", "real_http.py");
  assert.match(http, /parsed\.path == "\/api\/reasoning"/u);
  const service = read("bridge", "backend_service.py");
  assert.match(service, /def model_reasoning\(self, user\)/u);
  assert.match(service, /except PayloadUnreadable/u);
});
