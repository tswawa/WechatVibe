"use strict";
// The persona header carries its own model switcher, so the source can be changed without
// navigating back to the conversation. Both triggers share one code path; these assertions
// stop a second, divergent copy from creeping in.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");
const html = readFileSync(path.join(__dirname, "..", "chatui", "index.html"), "utf8").replace(/\r/gu, "");
const css = readFileSync(path.join(__dirname, "..", "chatui", "style.css"), "utf8").replace(/\r/gu, "");

function body(signature) {
  const first = app.indexOf(signature);
  assert.ok(first >= 0, `Missing function: ${signature}`);
  const end = app.indexOf("\n}\n", first);
  assert.ok(end > first, `Unterminated function: ${signature}`);
  return app.slice(first, end + 3);
}

const TRIGGERS = [
  { trigger: "modelBadge", menu: "modelBadgeMenu" },
  { trigger: "portraitSourceBadge", menu: "portraitSourceMenu" },
];

it("gives the persona header a real button, not a static badge", () => {
  assert.match(html, /<button type="button" class="portrait-source-badge" id="portraitSourceBadge"/u);
  // A span cannot be focused or pressed, so the switcher has to be a button.
  assert.doesNotMatch(html, /<span class="portrait-source-badge"/u);
  assert.match(html, /id="portraitSourceBadge"[\s\S]{0,200}aria-haspopup="menu"/u);
  assert.match(html, /id="portraitSourceMenu"/u);
});

it("wires both triggers to the same toggle with their own ids", () => {
  // The chat header relies on the defaults, so the defaults have to be the chat header's pair.
  assert.match(app, /function toggleModelBadgeMenu\(triggerId = "modelBadge", menuId = "modelBadgeMenu"\)/u);
  assert.match(app,
    /byId\("modelBadge"\)\.addEventListener\("click", \(\) => \{ toggleModelBadgeMenu\(\); \}\)/u);
  assert.match(app,
    /byId\("portraitSourceBadge"\)\.addEventListener\("click", \(\) => \{\s*\n\s*toggleModelBadgeMenu\("portraitSourceBadge", "portraitSourceMenu"\);\s*\n\}\)/u);
  // Both panels share one click handler, so the rows cannot diverge between headers.
  assert.match(app, /byId\("modelBadgeMenu"\)\.addEventListener\("click", handleModelMenuClick\)/u);
  assert.match(app, /byId\("portraitSourceMenu"\)\.addEventListener\("click", handleModelMenuClick\)/u);
  assert.match(body("function handleModelMenuClick("), /activateModelProfile\(option\.dataset\.profileId/u);
});

it("closes every model menu, whichever header asked for it", () => {
  // Switching from the persona header must not leave the chat header's panel open behind it.
  // Enumerated by id, not a DOM query: the UI tests drive app.js with a minimal document stub.
  assert.match(app, /const MODEL_MENU_PAIRS = \[\s*\n\s*\["modelBadge", "modelBadgeMenu"\],\s*\n\s*\["portraitSourceBadge", "portraitSourceMenu"\],/u);
  assert.match(body("function modelMenus()"), /MODEL_MENU_PAIRS\.map\(\(\[trigger, menu\]\) => \(\{ trigger, menu: byId\(menu\) \}\)\)/u);
  const close = body("function closeModelBadgeMenu()");
  assert.match(close, /for \(const \{ trigger, menu \} of modelMenus\(\)\)/u);
  assert.match(close, /byId\(trigger\)\?\.setAttribute\("aria-expanded", "false"\)/u);
  assert.match(close, /menu\.hidden = true/u);
  const toggle = body("function toggleModelBadgeMenu(");
  assert.match(toggle, /closeModelBadgeMenu\(\);\s*\n\s*menu\.hidden = false/u);
});

it("does not close the panel the moment its own trigger is clicked", () => {
  // The document listener runs after the trigger handler, so it must test the shared marker
  // rather than one header's id.
  assert.match(app,
    /if \(!event\.target\.closest\("\[data-model-menu-wrap\]"\)\) closeModelBadgeMenu\(\);/u);
  assert.doesNotMatch(app, /closest\("#modelBadgeWrap"\)\) closeModelBadgeMenu/u);
  for (const wrap of ["modelBadgeWrap", "portraitSourceWrap"]) {
    assert.match(html, new RegExp(`id="${wrap}" data-model-menu-wrap`, "u"));
  }
});

it("renders the same rows in both menus", () => {
  const render = body("function renderModelBadgeMenu(");
  assert.match(render, /profiles\.map\(modelBadgeOption\), localModelBadgeOption\(\), foot/u);
  // One builder, so the persona panel cannot drift from the chat panel.
  assert.match(app, /menu\.replaceChildren\(\.\.\.profiles\.map\(modelBadgeOption\)/u);
});

it("hides the persona switcher until a source is resolved", () => {
  const badge = body("function renderModelBadge()");
  assert.match(badge, /byId\("portraitSourceWrap"\)\.hidden = true/u);
  assert.match(badge, /byId\("portraitSourceWrap"\)\.hidden = false/u);
});

it("positions the panel and makes the badge look pressable", () => {
  // The panel is reused from the chat header, so it needs a positioned ancestor of its own.
  assert.match(css, /\.portrait-source-wrap \{[^}]*position: relative/u);
  assert.match(css, /\.portrait-source-badge \{[^}]*cursor: pointer/u);
  assert.match(css, /\.portrait-source-badge:hover[^{]*\{[^}]*border-color: var\(--color-green\)/u);
  // Reset the button defaults so it keeps the chip look it had as a span.
  assert.match(css, /\.portrait-source-badge \{[^}]*font-family: inherit/u);
  assert.match(css, /\.portrait-source-badge \{[^}]*background: none/u);
});