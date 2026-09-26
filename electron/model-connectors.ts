// Network model adapters. The local Laya engine remains the application's default.
// Provider SDKs own their wire formats; this file owns validation and the network boundary.

export type Protocol = "anthropic" | "responses" | "chat_completions" | "gemini" | "ollama";

export interface ModelConfig {
  protocol: Protocol;
  /** Complete API prefix: e.g. /v1, /v1beta, or the Ollama server root. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextTokens?: number;
}

export interface ListedModel {
  id: string;
  name?: string;
  contextTokens?: number;
}

export interface ModelListResult {
  models: ListedModel[];
  /** False means the gateway cannot enumerate models; a manually entered ID can still work. */
  supported: boolean;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerationRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface GenerationResult {
  /** Provider text, without parsing or assigning application scores. */
  text: string;
  usage?: ModelUsage;
}

export type ConnectorErrorCode =
  | "invalid-url" | "invalid-request" | "cancelled" | "timeout"
  | "response-too-large" | "context-too-long" | "auth" | "rate-limit" | "unsupported"
  | "provider-error" | "invalid-output" | "network" | "empty-response";

export class ModelConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelConnectorError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 3 * 1024 * 1024;
const MAX_MODELS = 200;
const NO_KEY = "local-no-key";
const PROTOCOLS: readonly Protocol[] = [
  "anthropic", "responses", "chat_completions", "gemini", "ollama",
];

interface SafeConfig {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function invalid(message: string, code: ConnectorErrorCode = "invalid-request"): never {
  throw new ModelConnectorError(code, message);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Validates a user-supplied endpoint before any SDK can send a request. */
export function validateModelConfig(config: ModelConfig, requireModel = true): SafeConfig {
  if (!config || !PROTOCOLS.includes(config.protocol)) invalid("不支持的模型接入协议");
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim() ||
      config.baseUrl.length > 2048 || /[\s\\]/u.test(config.baseUrl)) {
    invalid("Base URL 格式不正确", "invalid-url");
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    invalid("Base URL 格式不正确", "invalid-url");
  }
  if (!url! || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    invalid("Base URL 只能包含 HTTP(S) 地址和路径", "invalid-url");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    invalid("远程服务请使用 HTTPS", "invalid-url");
  }
  if (typeof config.model !== "string" || (requireModel && !config.model.trim()) ||
      config.model.length > 256 || /[\u0000-\u001f\u007f]/u.test(config.model)) {
    invalid("模型 ID 格式不正确");
  }
  if (config.apiKey !== undefined && (typeof config.apiKey !== "string" ||
      config.apiKey.length > 8192 || /[\r\n]/u.test(config.apiKey))) {
    invalid("API Key 格式不正确");
  }
  if (config.contextTokens !== undefined &&
      (!Number.isSafeInteger(config.contextTokens) || config.contextTokens < 4096 ||
       config.contextTokens > 1000000)) invalid("上下文大小格式不正确");
  return {
    protocol: config.protocol,
    baseUrl: url.toString().replace(/\/+$/u, ""),
    model: config.model.trim(),
    apiKey: config.apiKey?.trim() ?? "",
  };
}

function checkedSignal(requestSignal?: AbortSignal, callerSignal?: AbortSignal,
                       timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (requestSignal) signals.push(requestSignal);
  if (callerSignal) signals.push(callerSignal);
  return AbortSignal.any(signals);
}

async function boundedResponse(response: Response): Promise<Response> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ModelConnectorError("response-too-large", "服务响应超过大小限制");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelConnectorError("response-too-large", "服务响应超过大小限制");
      }
      chunks.push(value);
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const body = chunks.length && ![204, 205, 304].includes(response.status)
    ? Buffer.concat(chunks) : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function guardedFetch(config: SafeConfig, callerSignal?: AbortSignal,
                      timeoutMs = REQUEST_TIMEOUT_MS): typeof fetch {
  const base = new URL(config.baseUrl);
  const basePath = base.pathname.replace(/\/+$/u, "");
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== base.origin ||
        (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))) {
      throw new ModelConnectorError("invalid-url", "SDK 请求超出了配置的服务地址");
    }
    const signal = checkedSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined),
      callerSignal, timeoutMs);
    const response = await globalThis.fetch(input, { ...init, redirect: "error", signal });
    return boundedResponse(response);
  };
}

// Anthropic's SDK owns the /v1 path; most compatible-provider UIs expose the full /v1 URL.
function anthropicSdkBase(config: SafeConfig): string {
  return config.baseUrl.replace(/\/v1$/u, "");
}

// Ollama's SDK owns the /api path.
function ollamaSdkBase(config: SafeConfig): string {
  return config.baseUrl.replace(/\/api$/u, "");
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const status = value.status ?? value.statusCode ?? value.status_code;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function safeError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw new ModelConnectorError("cancelled", "请求已取消");
  let current: unknown = error;
  let status: number | undefined;
  let timedOut = false;
  let contextRejected = false;
  // SDKs may wrap fetch failures. Only inspect their shape, never render raw messages.
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if (current instanceof ModelConnectorError) throw current;
    status ??= errorStatus(current);
    if (current instanceof Error && /Timeout|Abort/u.test(current.name)) timedOut = true;
    const record = current as Record<string, unknown>;
    const nested = record.error && typeof record.error === "object" ?
      record.error as Record<string, unknown> : null;
    const code = record.code ?? nested?.code;
    if (typeof code === "string" &&
        /^(?:context[_-]?length[_-]?exceeded|prompt[_-]?too[_-]?long|input[_-]?too[_-]?long|max[_-]?context[_-]?length[_-]?exceeded)$/iu.test(code))
      contextRejected = true;
    current = (current as { cause?: unknown }).cause;
  }
  if (status === 413 || contextRejected && [400, 413, 422].includes(status ?? -1))
    throw new ModelConnectorError("context-too-long", "模型拒绝了当前上下文长度", status);
  if (status === 401) throw new ModelConnectorError("auth", "API Key 无效或已过期", status);
  if (status === 403) throw new ModelConnectorError("auth", "服务拒绝访问", status);
  if (status === 429) throw new ModelConnectorError("rate-limit", "服务请求过于频繁", status);
  if ([404, 405, 501].includes(status ?? -1)) {
    throw new ModelConnectorError("unsupported", "服务不支持此接口", status);
  }
  if (status) throw new ModelConnectorError("provider-error", `服务返回 HTTP ${status}`, status);
  if (timedOut) throw new ModelConnectorError("timeout", "连接服务超时");
  throw new ModelConnectorError("network", "无法连接模型服务");
}

function normalizedModels(models: Array<{ id: string; name?: string; contextTokens?: number }>): ListedModel[] {
  const seen = new Set<string>();
  const result: ListedModel[] = [];
  for (const item of models) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 256) : "";
    const contextTokens = Number.isSafeInteger(item.contextTokens) &&
      item.contextTokens! >= 4096 && item.contextTokens! <= 1000000 ? item.contextTokens : undefined;
    result.push({ id, ...(name && name !== id ? { name } : {}),
      ...(contextTokens ? { contextTokens } : {}) });
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function modelContextTokens(item: unknown): number | undefined {
  if (!item || typeof item !== "object") return undefined;
  const model = item as Record<string, unknown>;
  for (const value of [model.context_window, model.context_length, model.max_context_tokens,
    model.max_context_length, model.input_token_limit, model.inputTokenLimit]) {
    if (Number.isSafeInteger(value) && (value as number) >= 4096 &&
        (value as number) <= 1000000) return value as number;
  }
  return undefined;
}

/** Lists the first bounded page. Gateways without a list endpoint can use a manual model ID. */
export async function listModels(config: ModelConfig): Promise<ModelListResult> {
  const safe = validateModelConfig(config, false);
  try {
    let models: ListedModel[];
    switch (safe.protocol) {
      case "responses":
      case "chat_completions": {
        const { default: OpenAI } = await import("openai");
        const client = new OpenAI({ apiKey: safe.apiKey || NO_KEY, baseURL: safe.baseUrl,
          organization: null, project: null, adminAPIKey: null,
          fetch: guardedFetch(safe, undefined, LIST_TIMEOUT_MS), maxRetries: 0,
          timeout: LIST_TIMEOUT_MS, logLevel: "off" });
        const page = await client.models.list();
        models = normalizedModels(page.data.map((item) => ({ id: item.id,
          contextTokens: modelContextTokens(item) })));
        break;
      }
      case "anthropic": {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: safe.apiKey || NO_KEY, authToken: null,
          credentials: null, config: null, profile: null, baseURL: anthropicSdkBase(safe),
          fetch: guardedFetch(safe, undefined, LIST_TIMEOUT_MS), maxRetries: 0,
          timeout: LIST_TIMEOUT_MS, logLevel: "off" });
        const page = await client.models.list({ limit: 100 });
        models = normalizedModels(page.data.map((item) => ({ id: item.id, name: item.display_name,
          contextTokens: modelContextTokens(item) })));
        break;
      }
      case "gemini": {
        const { GoogleGenAI } = await import("@google/genai");
        const client = new GoogleGenAI({ apiKey: safe.apiKey || NO_KEY, vertexai: false,
          httpOptions: { baseUrl: safe.baseUrl, apiVersion: "", timeout: LIST_TIMEOUT_MS,
            fetch: guardedFetch(safe, undefined, LIST_TIMEOUT_MS) } });
        const page = await client.models.list({ config: { pageSize: 100 } });
        models = normalizedModels(page.page.map((item) => ({
          id: item.name?.replace(/^models\//u, "") ?? "", name: item.displayName,
          contextTokens: modelContextTokens(item),
        })));
        break;
      }
      case "ollama": {
        const { Ollama } = await import("ollama");
        const client = new Ollama({ host: ollamaSdkBase(safe),
          fetch: guardedFetch(safe, undefined, LIST_TIMEOUT_MS),
          headers: safe.apiKey ? { Authorization: `Bearer ${safe.apiKey}` } : undefined });
        const page = await client.list();
        models = normalizedModels(page.models.map((item) => ({ id: item.model || item.name,
          contextTokens: modelContextTokens(item) })));
        break;
      }
    }
    return { models, supported: true };
  } catch (error) {
    // A proxy can support generation while denying or omitting its models endpoint.
    if ([404, 405, 501].includes(errorStatus(error) ?? -1)) {
      return { models: [], supported: false };
    }
    return safeError(error);
  }
}

function usage(input?: number, output?: number): ModelUsage | undefined {
  const inputTokens = Number.isFinite(input) && input! >= 0 ? input : undefined;
  const outputTokens = Number.isFinite(output) && output! >= 0 ? output : undefined;
  return inputTokens === undefined && outputTokens === undefined
    ? undefined : { inputTokens, outputTokens };
}

/** Sends a bounded prompt and returns raw model text for the caller to validate. */
export async function generateStructured(
  config: ModelConfig, request: GenerationRequest,
): Promise<GenerationResult> {
  const safe = validateModelConfig(config);
  if (!request || typeof request.system !== "string" || typeof request.prompt !== "string" ||
      !request.prompt.trim() || !Number.isInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 || request.maxOutputTokens > 8192 ||
      Buffer.byteLength(request.system, "utf8") + Buffer.byteLength(request.prompt, "utf8") > MAX_PROMPT_BYTES) {
    invalid("生成请求超出允许范围");
  }
  if (request.signal?.aborted) throw new ModelConnectorError("cancelled", "请求已取消");
  try {
    let result: GenerationResult;
    switch (safe.protocol) {
      case "responses": {
        const { default: OpenAI } = await import("openai");
        const client = new OpenAI({ apiKey: safe.apiKey || NO_KEY, baseURL: safe.baseUrl,
          organization: null, project: null, adminAPIKey: null,
          fetch: guardedFetch(safe, request.signal), maxRetries: 0,
          timeout: REQUEST_TIMEOUT_MS, logLevel: "off" });
        const response = await client.responses.create({ model: safe.model, input: request.prompt,
          instructions: request.system, max_output_tokens: request.maxOutputTokens, store: false },
        { signal: request.signal });
        result = { text: response.output_text || "",
          usage: usage(response.usage?.input_tokens, response.usage?.output_tokens) };
        break;
      }
      case "chat_completions": {
        const { default: OpenAI } = await import("openai");
        const client = new OpenAI({ apiKey: safe.apiKey || NO_KEY, baseURL: safe.baseUrl,
          organization: null, project: null, adminAPIKey: null,
          fetch: guardedFetch(safe, request.signal), maxRetries: 0,
          timeout: REQUEST_TIMEOUT_MS, logLevel: "off" });
        const response = await client.chat.completions.create({ model: safe.model,
          messages: [{ role: "system", content: request.system },
            { role: "user", content: request.prompt }],
          max_tokens: request.maxOutputTokens }, { signal: request.signal });
        result = { text: response.choices[0]?.message.content ?? "",
          usage: usage(response.usage?.prompt_tokens, response.usage?.completion_tokens) };
        break;
      }
      case "anthropic": {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: safe.apiKey || NO_KEY, authToken: null,
          credentials: null, config: null, profile: null, baseURL: anthropicSdkBase(safe),
          fetch: guardedFetch(safe, request.signal), maxRetries: 0,
          timeout: REQUEST_TIMEOUT_MS, logLevel: "off" });
        const response = await client.messages.create({ model: safe.model,
          system: request.system, max_tokens: request.maxOutputTokens,
          messages: [{ role: "user", content: request.prompt }] }, { signal: request.signal });
        result = { text: response.content.filter((item) => item.type === "text")
          .map((item) => item.text).join("\n"),
          usage: usage(response.usage.input_tokens, response.usage.output_tokens) };
        break;
      }
      case "gemini": {
        const { GoogleGenAI } = await import("@google/genai");
        const client = new GoogleGenAI({ apiKey: safe.apiKey || NO_KEY, vertexai: false,
          httpOptions: { baseUrl: safe.baseUrl, apiVersion: "", timeout: REQUEST_TIMEOUT_MS,
            fetch: guardedFetch(safe, request.signal) } });
        const response = await client.models.generateContent({ model: safe.model,
          contents: request.prompt, config: { systemInstruction: request.system,
            maxOutputTokens: request.maxOutputTokens, abortSignal: request.signal } });
        result = { text: response.text ?? "",
          usage: usage(response.usageMetadata?.promptTokenCount,
            response.usageMetadata?.candidatesTokenCount) };
        break;
      }
      case "ollama": {
        const { Ollama } = await import("ollama");
        const client = new Ollama({ host: ollamaSdkBase(safe),
          fetch: guardedFetch(safe, request.signal),
          headers: safe.apiKey ? { Authorization: `Bearer ${safe.apiKey}` } : undefined });
        const response = await client.chat({ model: safe.model, stream: false,
          messages: [{ role: "system", content: request.system },
            { role: "user", content: request.prompt }],
          options: { num_predict: request.maxOutputTokens } });
        result = { text: response.message?.content ?? "",
          usage: usage(response.prompt_eval_count, response.eval_count) };
        break;
      }
    }
    if (!result.text.trim()) throw new ModelConnectorError("empty-response", "模型没有返回文本");
    return result;
  } catch (error) {
    return safeError(error, request.signal);
  }
}

/** The only connection probe contains fixed synthetic text, never conversation content. */
export async function testConnection(config: ModelConfig): Promise<{
  ok: true; latencyMs: number; model: string;
}> {
  const start = performance.now();
  await generateStructured(config, {
    system: "This is a connection test. Reply briefly.",
    prompt: "Reply with OK.",
    maxOutputTokens: 128,
  });
  return { ok: true, latencyMs: Math.round(performance.now() - start), model: config.model.trim() };
}
