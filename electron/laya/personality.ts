import type { Answer, Question } from "./types";

export const MBTI_QUESTION_VERSION = "mbti-chat-evidence-v3";
export const MBTI_SOURCES = [
  "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
  "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
] as const;

export interface PersonalityEvidence {
  EI: { E: number; I: number; insufficient: number };
  SN: { S: number; N: number; insufficient: number };
  TF: { T: number; F: number; insufficient: number };
  JP: { J: number; P: number; insufficient: number };
}
const OPTIONS = {
  EI: ["no stated energy preference", "outward interaction restores energy", "inward reflection restores energy"],
  SN: ["no stated information preference", "concrete facts and experience", "patterns and possibilities"],
  TF: ["no stated decision preference", "logical principles in decisions", "personal values and people's impact"],
  JP: ["no stated external world preference", "structured closure and schedules", "flexible exploration of options"],
} as const;

export const PERSONALITY_QUESTIONS: Record<string, Question> = {
  mbti_scope: {
    type: "choice",
    instructions: "Does the TARGET sender explicitly describe their own enduring or recurring personal preference across situations? A greeting, refusal, kind act, emotion, ordinary plan or isolated fact is NOT preference evidence.",
    criteria: ["no enduring preference stated", "sender states a recurring personal preference"],
  },
  mbti_EI: {
    type: "choice",
    instructions: "Classify only the sender's stated recurring preference for restoring energy. Routine chat or talking a lot is not evidence. If no self-described stable preference, choose no stated preference.",
    criteria: [...OPTIONS.EI],
  },
  mbti_SN: {
    type: "choice",
    instructions: "Classify only the sender's stated recurring preference for taking in information. Mentioning a fact or idea once is not a stable preference. If not self-described, choose no stated preference.",
    criteria: [...OPTIONS.SN],
  },
  mbti_TF: {
    type: "choice",
    instructions: "Classify only the sender's stated recurring basis for making decisions. Emotion alone is not evidence. If there is no self-described stable decision preference, choose no stated preference.",
    criteria: [...OPTIONS.TF],
  },
  mbti_JP: {
    type: "choice",
    instructions: "Classify only the sender's stated recurring preference for organizing the external world. One appointment is not evidence. If no self-described stable preference, choose no stated preference.",
    criteria: [...OPTIONS.JP],
  },
};

/**
 * API-mode MBTI wording. Same option labels (so the shared converter and the persisted
 * evidence contract are untouched), but the scope question accepts a preference the
 * sender demonstrates across the batch, not only one they spell out. A chat rarely
 * contains a textbook self-description, and demanding one left every axis permanently
 * unknown. The version is separate from `MBTI_QUESTION_VERSION` so only the API
 * classifier rebuilds; the local Laya profile keeps its cached results.
 *
 * `mbti-api-context-v2` aligns the wording with how the batch signal is actually
 * consumed: `personalityEvidenceFromAnswers` gates all four axes on the scope answer,
 * `_merge` discards an axis outright when the no-preference weight is the highest of
 * the three, and `mbti_from_totals` discards an axis whose sides differ by less than
 * 0.2. So the scope question now asks for batch-level existence rather than typicality,
 * every axis demands the same direction in more than one situation, and each axis is
 * told to reserve the no-preference option for a genuinely directionless batch.
 */
export const API_MBTI_QUESTION_VERSION = "mbti-api-context-v2";

export const API_PERSONALITY_QUESTIONS: Record<string, Question> = {
  mbti_scope: {
    type: "choice",
    instructions: "Across the whole batch, is there at least one axis preference the TARGET sender either states about themselves or demonstrates through how they repeatedly behave? This is an existence check for the batch, not a verdict on how typical the messages look: as soon as one axis shows a recurring pattern, answer yes even when most other messages look neutral, because this answer alone enables all four axes. A single greeting, one refusal, one mood, one plan or one isolated fact is NOT a preference, and one axis showing nothing says nothing about the others.",
    criteria: ["no enduring preference stated", "sender states a recurring personal preference"],
  },
  mbti_EI: {
    type: "choice",
    instructions: "How does this sender repeatedly restore energy? Weight how they INITIATE contact (who opens a topic after a gap, who keeps a thread going, who writes long unprompted messages) over how much they talk when asked, and require the same direction in more than one situation before leaning on a pole. Long messages alone, being busy, or one lively conversation is not evidence. Use no stated energy preference only when the batch gives no direction at all on this axis, not when it gives both.",
    criteria: [...OPTIONS.EI],
  },
  mbti_SN: {
    type: "choice",
    instructions: "How does this sender repeatedly take in information? Weight what they VOLUNTARILY bring up and ask about across topics (concrete events, details and step-by-step specifics versus patterns, abstractions, possibilities and implications), and require the same direction in more than one topic before leaning on a pole. Do not classify the subject matter they happen to discuss. Use no stated information preference only when the batch gives no direction at all on this axis, not when it gives both.",
    criteria: [...OPTIONS.SN],
  },
  mbti_TF: {
    type: "choice",
    instructions: "How does this sender repeatedly decide? Weight the REASON they give when they disagree, refuse, prioritise or resolve a conflict (consistency, fairness and rules versus the effect on people, harmony and commitments), not how warm the message feels, and require the same direction in more than one situation before leaning on a pole. One emotional outburst is not evidence. Use no stated decision preference only when the batch gives no direction at all on this axis, not when it gives both.",
    criteria: [...OPTIONS.TF],
  },
  mbti_JP: {
    type: "choice",
    instructions: "How does this sender repeatedly relate to plans and open loops? Weight whether they settle things (deadlines, confirmations, decisions, wanting a closed answer) or keep them open (options left alive, plans drifting, deferring commitments) across several situations, not one appointment, and require the same direction in more than one of them before leaning on a pole. Use no stated external world preference only when the batch gives no direction at all on this axis, not when it gives both.",
    criteria: [...OPTIONS.JP],
  },
};

function distribution<Left extends string, Right extends string>(
  answer: Answer | undefined,
  left: Left,
  right: Right,
  options: readonly [string, string, string],
): Record<Left | Right | "insufficient", number> | null {
  if (!answer || answer.type !== "choice") return null;
  const probabilities = answer.probabilities;
  if (!options.every((key) =>
    Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1
  )) return null;
  return { [left]: probabilities[options[1]], [right]: probabilities[options[2]], insufficient: probabilities[options[0]] } as Record<Left | Right | "insufficient", number>;
}

export function personalityEvidenceFromAnswers(answers: Record<string, Answer>): PersonalityEvidence | null {
  const scope = answers.mbti_scope;
  if (!scope || scope.type !== "choice" ||
    (scope.probabilities["sender states a recurring personal preference"] ?? 0) <=
    (scope.probabilities["no enduring preference stated"] ?? 0)) return null;
  const EI = distribution(answers.mbti_EI, "E", "I", OPTIONS.EI);
  const SN = distribution(answers.mbti_SN, "S", "N", OPTIONS.SN);
  const TF = distribution(answers.mbti_TF, "T", "F", OPTIONS.TF);
  const JP = distribution(answers.mbti_JP, "J", "P", OPTIONS.JP);
  if (!EI || !SN || !TF || !JP) return null;
  const anySupported = EI.E > EI.insufficient || EI.I > EI.insufficient ||
    SN.S > SN.insufficient || SN.N > SN.insufficient ||
    TF.T > TF.insufficient || TF.F > TF.insufficient ||
    JP.J > JP.insufficient || JP.P > JP.insufficient;
  return anySupported ? { EI, SN, TF, JP } : null;
}
