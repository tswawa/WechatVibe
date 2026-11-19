"use strict";
// 主题色是纯 CSS 变量 + body[data-theme-accent] 预设：设置页选一个色点，只改一个属性，
// 按钮、链接、高亮、气泡都跟着走；选择写进既有的 real-ui-settings-1，刷新后保留。
// 助手仓库与沙箱军师窗口也共用同一套令牌，避免那里留下一片写死的绿色。
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8").replace(/\r/gu, "");

const html = read("chatui", "index.html");
const frameHtml = read("chatui", "advisor-frame.html");
const css = read("chatui", "style.css");
const themeCss = read("chatui", "theme-accent.css");
const advisorCss = read("chatui", "advisor.css");
const timelineCss = read("chatui", "advisor-timeline.css");
const app = read("chatui", "app.js");
const advisor = read("chatui", "advisor.js");
const frame = read("chatui", "advisor-frame.js");
// 规则查询覆盖所有样式表：预设已抽到独立的 theme-accent.css。
const allCss = [css, themeCss, advisorCss, timelineCss].join("\n");

const ACCENTS = ["green", "blue", "yellow", "red"];
const TOKENS = ["--theme-accent", "--theme-accent-strong", "--theme-accent-deep",
  "--theme-accent-rgb", "--theme-accent-contrast"];

function ruleBodies(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...allCss.matchAll(new RegExp("(?:^|\\n)" + escaped + " \\{([^}]*)\\}", "gu"))];
  assert.ok(matches.length, `样式表缺少规则 ${selector}`);
  return matches.map(match => match[1]);
}

function ruleBody(selector) {
  return ruleBodies(selector)[0];
}

it("puts a four-swatch picker plus a reset button in 通用设置", () => {
  const general = html.slice(html.indexOf('id="panelGeneral"'),
    html.indexOf("<!-- Panel 2: Model configuration -->"));
  assert.match(general, /id="themeAccentPicker"[^>]*role="radiogroup"/u);
  for (const accent of ACCENTS) {
    assert.match(general, new RegExp(`data-accent="${accent}"`, "u"), `缺少 ${accent} 色点`);
  }
  assert.match(general, /id="btnResetThemeAccent"[^>]*>恢复默认</u);
  // 色点要有可读的标签，不能只有颜色。
  for (const accent of ACCENTS) {
    assert.match(general, new RegExp(`data-accent="${accent}"[^>]*aria-label="[^"]+"`, "u"));
  }
});

it("defines a light and a dark variant for every preset", () => {
  for (const token of TOKENS) {
    assert.ok(themeCss.includes(token + ":"), `共享样式表必须定义 ${token}`);
  }
  for (const accent of ACCENTS) {
    for (const selector of [`body[data-theme-accent="${accent}"]`,
      `body.theme-light[data-theme-accent="${accent}"]`]) {
      const body = ruleBody(selector);
      for (const token of TOKENS) {
        assert.ok(body.includes(token + ":"), `${selector} 必须覆写 ${token}`);
      }
    }
  }
});

it("declares the legacy accent alias on body so presets can override it", () => {
  // 自定义属性在声明处解析：--color-green 若只在 :root 写成 var(--theme-accent)，
  // 会固化成默认绿，body 上的预设就影响不到它。
  const bodyRules = ruleBodies("body");
  assert.ok(bodyRules.some(rule => /--color-green: var\(--theme-accent\)/u.test(rule)),
    "body 上必须把 --color-green 重新声明成 var(--theme-accent)");
  assert.ok(bodyRules.some(rule => /--bg-bubble-right: color-mix\(in srgb, var\(--theme-accent\)/u.test(rule)),
    "气泡颜色必须由主题色混合得出");
  // 浅色块不能再把 --color-green 钉死成具体颜色。
  assert.equal(/body\.theme-light \{[^}]*--color-green:/u.test(allCss), false);
});

it("routes the themed surfaces through the accent tokens", () => {
  assert.match(ruleBody(".settings-tab-btn.active"), /color: var\(--theme-accent\)/u);
  assert.match(ruleBody(".settings-tab-btn.active"), /border-left: 3px solid var\(--theme-accent\)/u);
  assert.match(ruleBody(".settings-toggle.on"), /background: var\(--theme-accent/u);
  assert.match(ruleBody(".msg-item.outgoing .msg-bubble"), /background-color: var\(--bg-bubble-right\)/u);
  assert.match(ruleBody(".nav-item.active, .persona-nav-title svg"),
    /color: var\(--color-green\).*fill: var\(--color-green\)/u);
  // 主题色不能再被写死在组件规则里：色点展示色本身和令牌定义除外。
  const withoutTokens = allCss
    .replace(/\.theme-accent-swatch\[data-accent="[a-z]+"\] \{[^}]*\}/gu, "")
    .replace(/--theme-accent[a-z-]*:[^;]+;/gu, "");
  for (const literal of ["#07c160", "#76a988", "#06ad56", "#789782", "rgba(7, 193, 96", "rgba(7,193,96"]) {
    assert.equal(withoutTokens.includes(literal), false, `${literal} 仍然被硬编码`);
  }
});

it("shares the accent tokens with the main page, the repo and the sandboxed frame", () => {
  // 沙箱窗口不加载 style.css，必须单独引用共享令牌文件。
  assert.match(html, /<link rel="stylesheet" href="theme-accent\.css">/u);
  assert.match(frameHtml, /<link rel="stylesheet" href="theme-accent\.css">/u);
  assert.equal(/href="style\.css"/u.test(frameHtml), false);
  // 助手仓库的元素全部用变量；主按钮文字走对比色令牌（黄色预设下是深字）。
  assert.match(advisorCss, /\.advisor-btn-primary \{ background: var\(--theme-accent\);[^\n]*color: var\(--theme-accent-contrast\);/u);
  assert.match(advisorCss, /\.advisor-switch\.checked \{ background: var\(--theme-accent\);/u);
  assert.match(advisorCss, /\.advisor-engine-badge \{[^}]*rgba\(var\(--theme-accent-rgb\),\.15\)/u);
  assert.match(advisorCss, /\.advisor-history-row\.is-active \{[^}]*var\(--theme-accent\)/u);
  assert.match(timelineCss, /blockquote \{[^}]*border-left: 2px solid var\(--theme-accent\)/u);
  assert.match(css, /\.modal-btn\.confirm \{\n  background: var\(--theme-accent\);\n  color: var\(--theme-accent-contrast\);/u);
});

it("forwards the accent to the companion window on init and on every change", () => {
  assert.match(advisor, /function frameThemePayload\(\)/u);
  assert.match(advisor, /accent: FRAME_ACCENTS\.includes\(accent\) \? accent : "green"/u);
  assert.match(advisor, /engineState: this\.catalogReady \? this\.catalog\.engine\.state : "unknown",\n\s*\.\.\.frameThemePayload\(\)/u);
  assert.match(advisor, /postToFrame\("ADVISOR_THEME", frameThemePayload\(\)\)/u);
  assert.match(advisor, /attributeFilter: \["class", "data-theme-accent"\]/u);
  // 沙箱侧白名单、校验、落属性、旧消息回落绿色。
  assert.match(frame, /ADVISOR_THEME: \["theme", "accent"\]/u);
  assert.match(frame, /ADVISOR_INIT: \[[^\]]*"accent"/u);
  assert.match(frame, /payload\.accent !== undefined && !ACCENTS\.includes\(payload\.accent\)/u);
  assert.equal((frame.match(/dataset\.themeAccent = ACCENTS\.includes/gu) || []).length, 2);
});

it("defaults to green, validates stored values and applies the attribute", () => {
  assert.match(app, /guidanceWindowMinutes: 1440, accent: "green"/u);
  assert.match(app, /const THEME_ACCENTS = \["green", "blue", "yellow", "red"\];/u);
  assert.match(app, /if \(!THEME_ACCENTS\.includes\(settingsState\.settings\.accent\)\) settingsState\.settings\.accent = "green";/u);
  assert.match(app, /function applyThemeAccent\(\)/u);
  assert.match(app, /document\.body\.dataset\.themeAccent = accent;/u);
  assert.match(app, /swatch\.setAttribute\("aria-checked", String\(swatch\.dataset\.accent === accent\)\)/u);
  assert.match(app, /reset\.disabled = accent === "green";/u);
  // applySettings 是唯一入口：换主题模式、缩放、启动时都会重新落一次主题色。
  const apply = app.slice(app.indexOf("function applySettings()"));
  assert.match(apply.slice(0, 700), /applyThemeAccent\(\);/u);
});

it("persists the choice through the existing settings store and resets to green", () => {
  const picker = app.slice(app.indexOf('byId("themeAccentPicker").addEventListener'));
  const handler = picker.slice(0, picker.indexOf("});"));
  assert.match(handler, /settingsState\.settings\.accent = swatch\.dataset\.accent;/u);
  assert.match(handler, /save\(\);/u);
  assert.match(handler, /applySettings\(\);/u);
  const reset = picker.slice(picker.indexOf('byId("btnResetThemeAccent").addEventListener'));
  assert.match(reset, /settingsState\.settings\.accent = "green";/u);
  assert.match(reset, /save\(\);/u);
  assert.match(reset, /applySettings\(\);/u);
  // 沿用同一个存储键，旧版本设置（没有 accent）读进来后由校验回落成绿色。
  assert.match(app, /localStorage\.setItem\("real-ui-settings-1"/u);
});
