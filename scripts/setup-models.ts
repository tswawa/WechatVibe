// Written for this project (not vendored).
//
// One-time model setup: downloads the pinned Laya multilingual ONNX bundle into `.models/laya`
// with streaming writes to `<file>.part`, then verifies each file's SHA256 and byte size before
// renaming it into place. This is the ONLY place the analyzer is allowed to use the network;
// inference and OCR are offline.
//
// Usage (once npm scripts exist):
//   npm run setup:models            # download missing / stale files
//   npm run setup:models -- --force # re-download everything
//   npm run setup:models -- --dir D:\models\laya
//
// The pins below match the frozen contract. Do not change them without also updating
// electron/analysis.ts's MODEL_REVISION and re-running scripts/test-model.ts.

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

export const MODEL_REPO = "mizchi/laya-multilingual-onnx";
export const MODEL_REVISION = "d9d003d543e63d6d3375c21d44624136bd1e0bad";

export interface PinnedFile {
  /** Path relative to the model directory. */
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Fixed bundle files and their hashes. model.onnx and tokenizer/tokenizer.json hashes are given
 * by the contract; the small JSON files were pinned by querying the Hugging Face metadata for
 * revision d9d003d543e63d6d3375c21d44624136bd1e0bad.
 */
export const PINNED_FILES: PinnedFile[] = [
  {
    path: "model.onnx",
    bytes: 646870871,
    sha256: "0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c",
  },
  {
    path: "tokenizer/tokenizer.json",
    bytes: 34363188,
    sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
  },
  {
    path: "rl_agent_config.json",
    bytes: 473,
    sha256: "9a669a70961064c3c6cc76d2afb8bc5fb10dcd8349bb66e5f7b9b1afb74440d5",
  },
  {
    path: "onnx_config.json",
    bytes: 332,
    sha256: "13db475255d076da580a3435f28904e3360fe7f6380d7e3c75ee586e966ca5f0",
  },
  {
    path: "tokenizer/tokenizer_config.json",
    bytes: 524,
    sha256: "6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1",
  },
];

export const DEFAULT_MODEL_DIR = path.resolve(process.cwd(), ".models", "laya");

interface Options {
  dir: string;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  let dir = process.env.LAYA_MODEL_DIR ?? DEFAULT_MODEL_DIR;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) throw new Error("--dir requires a path");
      dir = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: setup-models [--force] [--dir <path>]",
          "",
          `Default directory: ${DEFAULT_MODEL_DIR}`,
          "Environment: LAYA_MODEL_DIR overrides the default directory.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { dir, force };
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function downloadFile(spec: PinnedFile, options: Options): Promise<void> {
  const dest = path.join(options.dir, spec.path);
  const part = `${dest}.part`;
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${spec.path}`;

  if (!options.force && existsSync(dest)) {
    const stat = statSync(dest);
    if (stat.size === spec.bytes) {
      const existing = await hashFile(dest);
      if (existing.sha256 === spec.sha256) {
        console.log(`[ok]   ${spec.path} (已存在，SHA256 校验通过)`);
        return;
      }
      console.log(`[warn] ${spec.path} 校验不匹配，重新下载`);
    } else {
      console.log(
        `[warn] ${spec.path} 大小不一致（${formatBytes(stat.size)} != ${formatBytes(spec.bytes)}），重新下载`,
      );
    }
  }

  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(part, { force: true });

  console.log(`[get]  ${spec.path} <- ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载 ${spec.path} 失败: HTTP ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : spec.bytes;

  const hash = createHash("sha256");
  let received = 0;
  let lastReported = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (received - lastReported >= 32 * 1024 * 1024 || received === total) {
        lastReported = received;
        const pct = total > 0 ? ((received / total) * 100).toFixed(1) : "?";
        process.stdout.write(
          `\r       ${formatBytes(received)} / ${formatBytes(total)} (${pct}%)`,
        );
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      hasher,
      createWriteStream(part),
    );
    process.stdout.write("\n");
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }

  if (received !== spec.bytes) {
    rmSync(part, { force: true });
    throw new Error(
      `下载 ${spec.path} 被截断: 收到 ${received} 字节，期望 ${spec.bytes} 字节（HTTP ${response.status}）`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== spec.sha256) {
    rmSync(part, { force: true });
    throw new Error(`下载 ${spec.path} SHA256 校验失败:\n  期望 ${spec.sha256}\n  实际 ${digest}`);
  }
  renameSync(part, dest);
  console.log(`[done] ${spec.path} (${formatBytes(spec.bytes)})`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Laya 模型目录: ${options.dir}`);
  console.log(`仓库: ${MODEL_REPO}@${MODEL_REVISION}\n`);
  mkdirSync(options.dir, { recursive: true });
  for (const spec of PINNED_FILES) {
    await downloadFile(spec, options);
  }
  console.log("\n全部模型文件已就绪并校验通过。");
}

main().catch((error) => {
  console.error(`\n[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
