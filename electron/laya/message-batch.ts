/** Pack consecutive messages into one model state without dropping target text. */

export const MESSAGE_BATCH_VERSION = "message-batch-v1";

export interface BatchMessage {
  id: string;
  text: string;
  side: "self" | "other";
  target: boolean;
  /** Unicode codepoint offset of the first codepoint not yet consumed. */
  offset?: number;
}

export interface BatchContext {
  side: "self" | "other";
  text: string;
}

export interface MessageBatchRequest {
  sessionId: string;
  messages: readonly BatchMessage[];
  context?: readonly BatchContext[];
}

export interface BatchConsumed {
  id: string;
  /** Inclusive Unicode codepoint offset. */
  start: number;
  /** Exclusive Unicode codepoint offset. */
  end: number;
  complete: boolean;
}

interface Segment {
  side: BatchMessage["side"];
  target: boolean;
  start: number;
  text: string;
}

export interface PackedMessageBatch {
  state: string;
  targetText: string;
  targetSide: "self" | "other" | "mixed" | null;
  consumed: BatchConsumed[];
  contextTrimmed: boolean;
  stateTokens: number;
}

export class MessageBatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageBatchInputError";
  }
}

function validSide(side: unknown): side is "self" | "other" {
  return side === "self" || side === "other";
}

function renderState(context: readonly BatchContext[], segments: readonly Segment[]): string {
  const lines = [
    "TARGET message to judge: the complete ordered set of TARGET records below, treated as ONE combined message batch.",
    "BACKGROUND records provide context only. Judge the TARGET batch as a whole; do not assign separate labels to its records.",
  ];
  if (context.length) {
    lines.push("Earlier background context:");
    for (const message of context) {
      lines.push(JSON.stringify({ role: "BACKGROUND", speaker: message.side, text: message.text }));
    }
  }
  lines.push("Ordered message batch:");
  for (const segment of segments) {
    lines.push(JSON.stringify({ role: segment.target ? "TARGET" : "BACKGROUND",
      speaker: segment.side, continuation: segment.start > 0, text: segment.text }));
  }
  return lines.join("\n");
}

/**
 * Return only a contiguous prefix of request.messages. A partial final message is exposed
 * through codepoint offsets so the caller can resume it exactly on the next request.
 */
export function packMessageBatch(
  request: MessageBatchRequest,
  countTokens: (state: string) => number,
  maxStateTokens: number,
): PackedMessageBatch {
  if (!request || typeof request.sessionId !== "string" || !request.sessionId ||
      !Array.isArray(request.messages) || request.messages.length === 0 ||
      !Array.isArray(request.context ?? []) || !Number.isInteger(maxStateTokens) || maxStateTokens < 1) {
    throw new MessageBatchInputError("invalid batch request");
  }
  const originalContext = request.context ?? [];
  if (originalContext.some(message => !message || !validSide(message.side) || typeof message.text !== "string")) {
    throw new MessageBatchInputError("invalid batch context");
  }
  const seen = new Set<string>();
  const normalized = request.messages.map(message => {
    if (!message || typeof message.id !== "string" || !message.id || seen.has(message.id) ||
        typeof message.text !== "string" || !validSide(message.side) || typeof message.target !== "boolean") {
      throw new MessageBatchInputError("invalid or duplicate batch message");
    }
    seen.add(message.id);
    const codepoints = Array.from(message.text);
    const offset = message.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > codepoints.length ||
        (codepoints.length > 0 && offset === codepoints.length)) {
      throw new MessageBatchInputError("invalid codepoint offset");
    }
    return { message, codepoints, offset };
  });
  const checkedCount = (state: string) => {
    const count = countTokens(state);
    if (!Number.isInteger(count) || count < 0) throw new MessageBatchInputError("invalid tokenizer count");
    return count;
  };
  const packWithContext = (context: readonly BatchContext[], contextTrimmed: boolean): PackedMessageBatch | null => {
    const segments: Segment[] = [];
    const consumed: BatchConsumed[] = [];
    if (checkedCount(renderState(context, segments)) > maxStateTokens) return null;
    for (const { message, codepoints, offset } of normalized) {
      const remaining = codepoints.slice(offset);
      const fits = (count: number) => checkedCount(renderState(context, [...segments,
        { side: message.side, target: message.target, start: offset, text: remaining.slice(0, count).join("") }])) <= maxStateTokens;
      let count = remaining.length;
      if (!fits(count)) {
        // Search only within this next message: no later message may leapfrog a partial one.
        let low = 0;
        let high = count;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(mid)) low = mid;
          else high = mid - 1;
        }
        count = low;
        // BPE merges can make a nearby longer prefix fit; use the remaining local room.
        for (let next = low + 1; next <= Math.min(remaining.length, low + 32); next++) {
          if (fits(next)) count = next;
        }
        if (count === 0) {
          if (segments.length) break;
          return null;
        }
      }
      const text = remaining.slice(0, count).join("");
      segments.push({ side: message.side, target: message.target, start: offset, text });
      consumed.push({ id: message.id, start: offset, end: offset + count,
        complete: offset + count === codepoints.length });
      if (count < remaining.length) break;
    }
    if (consumed.length === 0) return null;
    const targetSegments = segments.filter(segment => segment.target && segment.text.trim());
    const sides = new Set(targetSegments.map(segment => segment.side));
    const targetSide = sides.size === 0 ? null : sides.size > 1 ? "mixed" : [...sides][0]!;
    const state = renderState(context, segments);
    return { state, targetText: targetSegments.map(segment => segment.text).join("\n"),
      targetSide, consumed, contextTrimmed, stateTokens: checkedCount(state) };
  };
  let best: PackedMessageBatch | null = null;
  // Old context is disposable background. Drop the oldest records only when needed to fit more
  // new message content; report that choice instead of silently pretending they were present.
  for (let dropped = 0; dropped <= originalContext.length; dropped++) {
    const candidate = packWithContext(originalContext.slice(dropped), dropped > 0);
    if (!candidate) continue;
    best = candidate;
    if (candidate.consumed.length === normalized.length && candidate.consumed.at(-1)!.complete) {
      return candidate;
    }
  }
  if (!best) throw new MessageBatchInputError("batch has no room for one message codepoint");
  return best;
}

/** Exactly one aggregate classifier call for a packed target batch, none for context-only work. */
export async function classifyPackedBatch<T>(
  request: MessageBatchRequest,
  countTokens: (state: string) => number,
  maxStateTokens: number,
  classifyOnce: (batch: PackedMessageBatch) => Promise<T>,
): Promise<{ packed: PackedMessageBatch; result: T | null }> {
  const packed = packMessageBatch(request, countTokens, maxStateTokens);
  return { packed, result: packed.targetSide === null ? null : await classifyOnce(packed) };
}
