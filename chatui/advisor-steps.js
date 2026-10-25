// Coarse progress steps for one advisor run.
//
// The bridge only publishes labels it owns ("正在读取会话资料"), never message text, prompts or
// model reasoning. This module keeps that contract on the UI side too: anything that is not a
// short label in one of the allowed states is dropped instead of rendered.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AdvisorSteps = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STEP_STATES = ["reading", "preparing", "compacting", "thinking"];
  const MAX_STEPS = 4;
  const MAX_LABEL = 120;

  function clean(event) {
    if (!event || typeof event !== "object") return null;
    if (STEP_STATES.indexOf(event.state) < 0) return null;
    if (typeof event.text !== "string") return null;
    const text = event.text.trim();
    if (!text || text.length > MAX_LABEL) return null;
    return { state: event.state, text };
  }

  // The same label can arrive again (retry, re-entering a phase); keep it once, in order.
  function collect(steps, event) {
    const previous = Array.isArray(steps) ? steps.filter(step => clean(step)) : [];
    const step = clean(event);
    if (!step) return previous;
    if (previous.some(item => item.state === step.state && item.text === step.text)) return previous;
    const next = previous.concat([step]);
    return next.length > MAX_STEPS ? next.slice(next.length - MAX_STEPS) : next;
  }

  return { STEP_STATES: STEP_STATES, MAX_STEPS: MAX_STEPS, MAX_LABEL: MAX_LABEL, collect: collect };
});
