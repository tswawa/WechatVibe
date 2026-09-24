import catalog from "../../chatui/data/analysis-catalog.json";

const keyOf = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "_");
const emotions = catalog.emotions as Array<{ id: string; label: string; modelLabel: string; aliases?: string[] }>;
const legacyIntentLabels = (catalog as typeof catalog & { legacyIntentLabels?: Record<string, string> }).legacyIntentLabels ?? {};

export const EMOTION_LABELS: Record<string, string> = {
  ...Object.fromEntries(emotions.flatMap(({ label, aliases }) =>
    (aliases ?? []).map((alias) => [keyOf(alias), label]))),
  ...Object.fromEntries(emotions.flatMap(({ id, label, modelLabel }) =>
    [[keyOf(id), label], [keyOf(modelLabel), label], [keyOf(label), label]])),
};

export const INTENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(legacyIntentLabels).map(([alias, display]) => [keyOf(alias), display])),
  ...Object.fromEntries(catalog.intents.flatMap(({ id, label, displayLabel, modelLabel }) =>
    [[keyOf(id), displayLabel], [keyOf(modelLabel), displayLabel], [keyOf(label), displayLabel], [keyOf(displayLabel), displayLabel]])),
  small_talk: "闲聊",
  smalltalk: "闲聊",
  share_news: "分享",
  ask_question: "提问",
  seek_comfort: "求安慰",
  give_comfort: "安慰",
  make_plan: "计划",
  flirt: "暧昧",
  complain: "吐槽",
  apologize: "道歉",
  joke: "玩笑",
  reject: "拒绝",
  distance: "疏远",
};

export function emotionLabel(label: string): string {
  if (!label) return "";
  const key = keyOf(label);
  return EMOTION_LABELS[key] ?? EMOTION_LABELS[label] ?? label;
}

export function intentLabel(label: string): string {
  if (!label) return "";
  const key = keyOf(label);
  return INTENT_LABELS[key] ?? INTENT_LABELS[label] ?? label;
}

/** Convert a model probability (0..1) to a display percentage. Never invents a value. */
export function formatPercent(probability: number): string {
  if (!Number.isFinite(probability)) return "—";
  const clamped = Math.max(0, Math.min(1, probability));
  if (clamped > 0 && clamped < 0.005) return "<1%";
  return `${Math.round(clamped * 100)}%`;
}

export function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "±0";
  return `${delta > 0 ? "+" : ""}${Math.round(delta)}`;
}

/** Human label for the analysis engine. Demo data is never presented as a Laya result. */
export function modelLabel(model: string, demo: boolean): string {
  if (demo) return "示例数据";
  if (!model) return "Laya · 本地";
  return /laya/i.test(model) ? "Laya · 本地" : model;
}
