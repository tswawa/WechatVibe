"use strict";
// Stateless label renderers shared by the local and API display paths.
// The factory receives its DOM and formatting dependencies and owns no account,
// task or cache state; it never reads localStorage, fetches or sets timers.
(function () {
  function create(dependencies) {
    const element = dependencies.element;
    const percent = typeof dependencies.percent === "function" ? dependencies.percent : () => "";
    // One template for both sources: an emotion line followed by an intent line. The reader
    // chooses how many candidates a line carries (1-3). The first stays primary, each model
    // candidate keeps its own probability, and a candidate close to the leader is tagged
    // rather than dropping the rest of the line.
    const MAX_OPTIONS = 3;
    function candidateNode(entry, primary) {
      const node = element("span", `intent-item${primary ? " primary" : ""}`);
      node.appendChild(element("span", "intent-name", String(entry.label).trim()));
      // Only a real score earns a percentage; a label that carries no probability at all
      // (the API path, or the single-candidate view) stays clean text.
      const text = Number.isFinite(entry.probability) ? percent(entry.probability) : "";
      if (text) node.appendChild(element("span", "intent-pct", text));
      else if (entry.probability === null) node.title = "文本线索判断";
      if (entry.close) {
        const tag = element("span", "intent-close", "相近");
        tag.title = "与前一项概率接近，判断不确定";
        node.appendChild(tag);
      }
      return node;
    }
    function render(view, messageId) {
      const row = element("div", "inline-intent-row");
      if (!view.emotions.length && !view.intents.length) return row;
      const line = element("div", `intent-line${view.emotions.length ? " emotion-line" : ""}${view.intents.length ? " intent-score-line" : ""}`);
      if (view.emotions.length) {
        line.appendChild(element("span", "intent-label", "情绪"));
        for (const [index, entry] of view.emotions.slice(0, MAX_OPTIONS).entries()) {
          line.appendChild(candidateNode(entry, index === 0));
        }
      }
      if (view.intents.length) {
        line.appendChild(element("span", "intent-label intent-label-intent", "意图"));
        for (const [index, entry] of view.intents.slice(0, MAX_OPTIONS).entries()) {
          line.appendChild(candidateNode(entry, index === 0));
        }
      }
      row.appendChild(line);
      return row;
    }
    // Compatibility helpers keep the old single-line entry points without a second template.
    function scoreEntry(score) {
      return { label: String(score.item.label).trim() };
    }
    function appendScoreLine(container, label, scores, messageId, emotion = false) {
      if (!scores.length) return;
      const entries = scores.slice(0, MAX_OPTIONS).map(scoreEntry);
      const view = emotion ? { emotions: entries, intents: [] } : { emotions: [], intents: entries };
      const row = render(view, messageId);
      for (const line of [...row.children]) {
        line.children[0].textContent = label;
        container.appendChild(line);
      }
    }
    function appendIntentLine(container, candidates) {
      if (!candidates.length) return;
      const view = { emotions: [], intents: candidates.slice(0, MAX_OPTIONS).map((candidate) => ({
        label: String(candidate.label).trim(),
      })) };
      const row = render(view, "");
      for (const line of [...row.children]) container.appendChild(line);
    }
    return { render, renderApiInsightResult: render, appendScoreLine, appendIntentLine };
  }
  window.MessageLabels = Object.freeze({ create });
})();
