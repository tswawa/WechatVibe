"use strict";
// Stateless local/API display adapters. They only reshape already-decided results
// into one display model and never fetch, time, cache, read storage, or call a
// model. The local and API branches keep their own data sources and rules; the
// adapter never invents a probability or fabricates a candidate. The local path keeps
// the model's own probabilities for the 1-3 candidates the reader asked to see; the API
// path ships one label per field and no probabilities, so its view carries labels only.
(function () {
  // Presentation view: { emotions: [{label}], intents: [{label}] }.
  function localView(result, text, dependencies) {
    const { rankedEmotionScores, displayedIntent, isIncompleteFragment } = dependencies;
    const schemaMatches = dependencies.labelSchema === undefined || result.labelSchema === dependencies.labelSchema;
    // Punctuation-only messages can still carry tone or intent. Only blank
    // whitespace is excluded at the presentation boundary.
    const usable = schemaMatches && typeof text === "string" && text.trim().length > 0 &&
      !isIncompleteFragment(text);
    const limit = Math.max(1, Math.min(3, Number(dependencies.optionCount) || 1));
    const emotionScores = typeof dependencies.displayedEmotion === "function"
      ? dependencies.displayedEmotion(result.emotion, text, limit)
      : rankedEmotionScores(result.emotion);
    // One candidate is the original view: labels only. The richer view exists for the
    // reader who asked to compare candidates, so only it carries probabilities and ties.
    const detail = limit > 1;
    const emotions = emotionScores.slice(0, limit).map(({ item, probability, close }) => detail ? {
      label: String(item.label).trim(),
      probability: Number.isFinite(probability) ? probability : null,
      close: close === true,
    } : { label: String(item.label).trim() });
    const intents = usable ? displayedIntent(result, text, limit).map((candidate) => detail ? {
      label: String(candidate.label).trim(),
      probability: Number.isFinite(candidate.probability) ? candidate.probability : null,
      close: candidate.close === true,
    } : { label: String(candidate.label).trim() }) : [];
    return { emotions, intents };
  }
  const API_AFFECT_KEYS = ["feeling", "tone", "interaction"];
  // Light shape adaptation only: label validity is enforced by the API
  // parser and by app.js `validApiInsight`; the renderer writes textContent so a
  // value can never become markup.
  function apiLabel(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  // Reads both the S1 affect/intents shape and the legacy scalar {emotion,intent}
  // shape; routine/uncertain/insufficient are terminal successes with no labels.
  function apiView(result, text = "") {
    if (!result || typeof result !== "object" || result.status !== "ok") {
      return { emotions: [], intents: [] };
    }
    const emotions = [];
    const affect = result.affect && typeof result.affect === "object" && !Array.isArray(result.affect)
      ? result.affect : null;
    if (affect) {
      for (const key of API_AFFECT_KEYS) {
        const label = apiLabel(affect[key]);
        if (label) {
          emotions.push({ label });
          break;
        }
      }
    }
    let intents = [];
    if (Array.isArray(result.intents)) {
      intents = result.intents.map(apiLabel).filter(Boolean).slice(0, 1)
        .map(label => ({ label }));
    } else {
      const legacy = apiLabel(result.intent);
      if (legacy) intents = [{ label: legacy }];
    }
    if (!emotions.length) {
      const legacy = apiLabel(result.emotion);
      if (legacy) emotions.push({ label: legacy });
    }
    return { emotions: emotions.slice(0, 1), intents };
  }
  window.MessageInsightAdapters = Object.freeze({ localView, apiView });
})();
