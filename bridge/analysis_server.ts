// Local Laya analysis server (JSONL over stdin/stdout) for the real-data chat UI.
// Reuses the existing production analysis entry; no network, text stays local.
//
// Protocol (one JSON object per line on stdin, one per line on stdout):
//   {"id":N,"cmd":"observe","text":"..."}
//      -> {"id":N,"emotion":[{label,probability}...],"intent":[...],
//          "emotionLabel","intentLabel","emotionP","intentP"}
//   {"id":N,"cmd":"targets","sessionId":"...","messages":[{id,side,text}...],
//    "targetIds":["..."],"previousAffinity":number|undefined}
//      -> {"id":N,"messages":[{messageId,emotion,intent,relationship,...}],
//          "affinity","affinityGrade","relationship","delta","selfQuality","model"}
//   {"id":N,"cmd":"status"} -> {"id":N,"status":{...}}
//
// A model/runtime failure is reported as {"id":N,"error":"..."}; callers must never turn that into
// a 0% / 0-score success.
import path from "node:path";
import * as readline from "node:readline";

import {
  ANALYSIS_VERSION,
  analyzeMessageBatch,
  analyzeMessageTargets,
  analyzeObservedText,
  configureAnalysisRuntime,
  configureModelDir,
  disposeAnalysisModel,
  forecastNextReply,
  getModelStatus,
  prepareModel,
} from "../electron/analysis";
import { emotionLabel, intentLabel } from "../src/lib/labels";
import { messageScore } from "../electron/laya/scoring";
import { EXPRESSIONS } from "../electron/laya/expression";
import { SOCIAL_NEEDS } from "../electron/laya/social-intents";
import { GENERAL_LABEL_SCHEMA } from "../electron/laya/general-intent";
import { MessageBatchInputError, type BatchMessage, type BatchContext } from "../electron/laya/message-batch";

// Observed, unattributed text has model-only generic labels; v3 is reserved for fine targets.
const OBSERVED_LABEL_SCHEMA = "generic-v3";

interface Score {
  label: string;
  probability: number;
}

interface WireMessage {
  id: string;
  side: "self" | "other";
  text: string;
  time: number;
}

function top(items: Score[] | undefined): Score | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  let best = items[0]!;
  for (const it of items) if (it.probability > best.probability) best = it;
  return best;
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const EVIDENCE_AXES = {
  EI: ["E", "I"],
  SN: ["S", "N"],
  TF: ["T", "F"],
  JP: ["J", "P"],
} as const;

function validPersonalityEvidence(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).length !== Object.keys(EVIDENCE_AXES).length) return false;
  return Object.entries(EVIDENCE_AXES).every(([axis, choices]) => {
    const distribution = evidence[axis];
    if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) return false;
    const scores = distribution as Record<string, unknown>;
    if (Object.keys(scores).length !== 3) return false;
    return [...choices, "insufficient"].every((choice) =>
      typeof scores[choice] === "number" && Number.isFinite(scores[choice]) &&
      (scores[choice] as number) >= 0 && (scores[choice] as number) <= 1,
    ) && [...choices, "insufficient"].reduce((total, choice) => total + (scores[choice] as number), 0) > 0;
  });
}

const STYLE_KEYS = ["socialEnergy", "humor", "composure", "initiative", "care", "affection"] as const;
const EXPRESSION_IDS = new Set(EXPRESSIONS.map((expression) => expression.id));
const SOCIAL_NEED_IDS = new Set(SOCIAL_NEEDS.map((need) => need.id));

function validExpressionScores(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) =>
    entry && typeof entry === "object" && EXPRESSION_IDS.has(entry.label) &&
    typeof entry.probability === "number" && Number.isFinite(entry.probability) &&
    entry.probability >= 0 && entry.probability <= 1));
}

function validPlayfulIntentScores(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.label !== "string" ||
        typeof entry.probability !== "number" || !Number.isFinite(entry.probability) ||
        entry.probability < 0 || entry.probability > 1) return false;
    const [prefix, expressionId, needId, extra] = entry.label.split(":");
    return prefix === "playful" && extra === undefined &&
      EXPRESSION_IDS.has(expressionId) && SOCIAL_NEED_IDS.has(needId);
  }));
}

function validStyleEvidence(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return Object.keys(evidence).length === STYLE_KEYS.length && STYLE_KEYS.every((key) =>
    typeof evidence[key] === "number" && Number.isFinite(evidence[key]) &&
    (evidence[key] as number) >= 0 && (evidence[key] as number) <= 1,
  );
}

async function handleObserve(id: unknown, text: string): Promise<void> {
  const r = await analyzeObservedText(text);
  const e = top(r.emotion);
  const i = top(r.intent);
  if (!e && !i) {
    // The model produced no distribution; do not report a 0% success.
    emit({ id, error: "no-result" });
    return;
  }
  emit({
    id,
    cmd: "observe",
    labelSchema: OBSERVED_LABEL_SCHEMA,
    emotion: r.emotion,
    intent: r.intent,
    expression: r.expression,
    playfulIntent: r.playfulIntent,
    intentBroad: (r.intentBroad ?? []).map((entry) => ({ label: intentLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
    emotionLabel: emotionLabel(e?.label ?? ""),
    intentLabel: intentLabel(i?.label ?? ""),
    emotionP: e?.probability ?? 0,
    intentP: i?.probability ?? 0,
  });
}

async function handleTargets(id: unknown, req: Record<string, unknown>): Promise<void> {
  // Never coerce missing inputs into empty arrays: an empty request must NOT look like a valid
  // "default 50" success. Reject it explicitly.
  if (typeof req.sessionId !== "string" || req.sessionId.length === 0) {
    emit({ id, error: "bad-request:sessionId" });
    return;
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    emit({ id, error: "bad-request:messages" });
    return;
  }
  if (!Array.isArray(req.targetIds) || req.targetIds.length === 0) {
    emit({ id, error: "no-targets" });
    return;
  }
  const messages: WireMessage[] = [];
  const seen = new Set<string>();
  for (const m of req.messages) {
    if (!m || typeof m !== "object") {
      emit({ id, error: "bad-request:message" });
      return;
    }
    const rec = m as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id || seen.has(rec.id) || (rec.side !== "self" && rec.side !== "other") || typeof rec.text !== "string" ||
        (rec.time !== undefined && (typeof rec.time !== "number" || !Number.isFinite(rec.time) || rec.time < 0))) {
      emit({ id, error: "bad-request:message" });
      return;
    }
    messages.push({ id: rec.id, side: rec.side, text: rec.text, time: typeof rec.time === "number" ? rec.time : 0 });
    seen.add(rec.id);
  }
  const targetIds: string[] = [];
  for (const t of req.targetIds) {
    if (typeof t !== "string" || !seen.has(t) || targetIds.includes(t)) {
      emit({ id, error: "bad-request:targetId" });
      return;
    }
    targetIds.push(t);
  }
  const portraitContext = req.portraitContext;
  if (portraitContext !== undefined && (typeof portraitContext !== "string" ||
      targetIds.length !== 1 || messages.find(message => message.id === targetIds[0])?.side !== "other")) {
    emit({ id, error: "bad-request:portraitContext" });
    return;
  }
  const messageLabelsOnly = req.messageLabelsOnly;
  if (messageLabelsOnly !== undefined && typeof messageLabelsOnly !== "boolean") {
    emit({ id, error: "bad-request:messageLabelsOnly" });
    return;
  }
  const sessionId = req.sessionId;
  const previousAffinity =
    typeof req.previousAffinity === "number" && Number.isFinite(req.previousAffinity)
      ? req.previousAffinity
      : undefined;
  if (req.previousAffinity !== undefined && previousAffinity === undefined) {
    emit({ id, error: "bad-request:previousAffinity" });
    return;
  }

  const r = await analyzeMessageTargets({ sessionId, messages, targetIds, previousAffinity,
    portraitContext, messageLabelsOnly });
  const resultVersion = (r as typeof r & { analysisVersion?: unknown }).analysisVersion;
  if (resultVersion !== undefined && resultVersion !== ANALYSIS_VERSION) {
    emit({ id, error: "analysis-version-mismatch" });
    return;
  }
  if (r.messages.length !== targetIds.length || r.messages.some((message) =>
    !message.emotion.length || !message.intent.length ||
    [...message.emotion, ...message.intent].some((entry) => !Number.isFinite(entry.probability)) ||
    !validExpressionScores(message.expression) ||
    !validPlayfulIntentScores(message.playfulIntent) ||
    !validStyleEvidence(message.styleEvidence) ||
    !validPersonalityEvidence((message as typeof message & { personalityEvidence?: unknown }).personalityEvidence ?? null) ||
    (messages.find((item) => item.id === message.messageId)?.side === "other" &&
    (!message.relationship.length || message.relationship.some((entry) => !Number.isFinite(entry.probability)))))) {
    emit({ id, error: "invalid-model-result" });
    return;
  }
  emit({
    id,
    cmd: "targets",
    modelStatus: getModelStatus(),
    durationMs: r.durationMs,
    analysisVersion: ANALYSIS_VERSION,
    messages: r.messages.map((m) => {
      const e = top(m.emotion);
      const i = top(m.intent);
      return {
        messageId: m.messageId,
        ...(messageLabelsOnly ? { labelSchema: GENERAL_LABEL_SCHEMA } : {}),
        ...(messageLabelsOnly ? { groundedIntent: m.groundedIntent ?? null } : {}),
        emotion: m.emotion.map((entry) => ({ label: emotionLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
        intent: m.intent.map((entry) => ({ label: intentLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
        expression: m.expression ?? [],
        playfulIntent: m.playfulIntent ?? [],
        intentBroad: (m.intentBroad ?? []).map((entry) => ({ label: intentLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
        styleEvidence: m.styleEvidence ?? null,
        relationship: m.relationship,
        personalityEvidence: (m as typeof m & { personalityEvidence?: unknown }).personalityEvidence ?? null,
        score: messages.find((item) => item.id === m.messageId)?.side === "other"
          ? messageScore({ relationship: Object.fromEntries(m.relationship.map((item) => [item.label, item.probability])) })
          : null,
        emotionLabel: emotionLabel(e?.label ?? ""),
        intentLabel: intentLabel(i?.label ?? ""),
        emotionP: e?.probability ?? 0,
        intentP: i?.probability ?? 0,
      };
    }),
    affinity: r.affinity,
    affinityGrade: r.affinityGrade,
    relationship: r.relationship,
    delta: r.delta,
    selfQuality: {
      quality: r.selfQuality.quality,
      grade: r.selfQuality.grade,
      score: r.selfQuality.score,
    },
    model: r.model,
  });
}

async function handleBatch(id: unknown, req: Record<string, unknown>): Promise<void> {
  if (typeof req.sessionId !== "string" || !req.sessionId ||
      !Array.isArray(req.messages) || req.messages.length === 0 ||
      (req.context !== undefined && !Array.isArray(req.context))) {
    emit({ id, error: "bad-request:batch" });
    return;
  }
  const r = await analyzeMessageBatch({ sessionId: req.sessionId,
    messages: req.messages as BatchMessage[], context: req.context as BatchContext[] | undefined });
  const m = r.result;
  if (m && (!m.emotion.length || !m.intent.length ||
      [...m.emotion, ...m.intent].some(entry => !Number.isFinite(entry.probability)) ||
      !validExpressionScores(m.expression) || !validPlayfulIntentScores(m.playfulIntent) ||
      !validStyleEvidence(m.styleEvidence) || !validPersonalityEvidence(m.personalityEvidence) ||
      (r.targetSide !== "self" && (!m.relationship.length ||
        m.relationship.some(entry => !Number.isFinite(entry.probability)))) ||
      (m.score !== null && !Number.isFinite(m.score)))) {
    emit({ id, error: "invalid-model-result" });
    return;
  }
  const e = m ? top(m.emotion) : null;
  const i = m ? top(m.intent) : null;
  emit({ id, cmd: "batch", modelStatus: getModelStatus(),
    analysisVersion: ANALYSIS_VERSION, batchVersion: r.batchVersion,
    consumed: r.consumed, contextTrimmed: r.contextTrimmed, targetSide: r.targetSide,
    durationMs: r.durationMs,
    result: m ? {
      analysisVersion: ANALYSIS_VERSION,
      emotion: m.emotion.map(entry => ({ label: emotionLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
      intent: m.intent.map(entry => ({ label: intentLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
      intentBroad: m.intentBroad.map(entry => ({ label: intentLabel(entry.label), rawLabel: entry.label, probability: entry.probability })),
      expression: m.expression, playfulIntent: m.playfulIntent,
      styleEvidence: m.styleEvidence, personalityEvidence: m.personalityEvidence,
      relationship: m.relationship, score: m.score,
      emotionLabel: emotionLabel(e?.label ?? ""), intentLabel: intentLabel(i?.label ?? ""),
      emotionP: e?.probability ?? 0, intentP: i?.probability ?? 0,
    } : null });
}

async function handleForecast(id: unknown, req: Record<string, unknown>): Promise<void> {
  if (typeof req.sessionId !== "string" || !req.sessionId ||
      !Array.isArray(req.messages) || req.messages.length < 1 || req.messages.length > 16 ||
      (req.draft !== undefined && (typeof req.draft !== "string" || req.draft.length > 2000))) {
    emit({ id, error: "bad-request:forecast" });
    return;
  }
  const messages: WireMessage[] = [];
  const seen = new Set<string>();
  for (const raw of req.messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      emit({ id, error: "bad-request:message" });
      return;
    }
    const message = raw as Record<string, unknown>;
    if (typeof message.id !== "string" || !message.id || seen.has(message.id) ||
        (message.side !== "self" && message.side !== "other") ||
        typeof message.text !== "string" || !message.text.trim() || message.text.length > 4000 ||
        (message.time !== undefined && (typeof message.time !== "number" || !Number.isFinite(message.time)))) {
      emit({ id, error: "bad-request:message" });
      return;
    }
    seen.add(message.id);
    messages.push({ id: message.id, side: message.side, text: message.text, time: typeof message.time === "number" ? message.time : 0 });
  }
  const candidates = await forecastNextReply(messages, typeof req.draft === "string" ? req.draft : "");
  emit({ id, cmd: "forecast", modelStatus: getModelStatus(), analysisVersion: ANALYSIS_VERSION, candidates });
}

async function main(): Promise<void> {
  if (process.argv.includes("--analysis-version")) {
    emit({ analysisVersion: ANALYSIS_VERSION });
    return;
  }
  const providerFlag = process.argv.indexOf("--provider");
  const initialProvider = providerFlag < 0 ? "gpu" : process.argv[providerFlag + 1];
  if (initialProvider !== "cpu" && initialProvider !== "gpu") {
    throw new Error("invalid runtime provider");
  }
  configureModelDir(path.resolve(process.cwd(), ".models", "laya"));
  const model = await configureAnalysisRuntime(initialProvider);
  emit({ ready: model.state === "ready", model, analysisVersion: ANALYSIS_VERSION });

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    let req: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        emit({ id: null, error: "bad-request:object" });
        continue;
      }
      req = parsed as Record<string, unknown>;
    } catch {
      emit({ id: null, error: "bad-json" });
      continue;
    }
    const id = req.id;
    const cmd = typeof req.cmd === "string" ? req.cmd : "observe";
    try {
      if (cmd === "configure-runtime") {
        if (req.provider !== "cpu" && req.provider !== "gpu") {
          emit({ id, error: "bad-request:provider" });
          continue;
        }
        emit({ id, cmd, analysisVersion: ANALYSIS_VERSION,
          modelStatus: await configureAnalysisRuntime(req.provider) });
        continue;
      }
      if (cmd === "status") {
        emit({ id, cmd: "status", status: getModelStatus() });
        continue;
      }
      if (cmd === "prepare") {
        emit({ id, cmd: "prepare", model: await prepareModel() });
        continue;
      }
      if (cmd === "targets") {
        const status = getModelStatus();
        if (status.state !== "ready") {
          emit({ id, error: `model-${status.state}` });
          continue;
        }
        await handleTargets(id, req);
        continue;
      }
      if (cmd === "batch") {
        const status = getModelStatus();
        if (status.state !== "ready") {
          emit({ id, error: `model-${status.state}` });
          continue;
        }
        await handleBatch(id, req);
        continue;
      }
      if (cmd === "forecast") {
        const status = getModelStatus();
        if (status.state !== "ready") {
          emit({ id, error: `model-${status.state}` });
          continue;
        }
        await handleForecast(id, req);
        continue;
      }
      const text = typeof req.text === "string" ? req.text : "";
      if (!text.trim()) {
        emit({ id, error: "empty" });
        continue;
      }
      await handleObserve(id, text);
    } catch (error) {
      emit({ id, error: error instanceof MessageBatchInputError ? "bad-request:batch" :
        error instanceof Error ? error.name : "error", modelStatus: getModelStatus() });
    }
  }
  await disposeAnalysisModel();
}

void main().catch((error: unknown) => {
  process.stderr.write(`analysis server failed: ${String(error)}\n`);
  process.exit(1);
});
