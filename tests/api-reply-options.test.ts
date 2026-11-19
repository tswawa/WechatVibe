import assert from "node:assert/strict";
import { it } from "node:test";
import { generateReplyOptions, REPLY_OPTIONS_VERSION,
  type ReplyOptionsInput } from "../electron/api-reply-options";
import { ModelConnectorError, type ModelConfig, type Protocol } from "../electron/model-connectors";

const config: ModelConfig = { protocol: "responses", baseUrl: "https://example.invalid/v1",
  apiKey: "synthetic-never-sent", model: "synthetic" };
const input: ReplyOptionsInput = {
  assistant: { prompt: "给出自然、克制的回复。", skills: [] },
  messages: [{ id: "real-message-self", sender: "SELF", text: "好呀 我看看安排" },
    { id: "real-message-other", sender: "OTHER", text: "周六一起去吗？", speaker: "P1", speakerName: "小陈" }],
  contextTokens: 4096,
};
const replies = [{ text: "几点集合呀？" }, { text: "我先看看周六的安排，晚点跟你说。" }, { text: "这次先不去了，下次约。" }];

async function withSdkWire<T>(handler: (body: Record<string, any>) => unknown,
  task: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (_request, init) => new Response(JSON.stringify(
    handler(JSON.parse(String(init?.body)))), { status: 200, headers: { "content-type": "application/json" } });
  try { return await task(); } finally { globalThis.fetch = original; }
}

function sdkReply(protocol: Protocol, truncated = false): unknown {
  const text = JSON.stringify({ replies });
  switch (protocol) {
    case "responses": return { id: "synthetic-response", object: "response", model: "synthetic",
      status: truncated ? "incomplete" : "completed",
      ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] };
    case "chat_completions": return { id: "synthetic-completion", object: "chat.completion", model: "synthetic",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: truncated ? "length" : "stop" }] };
    case "anthropic": return { id: "synthetic-message", type: "message", role: "assistant", model: "synthetic",
      content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 20 },
      stop_reason: truncated ? "max_tokens" : "end_turn", stop_sequence: null };
    case "gemini": return { candidates: [{ content: { role: "model", parts: [{ text }] },
      finishReason: truncated ? "MAX_TOKENS" : "STOP" }] };
    case "ollama": return { model: "synthetic", done: true, message: { role: "assistant", content: text },
      done_reason: truncated ? "length" : "stop" };
  }
}

const sdkConfig = (protocol: Protocol): ModelConfig => ({ ...config, protocol,
  baseUrl: protocol === "ollama" ? "http://127.0.0.1:11434" :
    protocol === "gemini" ? "https://example.invalid/v1beta" : "https://example.invalid/v1" });

function outputCaps(body: Record<string, any>): number[] {
  const fields = new Set(["max_output_tokens", "max_tokens", "maxOutputTokens", "num_predict"]);
  const caps: number[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (fields.has(key)) caps.push(entry as number);
      visit(entry);
    }
  };
  visit(body);
  return caps;
}

it("generates exactly three standalone replies with SELF voice in a small window and one provider turn", async () => {
  let calls = 0;
  const result = await generateReplyOptions(config, input, async (_, request) => {
    calls++;
    const payload = JSON.parse(request.prompt.split("INPUT_JSON:\n")[1]!);
    assert.deepEqual(payload.selfVoiceMessageIds, ["r1"]);
    assert.deepEqual(payload.messages.map((message: { text: string }) => message.text),
      input.messages.map((message) => message.text));
    assert.equal(payload.messages[1].speaker, "P1");
    assert.equal(payload.messages[1].speakerName, "小陈");
    assert.ok(!request.prompt.includes("real-message"));
    assert.deepEqual(Object.keys(payload).sort(), ["messages", "selfVoiceMessageIds"]);
    assert.equal(request.maxOutputTokens, undefined);
    assert.ok(Buffer.byteLength(request.system, "utf8") + Buffer.byteLength(request.prompt, "utf8") +
      768 + 128 <= input.contextTokens);
    return { text: JSON.stringify({ replies }), usage: { inputTokens: 20, outputTokens: 10 } };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: "reply-options", version: REPLY_OPTIONS_VERSION,
    replies, usage: { inputTokens: 20, outputTokens: 10 } });
});

it("keeps complete recent messages and latest SELF while shrinking old context to the configured budget", async () => {
  const messages: ReplyOptionsInput["messages"] = Array.from({ length: 10 }, (_, index) => ({
    id: `old-${index}`, sender: index % 2 ? "SELF" : "OTHER", text: `完整旧消息${"例".repeat(500)}`,
  }));
  messages.push(...input.messages);
  await generateReplyOptions(config, { ...input, messages, contextTokens: 4096 }, async (_, request) => {
    const payload = JSON.parse(request.prompt.split("INPUT_JSON:\n")[1]!);
    assert.ok(payload.messages.length < messages.length);
    assert.deepEqual(payload.messages.slice(-2).map((message: { text: string }) => message.text),
      input.messages.map((message) => message.text));
    for (const message of payload.messages) {
      assert.equal(message.text, messages[Number(message.id.slice(1)) - 1]!.text);
    }
    return { text: JSON.stringify({ replies }) };
  });
});

it("rejects incomplete, duplicate, oversized or analysis-bearing replies without manufacturing options", async () => {
  for (const payload of [
    { replies: replies.slice(0, 2) }, { replies: [...replies, { text: "第四条" }] },
    { replies: [replies[0], replies[0], replies[2]] },
    { replies: [{ text: " " }, ...replies.slice(1)] },
    { replies: [{ text: "例".repeat(91) }, ...replies.slice(1)] },
    { replies: [{ text: "第一行\u0001第二行" }, ...replies.slice(1)] },
    { replies: [{ text: "好", tone: "温柔" }, ...replies.slice(1)] },
    { replies, subtexts: [] }, { replies, reading: "额外分析" },
  ]) {
    await assert.rejects(() => generateReplyOptions(config, input,
      async () => ({ text: JSON.stringify(payload) })),
    (error: unknown) => error instanceof ModelConnectorError && error.code === "invalid-output");
  }
});

it("preserves newlines and blank lines in generated replies", async () => {
  const multiline = "第一行\n\n第三行\n  缩进";
  const result = await generateReplyOptions(config, input, async () => ({
    text: JSON.stringify({ replies: [{ text: multiline }, replies[1], replies[2]] }),
  }));
  assert.equal(result.replies[0].text, multiline);
});

it("rejects oversized latest context and no readable OTHER before the provider", async () => {
  for (const messages of [
    [{ id: "self", sender: "SELF" as const, text: "只有自己" }],
    [{ id: "other", sender: "OTHER" as const, text: "例".repeat(2000) }],
  ]) {
    let calls = 0;
    await assert.rejects(() => generateReplyOptions(config, { ...input, messages, contextTokens: 4096 }, async () => {
      calls++;
      return { text: JSON.stringify({ replies }) };
    }));
    assert.equal(calls, 0);
  }
});

it("passes the selected assistant prompt and complete Skills through the actual SDK", async () => {
  for (const assistant of [
    { prompt: "克制直接，用短句确认。", skills: [{ id: "direct", content: "先确认具体时间，再讨论安排。" }] },
    { prompt: "轻松俏皮，按狗头军师的思路回复。", skills: [
      { id: "advisor", content: "每轮必须 read 会话；先给对方台阶，再提出建议。\n<skill-reference>有分歧时先确认目标。</skill-reference>" },
    ] },
  ]) {
    let calls = 0;
    await withSdkWire((body) => {
      calls++;
      const system = body.instructions;
      const settings = JSON.parse(system.split("ASSISTANT_SETTINGS_JSON:\n")[1].split("\n")[0]);
      assert.deepEqual(settings, assistant);
      assert.match(system, /会话已由宿主在 INPUT_JSON 中提供/);
      assert.match(system, /工具前置要求不适用于本轮/);
      assert.match(system, /恰好三个/);
      assert.equal(body.tools, undefined);
      return sdkReply("responses");
    }, () => generateReplyOptions(config, { ...input, assistant, contextTokens: 8192 }));
    assert.equal(calls, 1);
  }
});

it("rejects missing or malformed assistant settings before calling the model", async () => {
  for (const assistant of [undefined, null, { prompt: "", skills: [] },
    { prompt: "有效", skills: [{ id: "same", content: "一" }, { id: "same", content: "二" }] },
    { prompt: "有效", skills: [{ id: "too-long", content: "例".repeat(24001) }] }]) {
    let calls = 0;
    await assert.rejects(() => generateReplyOptions(config,
      { ...input, assistant } as ReplyOptionsInput, async () => { calls++; return { text: JSON.stringify({ replies }) }; }),
    (error: unknown) => error instanceof ModelConnectorError && error.code === "invalid-request");
    assert.equal(calls, 0);
  }
});

it("accounts for assistant and Skill text in the full context budget without dropping settings", async () => {
  let calls = 0;
  await assert.rejects(() => generateReplyOptions(config, { ...input,
    assistant: { prompt: "保持助手设定", skills: [{ id: "large", content: "例".repeat(2000) }] },
  }, async () => { calls++; return { text: JSON.stringify({ replies }) }; }),
  (error: unknown) => error instanceof ModelConnectorError && error.code === "context-too-long");
  assert.equal(calls, 0);
});

it("sends no hard output cap through the real SDK for non-Anthropic protocols", async () => {
  for (const protocol of ["responses", "chat_completions", "gemini", "ollama"] as const) {
    let calls = 0;
    const result = await withSdkWire((body) => {
      calls++;
      assert.deepEqual(outputCaps(body), [], protocol);
      return sdkReply(protocol);
    }, () => generateReplyOptions(sdkConfig(protocol), input));
    assert.equal(calls, 1, protocol);
    assert.equal(result.replies.length, 3);
  }
});

it("keeps the existing official DeepSeek Responses reasoning setting without adding a hard cap", async () => {
  await withSdkWire((body) => {
    assert.deepEqual(outputCaps(body), []);
    assert.equal(body.reasoning.effort, "none");
    return sdkReply("responses");
  }, () => generateReplyOptions({ ...config, baseUrl: "https://api.deepseek.com/v1" }, input));
});

it("gives Anthropic an explicit cap sized to actual remaining context and keeps 4K usable", async () => {
  let smallCap = 0;
  for (const contextTokens of [4096, 32768]) {
    let calls = 0;
    await withSdkWire((body) => {
      calls++;
      const caps = outputCaps(body);
      assert.equal(caps.length, 1);
      const cap = caps[0]!;
      assert.ok(cap >= 768 && cap <= 32768);
      assert.ok(Buffer.byteLength(body.system, "utf8") +
        Buffer.byteLength(body.messages[0].content, "utf8") + cap + 128 <= contextTokens);
      if (contextTokens === 4096) smallCap = cap;
      else assert.ok(cap > smallCap && cap >= 16384, "larger windows leave room for reasoning");
      return sdkReply("anthropic");
    }, () => generateReplyOptions(sdkConfig("anthropic"), { ...input, contextTokens }));
    assert.equal(calls, 1);
  }
});

it("reports provider truncation through the real SDK even when returned text looks like valid reply JSON", async () => {
  for (const protocol of ["responses", "chat_completions", "anthropic", "gemini", "ollama"] as const) {
    let calls = 0;
    await withSdkWire(() => {
      calls++;
      return sdkReply(protocol, true);
    }, async () => {
      await assert.rejects(() => generateReplyOptions(sdkConfig(protocol), input),
        (error: unknown) => error instanceof ModelConnectorError && error.code === "output-truncated");
    });
    assert.equal(calls, 1, `${protocol} must not make a second request`);
  }
});
