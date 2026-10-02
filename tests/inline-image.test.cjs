const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const root = path.join(__dirname, "..");
const app = readFileSync(path.join(root, "chatui/app.js"), "utf8");
const css = readFileSync(path.join(root, "chatui/style.css"), "utf8");

it("renders image messages from the local bridge instead of a text placeholder", () => {
  assert.ok(app.includes('image.className = "msg-image"'));
  assert.ok(app.includes('"/api/media?user="'));
  assert.ok(app.includes('image.classList.toggle("zoomed")'));
  assert.ok(app.includes('&retry=" + attempts'));
  assert.ok(app.includes('element("div", "msg-bubble", "[图片]")'),
    "the placeholder must stay as the final fallback");
  assert.ok(css.includes(".msg-image {"));
  assert.ok(css.includes(".msg-image.zoomed {"));
});

it("escapes the message id into the media URL", () => {
  assert.ok(app.includes('"&id=" + encodeURIComponent(message.id)'));
  assert.ok(app.includes('encodeURIComponent(chatState.currentUser)'));
});
