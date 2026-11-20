import path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { AdvisorRuntime, AdvisorRuntimeError, advisorSafeError, type AdvisorRuntimeRequest } from "../electron/advisor-runtime";
import type { ModelConfig } from "../electron/model-connectors";

const MAX_LINE_BYTES = 20 * 1024 * 1024;
type CommandId = string | number;

const pendingWrites: string[] = [];
let writing = false;
function flushWrites(): void {
  if (writing) return;
  writing = true;
  while (pendingWrites.length) {
    const line = pendingWrites.shift()!;
    if (!process.stdout.write(line)) {
      process.stdout.once("drain", () => { writing = false; flushWrites(); });
      return;
    }
  }
  writing = false;
}
function output(value: unknown): void {
  pendingWrites.push(JSON.stringify(value) + "\n");
  flushWrites();
}

export async function runAdvisorWorker(root: string): Promise<void> {
  const runtime = new AdvisorRuntime({ root });
  const active = new Map<CommandId, AbortController>();
  const tasks = new Set<Promise<void>>();
  let closing = false;
  const handle = async (raw: string) => {
    let id: CommandId | null = null;
    try {
      if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) throw new AdvisorRuntimeError("invalid-request");
      let command: any;
      try { command = JSON.parse(raw); } catch { throw new AdvisorRuntimeError("invalid-request"); }
      if (!command || typeof command !== "object" || Array.isArray(command)) throw new AdvisorRuntimeError("invalid-request");
      if ((typeof command.id !== "string" && !Number.isSafeInteger(command.id)) ||
          (typeof command.id === "string" && (!command.id || command.id.length > 128))) throw new AdvisorRuntimeError("invalid-request");
      id = command.id;
      if (closing) throw new AdvisorRuntimeError("engine-unavailable");
      if (command.cmd === "doctor") { output({ id, result: await runtime.doctor() }); return; }
      if (command.cmd === "cancel") {
        const target = command.payload?.targetId ?? command.payload?.requestId ?? command.payload?.id;
        active.get(target)?.abort();
        output({ id, result: { cancelled: active.has(target) } });
        return;
      }
      if (command.cmd === "close") {
        closing = true;
        for (const controller of active.values()) controller.abort();
        await runtime.close();
        output({ id, result: { closed: true } });
        lines.close();
        process.stdin.pause();
        return;
      }
      if (!["respond", "compact"].includes(command.cmd) || !command.payload?.request || !command.payload?.config || active.has(id!)) {
        throw new AdvisorRuntimeError("invalid-request");
      }
      const controller = new AbortController();
      active.set(id!, controller);
      try {
        const onEvent = (event: unknown) => { if (!controller.signal.aborted) output({ id, event }); };
        const result = await runtime[command.cmd as "respond" | "compact"](command.payload.config as ModelConfig,
          command.payload.request as AdvisorRuntimeRequest, onEvent, controller.signal);
        output({ id, result });
      } finally { active.delete(id!); }
    } catch (error) {
      const safe = advisorSafeError(error);
      output({ id, error: { code: safe.code, message: safe.message } });
    }
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const shutdown = () => { closing = true; for (const controller of active.values()) controller.abort(); lines.close(); process.stdin.pause(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const task = handle(line).finally(() => tasks.delete(task));
    tasks.add(task);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  closing = true;
  for (const controller of active.values()) controller.abort();
  await runtime.close();
  await Promise.allSettled(tasks);
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  const root = index >= 0 ? process.argv[index + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!root) { output({ id: null, error: { code: "invalid-request", message: "Agent 请求格式不正确" } }); }
  else runAdvisorWorker(root).catch(() => {
    output({ id: null, error: { code: "engine-unavailable", message: "Agent 引擎连接已断开" } });
    process.exitCode = 1;
  });
}
