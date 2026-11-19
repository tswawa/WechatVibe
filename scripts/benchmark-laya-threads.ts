// One-off calibration: measure CPU intra-op thread counts with a realistic Laya forward
// and cache the winner. Startup then uses the measured value with zero overhead.
//
//   npm run benchmark:laya-threads
//   LAYA_MODEL_DIR=/path/to/laya npm run benchmark:laya-threads
//
// A valid measurement needs the real 8x256 batch (tens of seconds on CPU). Do not
// shrink the shape: a 2x64 probe inverts the 4-vs-8 result.
import { existsSync } from "node:fs";
import path from "node:path";

import { NodeOnnxRunner } from "../electron/laya/runner";

const dirs = [
  process.env.LAYA_MODEL_DIR,
  path.resolve(process.cwd(), ".models", "laya"),
  path.resolve(process.cwd(), ".local", "models", "laya"),
].filter((value): value is string => typeof value === "string" && value.length > 0);
const dir = dirs.find((value) => existsSync(path.join(value, "model.onnx")));
if (!dir) throw new Error("model.onnx not found; set LAYA_MODEL_DIR to the Laya model directory");

const modelPath = path.join(dir, "model.onnx");
const started = Date.now();
const result = await NodeOnnxRunner.calibrateCpuThreads(modelPath);
console.log(JSON.stringify({
  model: modelPath,
  cores: result.cores,
  winnerThreads: result.threads,
  elapsedMs: Date.now() - started,
  samples: result.samples.map((row) => ({ threads: row.threads, msPerForward: Math.round(row.ms) })),
}, null, 2));
