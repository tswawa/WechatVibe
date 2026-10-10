const assert = require("node:assert/strict");

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const app = readFileSync(path.join(__dirname, "..", "chatui", "app.js"), "utf8").replace(/\r/gu, "");

it("never passes several nodes to appendChild", () => {
  // `appendChild` is the legacy single-node method: extra arguments are ignored, so
  // `button.appendChild(tick, body)` added the tick and silently dropped the whole text
  // container. The model badge menu then showed a bare tick per profile, an empty clickable
  // row for the local model, and no model name anywhere.
  const offenders = [];
  for (const [index, line] of app.split("\n").entries()) {
    const open = line.indexOf("appendChild(");
    if (open < 0) continue;
    // Walk the argument list and count top-level commas.
    let depth = 0;
    let commas = 0;
    for (let i = open + "appendChild".length; i < line.length; i++) {
      const char = line[i];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === "," && depth === 0) commas += 1;
    }
    if (commas > 0) offenders.push(`${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], "use append() for multiple nodes");
});

it("builds the model badge rows with their name and model text", () => {
  for (const builder of ["modelBadgeOption", "localModelBadgeOption"]) {
    const start = app.indexOf(`function ${builder}(`);
    assert.ok(start >= 0, `app.js must define ${builder}`);
    const body = app.slice(start, app.indexOf("\nfunction ", start + 1));
    assert.match(body, /body\.append\(name, model\)/u, `${builder} must append both text nodes`);
    assert.match(body, /button\.append\(tick, body\)/u, `${builder} must append the text container`);
  }
  const remote = app.slice(app.indexOf("function modelBadgeOption("),
    app.indexOf("\nfunction ", app.indexOf("function modelBadgeOption(") + 1));
  assert.match(remote, /name\.textContent = profile\.name/u);
  assert.match(remote, /model\.textContent = profile\.model/u);
  const local = app.slice(app.indexOf("function localModelBadgeOption("),
    app.indexOf("\nfunction ", app.indexOf("function localModelBadgeOption(") + 1));
  assert.match(local, /name\.textContent = LOCAL_MODEL_LABEL/u);
  assert.match(local, /model\.textContent = "\u5185\u7f6e\u672c\u5730\u6a21\u578b"/u);
});