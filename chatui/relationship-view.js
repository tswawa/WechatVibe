// Relationship tendency: aggregates the already-analysed per-message relationship
// distributions (the trained char-ngram classifier) into one portrait-level signal.
// Pure functions only — no fetch, no DOM, no storage. The classifier output is already
// on screen in fine results; this module only gives that signal a visible outlet.
(function (root, factory) {
  const api = factory();
  if (root) root.RelationshipView = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CATEGORIES = Object.freeze([
    { key: "rejecting", label: "疏离排斥", tone: "reject" },
    { key: "distant", label: "态度冷淡", tone: "cold" },
    { key: "neutral", label: "中性平和", tone: "neutral" },
    { key: "warm", label: "亲近友善", tone: "warm" },
    { key: "romantic", label: "暧昧好感", tone: "romantic" },
  ]);
  const LABELS = Object.freeze(CATEGORIES.map(category => category.key));

  function labelText(key) {
    const category = CATEGORIES.find(item => item.key === key);
    return category ? category.label : "";
  }

  // results: { [messageId]: { relationship?: [{label, probability}] } }
  // messages: [{ id }] — the currently loaded window, in the same order the UI shows.
  function summarize(results, messages) {
    const source = results && typeof results === "object" && !Array.isArray(results) ? results : {};
    const window = Array.isArray(messages) ? messages : [];
    const counts = Object.create(null);
    for (const category of CATEGORIES) counts[category.key] = 0;
    let classified = 0;
    let totalProbability = 0;
    for (const message of window) {
      if (!message || message.id == null) continue;
      const result = source[String(message.id)];
      const distribution = result && result.relationship;
      if (!Array.isArray(distribution) || !distribution.length) continue;
      let top = null;
      for (const entry of distribution) {
        if (!entry || typeof entry.label !== "string" || !LABELS.includes(entry.label)) continue;
        const probability = Number(entry.probability);
        if (!Number.isFinite(probability) || probability < 0) continue;
        if (!top || probability > top.probability) top = { label: entry.label, probability };
      }
      if (!top) continue;
      counts[top.label] += 1;
      classified += 1;
      totalProbability += top.probability;
    }
    const rows = CATEGORIES.map(category => ({
      ...category, count: counts[category.key],
      share: classified ? counts[category.key] / classified : 0,
    })).sort((left, right) => right.count - left.count ||
      LABELS.indexOf(left.key) - LABELS.indexOf(right.key));
    const dominant = classified ? rows.find(row => row.count === rows[0].count && row.count > 0) : null;
    return {
      classified,
      windowSize: window.length,
      meanConfidence: classified ? totalProbability / classified : 0,
      rows,
      dominant: dominant ? { key: dominant.key, label: dominant.label, share: dominant.share, count: dominant.count } : null,
    };
  }

  return { CATEGORIES, summarize, labelText };
});
