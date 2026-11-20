import type { ApiInsight } from './api-message-insights';

/** Emit only complete, explicitly attributed labels in the existing UI wire format. */
export function insightStream(normalize: (value: unknown) => ApiInsight | null,
  emit?: (delta: string) => void) {
  let raw = '';
  let scanned = 0;
  let textBuffer = '';
  let legacyBlock: { id: string; emotion?: string; intent?: string } | null = null;
  let quoted = false;
  let escaped = false;
  const stack: Array<{ char: string; start: number }> = [];
  const emitted = new Map<string, string>();
  function flushLegacy() {
    if (!legacyBlock || legacyBlock.emotion === undefined || legacyBlock.intent === undefined) return;
    accept({ id: legacyBlock.id, emotion: legacyBlock.emotion, intent: legacyBlock.intent });
    legacyBlock = null;
  }
  function acceptLegacyLine(line: string) {
    const marker = /^\s*(?:编号|id)\s*[:：]\s*([^\r\n]+)$/iu.exec(line);
    if (marker) {
      flushLegacy();
      legacyBlock = { id: marker[1]!.trim() };
      return;
    }
    if (!legacyBlock) return;
    const emotion = /^\s*(?:情感|情绪|emotion)\s*[:：]\s*([^\r\n]*)$/iu.exec(line);
    if (emotion) {
      legacyBlock.emotion = emotion[1];
      flushLegacy();
      return;
    }
    const intent = /^\s*(?:意图|intent)\s*[:：]\s*([^\r\n]*)$/iu.exec(line);
    if (intent) {
      legacyBlock.intent = intent[1];
      flushLegacy();
    }
  }
  function publish(insight: ApiInsight) {
    const value = JSON.stringify(insight);
    if (emitted.has(insight.id)) return;
    emitted.set(insight.id, value);
    const emotion = insight.status === 'ok' ? insight.affect?.feeling || insight.affect?.tone || '' : '';
    const intent = insight.status === 'ok' ? insight.intents[0] || '' : '';
    emit?.(`编号：${insight.id}\n情感：${emotion || '无'}\n意图：${intent || '无'}\n`);
  }
  function accept(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const terminal = ['routine', 'uncertain', 'insufficient'].includes(String(record.status));
    const pair = ((record.emotion !== undefined || record.emotionLabel !== undefined) &&
      (record.intent !== undefined || record.intentLabel !== undefined)) ||
      (record.affect !== undefined && record.intents !== undefined);
    if (!terminal && !pair) return;
    try { const insight = normalize(value); if (insight) publish(insight); }
    catch { /* Partial/malformed/unknown records stay pending. */ }
  }
  return {
    push(delta: string) {
      if (!emit || typeof delta !== 'string') return;
      raw += delta;
      // Completed leaf objects can arrive before the surrounding JSON array ends.
      for (; scanned < raw.length; scanned++) {
        const c = raw[scanned]!;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
          continue;
        }
        if (stack.length && c === '"') { quoted = true; continue; }
        if (c === '{' || c === '[') stack.push({ char: c, start: scanned });
        else if (c === '}' || c === ']') {
          const open = stack.pop();
          if (!open || (open.char === '{') !== (c === '}')) { stack.length = 0; continue; }
          if (c === '}') {
            try { accept(JSON.parse(raw.slice(open.start, scanned + 1))); } catch { /* malformed object */ }
          }
        }
      }
      // Legacy text: consume complete lines only, so partial ID/field lines stay
      // pending without rescanning the whole transcript on every delta.
      textBuffer += delta;
      let newline = textBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = textBuffer.slice(0, newline).replace(/\r$/, '');
        textBuffer = textBuffer.slice(newline + 1);
        if (line.trim()) acceptLegacyLine(line);
        newline = textBuffer.indexOf('\n');
      }
      // Drop the already-scanned JSON prefix when no object spans it, so `raw`
      // cannot grow for the whole response.
      if (stack.length === 0 && scanned > 8192) {
        raw = raw.slice(scanned);
        scanned = 0;
      }
    },
    finish(values: Iterable<ApiInsight>) { if (emit) for (const value of values) publish(value); },
  };
}
