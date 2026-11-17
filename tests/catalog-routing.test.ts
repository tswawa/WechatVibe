// Written for this project (not vendored).
//
// Pins the cascade contract of `routeEmotion` / `routeIntent`: every branch of one level is
// asked in a single `predict` call (LayaAgent batches those rows into one forward pass), and
// each branch's answer must still be multiplied by its own parent probability.
import assert from "node:assert/strict";
import { it } from "node:test";

import { EMOTION_BUCKETS, INTENT_FAMILIES, INTENTS,
  emotionDetailQuestion, routeEmotion, routeIntent } from "../electron/laya/catalog";
import type { Answer, Question } from "../electron/laya/types";

function labelsOf(question: Question): string[] {
  return Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria);
}

/** Deterministic one-hot for the label at `winner`, so branch ownership is visible in the score. */
function oneHot(question: Question, winner: number): Answer {
  const labels = labelsOf(question);
  const probabilities: Record<string, number> = {};
  labels.forEach((label, index) => { probabilities[label] = index === winner ? 1 : 0; });
  return { type: "choice", probabilities };
}

/** First label of every question: the merged code must map it back to its own parent. */
function firstLabelAnswers() {
  const calls: Array<Record<string, Question>> = [];
  const predict = async (questions: Record<string, Question>) => {
    calls.push(questions);
    const answers: Record<string, Answer> = {};
    for (const [name, question] of Object.entries(questions)) answers[name] = oneHot(question, 0);
    return answers;
  };
  return { calls, predict };
}

it("asks both selected emotion families in one call and keeps each parent probability", async () => {
  const { calls, predict } = firstLabelAnswers();
  const scores = await routeEmotion({ type: "choice", probabilities: { neutral: 0.4, happy: 0.35, sad: 0.25 } }, predict);
  assert.equal(calls.length, 1, "one call for the whole level");
  assert.deepEqual(Object.keys(calls[0]!), ["emotion_detail_0", "emotion_detail_1"]);
  assert.deepEqual(calls[0]!.emotion_detail_0, emotionDetailQuestion("neutral"));
  assert.deepEqual(calls[0]!.emotion_detail_1, emotionDetailQuestion("happy"));
  // Each detail answers its own first label with certainty, so the routed score is exactly the
  // parent probability — proof that answers were matched back by index, not by list order.
  const byLabel = new Map(scores.map(score => [score.label, score.probability]));
  const neutralFirst = EMOTION_BUCKETS.neutral[0];
  const happyFirst = EMOTION_BUCKETS.happy[0];
  assert.equal(byLabel.get(neutralFirst), 0.4);
  assert.equal(byLabel.get(happyFirst), 0.35);
});

it("asks a single emotion family when the parent is already decisive", async () => {
  const { calls, predict } = firstLabelAnswers();
  await routeEmotion({ type: "choice", probabilities: { neutral: 0.8, happy: 0.2 } }, predict);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!), ["emotion_detail_0"]);
});

it("asks both intent levels in one call each and keeps branch ownership", async () => {
  const { calls, predict } = firstLabelAnswers();
  const routed = await routeIntent({
    type: "choice",
    probabilities: Object.fromEntries(INTENT_FAMILIES.map((family, index) =>
      [family.modelLabel, index === 0 ? 0.5 : 0.5 / (INTENT_FAMILIES.length - 1)])),
  }, predict);
  assert.equal(calls.length, 2, "group level + leaf level, nothing per branch");
  assert.equal(Object.keys(calls[0]!).length, 2, "two families in the group call");
  assert.equal(Object.keys(calls[1]!).length, 2, "the two selected groups in the leaf call");
  assert.equal(routed.selectedGroups.length, 2);
  // Both groups answer their first leaf with certainty, so the only non-zero scores are the two
  // parent probabilities (0.5 for the first family, 0.5/n for the second). That proves each
  // answer was multiplied by its own parent, not by whichever branch happened to be first.
  const nonzero = routed.scores.filter(score => score.probability > 0);
  assert.equal(nonzero.length, 2);
  assert.deepEqual(nonzero.map(score => score.probability).sort((a, b) => a - b),
    [0.5 / (INTENT_FAMILIES.length - 1), 0.5].sort((a, b) => a - b));
  const ownerByLabel = new Map(INTENTS.map(intent => [intent.id, intent.group]));
  for (const score of nonzero)
    assert.equal(routed.selectedGroups.includes(ownerByLabel.get(score.label)!), true,
      `${score.label} must belong to a selected group`);
});
