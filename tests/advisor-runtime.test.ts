import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AdvisorRuntime, AdvisorRuntimeError, ADVISOR_ENGINE_VERSION, advisorEngineConfig, advisorEnvironment,
  advisorSafeError, advisorOutputBudget, resolveAdvisorEngine, type AdvisorEngineSpec, type AdvisorRuntimeEvent,
  type AdvisorRuntimeRequest } from "../electron/advisor-runtime";
import type { ModelConfig } from "../electron/model-connectors";

const config: ModelConfig = { protocol: "chat_completions", model: "synthetic-chat",
  baseUrl: "http://127.0.0.1:12345/v1", apiKey: "synthetic-key", contextTokens: 8192 };
const request: AdvisorRuntimeRequest = { account: "synthetic-account", user: "synthetic-person", agentId: "advisor",
  threadId: "synthetic-thread", system: "Be concise", message: "Draft a polite answer", context: "m1 SELF: Hello\nm2 OTHER: Hi",
  contextRevision: 1, skills: [{ id: "empathy", content: "Listen before proposing a reply." }] };

async function fixture(t: TestContext) {
  // The runtime nests `.local/advisor-data/<64 hex>/runtime/workspace/contexts/<64 hex>/…`
  // under this root, which reached 268 characters when the fixture lived in the repository
  // (`.local/advisor-build/runtime-tests`). Past the Windows path limit with long paths
  // disabled, cleanup could not delete the tree and the shell kept asking to delete it
  // permanently. A short system temp root keeps the whole tree well under the limit.
  const parent = path.join(tmpdir(), "wv-advisor-runtime");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const engineDir = path.join(root, ".local", "advisor-engine");
  await mkdir(engineDir, { recursive: true });
  const executable = Buffer.from("Synthetic fixture, never executed.");
  await writeFile(path.join(engineDir, "opencode.exe"), executable);
  await writeFile(path.join(engineDir, "manifest.json"), JSON.stringify({ schema: 1,
    version: ADVISOR_ENGINE_VERSION, file: "opencode.exe", bytes: executable.length,
    sha256: createHash("sha256").update(executable).digest("hex") }));
  const peers = new Set<ServerResponse>();
  const sessions = new Map<string, any>();
  const calls: Array<{ method: string; pathname: string; body: any }> = [];
  const specs: AdvisorEngineSpec[] = [];
  let counter = 0;
  let held = false;
  let engineClosed = 0;
  let error: unknown;
  let tool = false;
  let omitRead = false;
  let wrongRead = false;
  let truncatedRead = false;
  let pageRead = false;
  let gapRead = false;
  let failedRead = false;
  let loadedInstructions = false;
  let hideReadEvents = false;
  let separateReadStep = false;
  let preface = false;
  let reorderPreface = false;
  let noTextTime = false;
  let noPrefaceTime = false;
  let equalNativeTime = false;
  let streamed = "Hello";
  const pending = new Map<string, ServerResponse>();
  const emit = (event: unknown) => { for (const peer of peers) peer.write(`data: ${JSON.stringify(event)}\n\n`); };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method!, pathname, body });
    if (pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      peers.add(res);
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      res.once("close", () => peers.delete(res));
      return;
    }
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (pathname === "/path") {
      const directory = new URL(req.url!, "http://localhost").searchParams.get("directory");
      json({ directory, worktree: directory }); return;
    }
    if (pathname === "/session" && req.method === "POST") {
      const id = `ses_synthetic${++counter}`;
      const session = { id, directory: new URL(req.url!, "http://localhost").searchParams.get("directory"),
        metadata: body.metadata, permission: body.permission };
      sessions.set(id, session);
      json(session);
      return;
    }
    const updateMatch = /^\/session\/([^/]+)$/u.exec(pathname);
    if (updateMatch && req.method === "PATCH") {
      Object.assign(sessions.get(updateMatch[1]), body); json(sessions.get(updateMatch[1])); return;
    }
    const messageMatch = /^\/session\/([^/]+)\/message\/([^/]+)$/u.exec(pathname);
    if (messageMatch && req.method === "GET") {
      const session = sessions.get(messageMatch[1]);
      if (session?.userMessages?.has(messageMatch[2])) json({ info: { id: messageMatch[2], role: "user" }, parts: [] });
      else json({ name: "NotFoundError" }, 404);
      return;
    }
    const match = /^\/session\/([^/]+)(?:\/(message|abort|revert))?$/u.exec(pathname);
    if (match) {
      const id = match[1];
      if (!match[2] && req.method === "GET") { json(sessions.get(id)); return; }
      if (!match[2] && req.method === "DELETE") { sessions.delete(id); json(true); return; }
      if (match[2] === "abort") {
        const prompt = pending.get(id);
        if (prompt && !prompt.writableEnded) prompt.end();
        pending.delete(id);
        json(true);
        return;
      }
      if (match[2] === "revert") { sessions.get(id).revert = { messageID: body.messageID }; json(sessions.get(id)); return; }
      if (match[2] === "message" && req.method === "GET") { json(sessions.get(id)?.history ?? []); return; }
      if (match[2] === "message") {
        const session = sessions.get(id);
        session.userMessages ??= new Set();
        session.userMessages.add(body.messageID);
        const nativeEvent = (type: string, props: Record<string, unknown>) => emit({ type, properties: { sessionID: id, ...props } });
        const timeline = Date.now();
        nativeEvent("session.status", { status: { type: "busy" } });
        nativeEvent("message.updated", { info: { id: `msg_${id}`, role: "assistant", sessionID: id, parentID: body.messageID,
          time: { created: timeline } } });
        const readMessageID = separateReadStep ? `msg_step_${id}` : `msg_${id}`;
        if (separateReadStep) nativeEvent("message.updated", { info: { id: readMessageID, role: "assistant", sessionID: id,
          parentID: body.messageID, time: { created: timeline } } });
        const prefacePart = { id: equalNativeTime ? "prt_00000000000100000000000001" : `preface_${id}`,
          sessionID: id, messageID: readMessageID, type: "text",
          text: "我先看看这轮聊天资料。", ...(!noPrefaceTime ? { time: { start: equalNativeTime ? timeline + 3 : timeline, end: timeline + 3 } } : {}) };
        if (preface && !reorderPreface) nativeEvent("message.part.updated", { part: prefacePart });
        const reading = session.permission?.find((rule: any) => rule.permission === "read" && path.isAbsolute(rule.pattern));
        const toolParts: any[] = [];
        if (reading && !omitRead) {
          const source = await readFile(reading.pattern, "utf8");
          const lines = source.split("\n");
          const actual = gapRead ? lines.slice(0, 2) : truncatedRead || pageRead ? lines.slice(0, Math.max(1, lines.length - 1)) : lines;
          const readPart = { id: equalNativeTime ? "prt_00000000000200000000000002" : `read_${id}`,
            sessionID: id, messageID: readMessageID, type: "tool", tool: "read", callID: "call_synthetic",
            state: { status: "completed", input: { filePath: wrongRead ? path.join(path.dirname(reading.pattern), "unapproved.txt") : reading.pattern },
              time: { start: timeline + 2, end: timeline + 3 }, output: source, metadata: { truncated: truncatedRead, loaded: loadedInstructions ? ["unapproved-instructions.md"] : [], display: { type: "file", path: reading.pattern,
                lineStart: 1, lineEnd: actual.length, totalLines: lines.length, text: actual.join("\n"), truncated: truncatedRead } } } };
          if (failedRead) Object.assign(readPart.state, { status: "error", error: "Synthetic read failure", metadata: {} });
          toolParts.push(readPart);
          if (!hideReadEvents) nativeEvent("message.part.updated", { part: readPart });
          if (pageRead || gapRead) {
            const offset = actual.length + 1 + (gapRead ? 2 : 0);
            const remainder = { ...readPart, id: readPart.id + "_page2", state: { ...readPart.state,
              input: { ...readPart.state.input, offset },
              metadata: { truncated: false, loaded: [], display: { type: "file", path: reading.pattern, lineStart: offset,
                lineEnd: lines.length, totalLines: lines.length, text: lines.slice(offset - 1).join("\n"), truncated: false } } } };
            toolParts.push(remainder); nativeEvent("message.part.updated", { part: remainder });
          }
        }
        if (preface && reorderPreface) nativeEvent("message.part.updated", { part: prefacePart });
        const formalPart = { id: `part_${id}`, sessionID: id, messageID: `msg_${id}`, type: "text", text: streamed,
          ...(!noTextTime ? { time: { start: timeline + 4 } } : {}) };
        nativeEvent("message.part.updated", { part: { ...formalPart, text: "" } });
        nativeEvent("message.part.delta", { messageID: `msg_${id}`, partID: `part_${id}`, field: "text", delta: streamed });
        session.history = [{ info: { role: "assistant", parentID: body.messageID },
          parts: [...(preface ? [prefacePart] : []), ...toolParts] },
          { info: { role: "assistant", parentID: body.messageID }, parts: [formalPart] }];
        if (held) { pending.set(id, res); return; }
        json({ info: { id: `msg_${id}`, role: "assistant", tokens: { input: 42, output: 2, reasoning: 0 }, ...(error ? { error } : {}) },
          parts: [...(preface && !separateReadStep ? [prefacePart] : []), ...(!hideReadEvents && !separateReadStep ? toolParts : []), formalPart,
            ...(tool ? [{ id: `tool_${id}`, messageID: `msg_${id}`, sessionID: id, type: "tool", tool: "bash",
              state: { status: "error", error: "Denied" } }] : [])] });
        return;
      }
    }
    if (/^\/permission\/.+\/reply$/u.test(pathname) || /^\/question\/.+\/reject$/u.test(pathname)) { json(true); return; }
    json({ error: "Fixture route absent" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true });
  const runtime = new AdvisorRuntime({ root, startEngine: async (spec) => {
    specs.push(spec);
    return { client, close: async () => { engineClosed++; for (const peer of peers) peer.end(); } };
  } });
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, calls, sessions, specs, emit, pending,
    setHeld: (value: boolean) => { held = value; }, setError: (value: unknown) => { error = value; },
    setTool: (value: boolean) => { tool = value; },
    omitRead: () => { omitRead = true; }, wrongRead: () => { wrongRead = true; }, truncatedRead: () => { truncatedRead = true; },
    pageRead: () => { pageRead = true; },
    gapRead: () => { gapRead = true; }, failedRead: () => { failedRead = true; },
    loadedInstructions: (historyOnly = false) => { loadedInstructions = true; hideReadEvents = historyOnly; },
    preface: (reordered = false) => { preface = true; reorderPreface = reordered; }, noTextTime: () => { noTextTime = true; },
    noPrefaceTime: () => { noPrefaceTime = true; },
    equalNativeTime: () => { equalNativeTime = true; },
    separateReadStep: () => { separateReadStep = true; },
    setText: (value: string) => { streamed = value; }, getClosed: () => engineClosed };
}

test("engine pin verification checks binary hash and rejects tampering before launch", async (t) => {
  const f = await fixture(t);
  assert.equal(await resolveAdvisorEngine(f.root), path.join(f.root, ".local", "advisor-engine", "opencode.exe"));
  await writeFile(path.join(f.root, ".local", "advisor-engine", "opencode.exe"), "changed");
  await assert.rejects(f.runtime.respond(config, request), (error) => error instanceof AdvisorRuntimeError && error.code === "engine-integrity");
  assert.equal(f.specs.length, 0);
});

test("all five protocols use bundled provider adapters and immutable deny permissions", () => {
  for (const protocol of ["chat_completions", "responses", "anthropic", "gemini", "ollama"] as const) {
    const mapped = advisorEngineConfig({ ...config, protocol, baseUrl: "http://127.0.0.1:12345" });
    assert.equal(mapped.config.permission, "deny");
    assert.deepEqual(mapped.config.agent?.advisor?.permission, { "*": "deny", read: { "*": "deny" } });
    assert.equal(mapped.config.agent?.compaction?.permission, "deny");
    assert.equal(mapped.config.agent?.compactor?.permission, "deny");
    assert.deepEqual(mapped.config.plugin, []);
    assert.deepEqual(mapped.config.mcp, {});
    assert.equal(mapped.config.agent?.build?.disable, true);
    assert.equal(mapped.config.agent?.title?.disable, true);
    assert.equal(mapped.config.compaction?.prune, true);
    const provider = mapped.config.provider![mapped.providerID];
    assert.equal(provider.models![config.model].tool_call, true);
    assert.equal(provider.options!.baseURL, protocol === "ollama" ? "http://127.0.0.1:12345/v1" : "http://127.0.0.1:12345");
    if (protocol === "responses") { assert.equal(mapped.providerID, "openai"); assert.equal(provider.npm, "@ai-sdk/openai"); }
  }
});

test("output and compaction budgets leave room in the smallest allowed window", () => {
  assert.equal(advisorOutputBudget(4096), 1024);
  assert.equal(advisorOutputBudget(8192), 2048);
  assert.equal(advisorOutputBudget(131072), 4096);
  const mapped = advisorEngineConfig({ ...config, contextTokens: 4096 });
  assert.equal(mapped.config.provider![mapped.providerID].models![config.model].limit?.output, 1024);
  assert.equal(mapped.config.compaction?.reserved, 1280);
});

test("engine environment drops parent auth, hooks, proxy and external config", () => {
  const env = advisorEnvironment("C:\\owned", "C:\\runtime\\opencode.exe", advisorEngineConfig(config).config, "synthetic-password", {
    SystemRoot: "C:\\Windows", PATH: "C:\\private-bin", OPENAI_API_KEY: "do-not-inherit", NODE_OPTIONS: "--require evil",
    OPENCODE_CONFIG: "C:\\developer.json", OPENCODE_CONFIG_CONTENT: "malicious", OPENCODE_TEST_HOME: "C:\\developer",
    CLAUDE_CONFIG_DIR: "C:\\claude", HTTP_PROXY: "http://unapproved", HOME: "C:\\personal", USERPROFILE: "C:\\personal",
  });
  for (const key of ["OPENAI_API_KEY", "NODE_OPTIONS", "OPENCODE_CONFIG", "CLAUDE_CONFIG_DIR", "HTTP_PROXY"]) assert.equal(env[key], undefined);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(env.OPENCODE_PERMISSION, '"deny"');
  assert.equal(env.OPENCODE_TEST_HOME, path.join("C:\\owned", "home"));
  assert.equal(env.OPENCODE_TEST_MANAGED_CONFIG_DIR, path.join("C:\\owned", "managed"));
  assert(!env.PATH!.includes("private-bin"));
  assert.equal(env.OPENCODE_SERVER_PASSWORD, "synthetic-password");
});

test("official SDK permits only the context path and instructs a fresh read every turn", async (t) => {
  const f = await fixture(t);
  const events: AdvisorRuntimeEvent[] = [];
  const first = await f.runtime.respond(config, request, (event) => events.push(event));
  assert.equal(first.text, "Hello");
  assert.deepEqual(first.usage, { inputTokens: 42, outputTokens: 2, reasoningTokens: 0 });
  const prompt = f.calls.find((call) => call.pathname.endsWith("/message"))!.body;
  assert.equal(prompt.parts.length, 1);
  assert.equal(prompt.parts[0].text, request.message);
  assert(!prompt.parts[0].text.includes(request.context));
  assert(!prompt.system.includes(request.context));
  assert(prompt.system.includes("Listen before proposing a reply."));
  assert.equal(prompt.tools, undefined);
  const permission = f.sessions.get(first.runtimeSessionId).permission;
  assert.deepEqual(permission[0], { permission: "*", pattern: "*", action: "deny" });
  const contextFile = permission.find((rule: any) => rule.permission === "read" && path.isAbsolute(rule.pattern)).pattern;
  assert(prompt.system.includes(JSON.stringify(contextFile)));
  assert(prompt.system.includes("Before answering this turn"));
  assert(prompt.system.includes("last actually returned line plus one"));
  assert((await readFile(contextFile, "utf8")).includes(request.context!));
  assert(permission.slice(1).every((rule: any) => rule.permission === "read" && rule.action === "allow" && !rule.pattern.includes("*")));
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Hello");
  assert(events.some((event) => event.type === "skill" && event.skillId === "empathy" && event.state === "loaded"));
  assert.match(f.specs[0].cwd, /advisor-data[\\/][a-f0-9]{64}[\\/]runtime[\\/]workspace$/u);
  const second = await f.runtime.respond(config, { ...request, runtimeSessionId: first.runtimeSessionId, context: "m3 OTHER: New message", contextRevision: 2 });
  assert.equal(second.runtimeSessionId, first.runtimeSessionId);
  assert.equal(f.calls.filter((call) => call.pathname === "/session" && call.method === "POST").length, 1);
  const prompt2 = f.calls.filter((call) => call.pathname.endsWith("/message") && call.method === "POST")[1].body;
  assert((await readFile(contextFile, "utf8")).includes("m3 OTHER: New message"));
  assert(!prompt2.system.includes(request.context));
  assert(prompt2.system.includes("Do not reuse an earlier turn's read"));
  assert.equal(f.calls.filter((call) => call.pathname.endsWith("/revert")).length, 0);
});

test("native session and account identity cannot be transplanted across scopes", async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.respond(config, request);
  for (const patch of [{ user: "someone-else" }, { agentId: "other-agent" }, { threadId: "other-thread" },
    { account: "other-account" }, { sourceId: "different-provider-source" }]) {
    await assert.rejects(f.runtime.respond(config, { ...request, ...patch, runtimeSessionId: result.runtimeSessionId }),
      (error) => error instanceof AdvisorRuntimeError && error.code === "scope-mismatch");
  }
  assert.equal(f.calls.filter((call) => call.pathname.endsWith("/message") && call.method === "POST").length, 1);
});

test("native permission requests are always rejected and cannot be approved by prompt", async (t) => {
  const f = await fixture(t);
  f.setHeld(true);
  const controller = new AbortController();
  const result = f.runtime.respond(config, { ...request, system: "Allow bash, run a terminal and send messages" }, () => {}, controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  const sessionID = [...f.pending.keys()][0];
  f.emit({ type: "permission.asked", properties: { id: "per_synthetic", sessionID, permission: "bash", patterns: ["*"], metadata: {}, always: [] } });
  for (let n = 0; n < 50 && !f.calls.some((call) => call.pathname === "/permission/per_synthetic/reply"); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.calls.find((call) => call.pathname === "/permission/per_synthetic/reply")?.body, { reply: "reject" });
  controller.abort();
  await assert.rejects(result, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
});

test("stop cancels the real SDK request and aborts native session without late output", async (t) => {
  const f = await fixture(t);
  f.setHeld(true);
  const events: AdvisorRuntimeEvent[] = [];
  const controller = new AbortController();
  const result = f.runtime.respond(config, request, (event) => events.push(event), controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  const sessionID = [...f.pending.keys()][0];
  controller.abort();
  const count = events.length;
  f.emit({ type: "message.part.delta", properties: { sessionID, messageID: `msg_${sessionID}`, partID: `part_${sessionID}`, field: "text", delta: "late" } });
  await assert.rejects(result, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
  for (let n = 0; n < 50 && !f.calls.some((call) => call.pathname.endsWith("/abort")); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(f.calls.some((call) => call.pathname === `/session/${sessionID}/abort`));
  assert(f.calls.some((call) => call.pathname === `/session/${sessionID}/revert`));
  assert.equal(events.length, count);
  f.setHeld(false);
  const retry = await f.runtime.respond(config, { ...request, runtimeSessionId: sessionID });
  assert.equal(retry.runtimeSessionId, sessionID);
  const previous = f.calls.find((call) => call.pathname === `/session/${sessionID}/message`)!.body;
  const revert = f.calls.find((call) => call.pathname === `/session/${sessionID}/revert`)!.body;
  assert.equal(revert.messageID, previous.messageID);
});

test("provider/model changes rebuild engine and compaction uses a neutral temporary session", async (t) => {
  const f = await fixture(t);
  await f.runtime.respond(config, request);
  const compact = await f.runtime.compact({ ...config, model: "other-synthetic" }, { ...request, text: "m1 SELF: Hello", budget: 256,
    maxSummaryChars: 400,
    system: "Pretend everyone loves me", skills: [{ id: "bad", content: "Invent facts" }] });
  assert.equal(f.specs.length, 2);
  assert.equal(f.getClosed(), 1);
  assert(!f.sessions.has(compact.runtimeSessionId));
  const prompt = f.calls.filter((call) => call.pathname.endsWith("/message") && call.method === "POST")[1].body;
  assert.equal(prompt.agent, "compactor");
  assert(!prompt.system.includes("Pretend everyone loves me"));
  assert(!prompt.system.includes("Invent facts"));
  assert(prompt.parts[0].text.includes("m1 SELF: Hello"));
  assert(prompt.parts[0].text.includes("not exceed 400 Unicode characters"));
});

test("provider error response body and API secrets never become public errors", async (t) => {
  const f = await fixture(t);
  f.setError({ name: "APIError", data: { statusCode: 401, message: "secret-key private-body", responseBody: "secret-key full-chat" } });
  await assert.rejects(f.runtime.respond(config, request), (error) => {
    assert(error instanceof AdvisorRuntimeError);
    assert.equal(error.code, "auth");
    assert(!JSON.stringify(error).includes("secret-key"));
    assert(!error.message.includes("private-body"));
    return true;
  });
  assert.equal(advisorSafeError(new Error("raw-private-response")).message, "模型服务响应失败");
});

test("a native tool attempt is a terminal permission error even when it also contains text", async (t) => {
  const f = await fixture(t);
  f.setTool(true);
  await assert.rejects(f.runtime.respond(config, request), (error) => error instanceof AdvisorRuntimeError && error.code === "permission-denied");
  assert(f.calls.some((call) => call.pathname.endsWith("/revert")));
});

test("persisted incomplete-turn checkpoint is reverted before a restored request", async (t) => {
  const f = await fixture(t);
  const result = await f.runtime.respond(config, request);
  const prior = f.calls.find((call) => call.pathname.endsWith("/message"))!.body;
  const scope = f.sessions.get(result.runtimeSessionId).metadata.advisorScope;
  const directory = path.join(f.specs[0].cwd, ".advisor-checkpoints");
  const target = path.join(directory, createHash("sha256").update(result.runtimeSessionId).digest("hex") + ".json");
  await writeFile(target, JSON.stringify({ schema: 1, scope, sessionID: result.runtimeSessionId, messageID: prior.messageID }));
  await f.runtime.respond(config, { ...request, runtimeSessionId: result.runtimeSessionId });
  const rollbackIndex = f.calls.findIndex((call) => call.pathname.endsWith("/revert"));
  const promptIndices = f.calls.map((call, index) => call.pathname.endsWith("/message") && call.method === "POST" ? index : -1).filter((index) => index >= 0);
  assert(rollbackIndex > promptIndices[0] && rollbackIndex < promptIndices[1]);
  await assert.rejects(readFile(target), (error: any) => error.code === "ENOENT");
});

test("native retry timing is preserved while its provider body is replaced with safe text", async (t) => {
  const f = await fixture(t);
  f.setHeld(true);
  const controller = new AbortController();
  const events: AdvisorRuntimeEvent[] = [];
  const result = f.runtime.respond(config, request, (event) => events.push(event), controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  const sessionID = [...f.pending.keys()][0];
  const next = Date.now() + 5000;
  f.emit({ type: "session.status", properties: { sessionID, status: { type: "retry", attempt: 2, next,
    message: "secret-key private-upstream-error-body" } } });
  for (let n = 0; n < 50 && !events.some((event) => event.state === "retry"); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  const retry = events.find((event) => event.state === "retry");
  assert.equal(retry?.next, next);
  assert.equal(retry?.attempt, 2);
  assert.equal(retry?.nativeType, "session.status");
  assert(!JSON.stringify(events).includes("secret-key"));
  controller.abort();
  await assert.rejects(result, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
});

test("answer without a native read streams normally under the system prompt", async (t) => {
  const f = await fixture(t); f.omitRead();
  const events: AdvisorRuntimeEvent[] = [];
  assert.equal((await f.runtime.respond(config, request, (event) => events.push(event))).text, "Hello");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Hello");
  assert.equal(f.calls.filter((call) => call.pathname.endsWith("/revert")).length, 0);
});

test("read of another path is rejected and cannot be accepted as context evidence", async (t) => {
  const f = await fixture(t); f.wrongRead();
  await assert.rejects(f.runtime.respond(config, request), (error) => error instanceof AdvisorRuntimeError && error.code === "permission-denied");
});

test("truncated read does not block the model's response", async (t) => {
  const f = await fixture(t); f.truncatedRead();
  assert.equal((await f.runtime.respond(config, request)).text, "Hello");
});

test("multiple native read pages remain available to the model", async (t) => {
  const f = await fixture(t); f.pageRead();
  assert.equal((await f.runtime.respond(config, request)).text, "Hello");
});

test("missing ranges in a paged read do not discard a valid response", async (t) => {
  const f = await fixture(t); f.gapRead();
  assert.equal((await f.runtime.respond(config, request)).text, "Hello");
  assert.equal(f.calls.filter((call) => call.pathname.endsWith("/revert")).length, 0);
});

test("read errors on the allowed file are handled by the model", async (t) => {
  const f = await fixture(t); f.failedRead(); f.setText("The conversation file is unavailable.");
  assert.equal((await f.runtime.respond(config, request)).text, "The conversation file is unavailable.");
});

test("external instructions loaded by a read remain forbidden, including delayed tool events", async (t) => {
  for (const historyOnly of [false, true]) {
    const f = await fixture(t); f.loadedInstructions(historyOnly);
    await assert.rejects(f.runtime.respond(config, request),
      (error) => error instanceof AdvisorRuntimeError && error.code === "permission-denied");
  }
});

test("one frozen scope cannot start two native sessions concurrently", async (t) => {
  const f = await fixture(t); f.setHeld(true);
  const controller = new AbortController();
  const first = f.runtime.respond(config, request, () => {}, controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(f.runtime.respond(config, request), (error) => error instanceof AdvisorRuntimeError && error.code === "busy");
  controller.abort();
  await assert.rejects(first, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
  assert.equal(f.calls.filter((call) => call.pathname === "/session" && call.method === "POST").length, 1);
});

test("ordinary model narration streams before a tool read without being filtered", async (t) => {
  const f = await fixture(t); f.preface();
  const events: AdvisorRuntimeEvent[] = [];
  const result = await f.runtime.respond(config, request, (event) => events.push(event));
  assert.equal(result.text, "我先看看这轮聊天资料。\nHello");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "我先看看这轮聊天资料。Hello");
});

test("text from earlier native assistant steps survives finalization without duplicates", async (t) => {
  const f = await fixture(t); f.preface(); f.separateReadStep();
  const events: AdvisorRuntimeEvent[] = [];
  const result = await f.runtime.respond(config, request, event => events.push(event));
  assert.equal(result.text, "我先看看这轮聊天资料。\nHello");
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), "我先看看这轮聊天资料。Hello");
  const previousParts = f.sessions.get(result.runtimeSessionId).history[0].parts;
  assert(previousParts.some((part: any) => part.type === "text"));
  assert.equal(f.calls.filter(call => call.pathname.endsWith("/revert")).length, 0);
});

test("late SSE text is not filtered by read completion time", async (t) => {
  const f = await fixture(t); f.preface(true);
  const events: AdvisorRuntimeEvent[] = [];
  assert.equal((await f.runtime.respond(config, request, (event) => events.push(event))).text, "我先看看这轮聊天资料。\nHello");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "我先看看这轮聊天资料。Hello");
});

test("timestamp-free text uses normal incremental output", async (t) => {
  const f = await fixture(t); f.preface(true); f.noPrefaceTime(); f.noTextTime();
  const events: AdvisorRuntimeEvent[] = [];
  assert.equal((await f.runtime.respond(config, request, (event) => events.push(event))).text, "我先看看这轮聊天资料。\nHello");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "我先看看这轮聊天资料。Hello");
});

test("equal timestamps do not change which model text is accepted", async (t) => {
  const f = await fixture(t); f.preface(true); f.equalNativeTime();
  const events: AdvisorRuntimeEvent[] = [];
  assert.equal((await f.runtime.respond(config, request, (event) => events.push(event))).text, "我先看看这轮聊天资料。\nHello");
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "我先看看这轮聊天资料。Hello");
});

test("text without a read or timestamp streams before HTTP completes", async (t) => {
  const f = await fixture(t); f.omitRead(); f.noTextTime(); f.setHeld(true);
  const events: AdvisorRuntimeEvent[] = [];
  const controller = new AbortController();
  const result = f.runtime.respond(config, request, (event) => events.push(event), controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  for (let n = 0; n < 50 && !events.some((event) => event.type === "text"); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Hello");
  controller.abort(); await assert.rejects(result, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
});

test("repeated busy is coalesced, reasoning changes phase once, retry timing changes are retained", async (t) => {
  const f = await fixture(t); f.setHeld(true);
  const events: AdvisorRuntimeEvent[] = [];
  const controller = new AbortController();
  const result = f.runtime.respond(config, request, (event) => events.push(event), controller.signal);
  while (!f.pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  const sessionID = [...f.pending.keys()][0];
  const nativeEvent = (type: string, properties: any) => f.emit({ type, properties: { sessionID, ...properties } });
  for (let n = 0; n < 4; n++) nativeEvent("session.status", { status: { type: "busy" } });
  nativeEvent("message.part.updated", { part: { id: "reasoning_part", sessionID, messageID: `msg_${sessionID}`, type: "reasoning", text: "" } });
  for (const delta of ["A", "B", "C"]) {
    nativeEvent("message.part.delta", { messageID: `msg_${sessionID}`, partID: "reasoning_part", field: "text", delta });
    nativeEvent("session.status", { status: { type: "busy" } });
  }
  const next = Date.now() + 5000;
  nativeEvent("session.status", { status: { type: "retry", attempt: 1, next } });
  nativeEvent("session.status", { status: { type: "retry", attempt: 1, next } });
  nativeEvent("session.status", { status: { type: "retry", attempt: 2, next: next + 5000 } });
  for (let n = 0; n < 50 && !events.some((event) => event.attempt === 2); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.filter((event) => event.type === "status" && event.state === "answering").length, 1);
  assert.equal(events.filter((event) => event.type === "status" && event.state === "thinking").length, 1);
  assert.equal(events.filter((event) => event.type === "reasoning").map((event) => event.text).join(""), "ABC");
  assert.deepEqual(events.filter((event) => event.state === "retry").map((event) => [event.attempt, event.next]), [[1, next], [2, next + 5000]]);
  controller.abort(); await assert.rejects(result, (error) => error instanceof AdvisorRuntimeError && error.code === "cancelled");
});
