// Written for this project (not vendored).
//
// The local fine per-message label path (`messageLabelsOnly`) extracted from
// `analysis.ts::classifyMessage`. It owns only the fine question/answer handling;
// the caller injects an already budget-checked predict callback and keeps the model,
// runtime, cache, portrait and DTO responsibilities. The questions, probabilities,
// candidate ordering and the single model call are identical to the previous inline
// branch. The fine path never depends on the portrait implementation.

import type { LabelScore } from "../shared/contracts";
import { generalIntentQuestion, generalIntentScores } from "./laya/general-intent";
import { FINE_DISPLAY_QUESTIONS } from "./laya/options";
import type { Answer, Question } from "./laya/types";

export interface FineMessageInsight {
  emotion: LabelScore[];
  intent: LabelScore[];
  intentBroad: LabelScore[];
  /**
   * Only meaningful for test doubles that answer more than they were asked: the real path no
   * longer asks Laya for `relationship` (the char-ngram classifier owns it), so a live run
   * always leaves this empty. Kept because the OTHER-side protocol still reads the field.
   */
  relationship: LabelScore[];
}

type PredictAnswers = (questions: Record<string, Question>) => Promise<Record<string, Answer>>;

/** Mirrors the analysis-local label ranking: raw choice probabilities, no renormalization. */
function rankedScores(answer: Answer | undefined): LabelScore[] {
  if (!answer || answer.type !== "choice") return [];
  return Object.entries(answer.probabilities)
    .map(([label, probability]) => ({ label, probability }))
    .sort((a, b) => b.probability - a.probability);
}

/** The fine question set for one target; split out so a window can be batched. */
export function fineMessageQuestions(
  _side: "self" | "other",
  targetText: string,
  contextHint = "",
): Record<string, Question> {
  const intentQuestion = generalIntentQuestion(targetText, contextHint);
  // `relationship` is no longer asked of Laya: the trained char-ngram classifier owns that
  // signal for both sides (analysis.ts calls `relationshipScoresForText`). Keeping the question
  // cost one extra head per message and its answer was always discarded.
  return { ...FINE_DISPLAY_QUESTIONS, intent: intentQuestion.question };
}

/** Map one prediction's answers back to the fine DTO; split out for the batched path. */
export function fineMessageInsight(
  answers: Record<string, Answer>,
  side: "self" | "other",
): FineMessageInsight {
  const intent = generalIntentScores(answers.intent);
  return {
    emotion: rankedScores(answers.emotion),
    intent,
    intentBroad: intent,
    relationship: side === "other" ? rankedScores(answers.relationship) : [],
  };
}

/**
 * One budget-checked prediction per target, exactly like the previous inline branch.
 *
 * `contextHint` is a bounded slice of preceding messages; it only influences which intent
 * candidates enter the question and never carries a probability. Still one predict call.
 */
export async function generateFineMessageInsight(
  predict: PredictAnswers,
  side: "self" | "other",
  targetText: string,
  contextHint = "",
): Promise<FineMessageInsight> {
  return fineMessageInsight(
    await predict(fineMessageQuestions(side, targetText, contextHint)),
    side,
  );
}
