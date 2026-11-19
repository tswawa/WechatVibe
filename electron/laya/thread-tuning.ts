// Adaptive CPU intra-op thread selection for the Laya ONNX session.
//
// Kept free of `onnxruntime-node` imports so the selection logic can be unit-tested without
// loading the native binding. WebGPU ignores `intraOpNumThreads`, so tuning only applies to
// the CPU provider.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Batch } from "./types";

export const DEFAULT_INTRA_OP_THREADS = 4;
export const ADAPTIVE_MAX_THREADS = 8;
/** Bump when the benchmark shape or the decision rule changes, so old results are not reused. */
export const TUNING_VERSION = "v4-robust";
/** Below this relative gap two thread counts are a measurement tie. */
export const SIGNIFICANT_GAIN = 0.2;
export const BENCHMARK_REPEATS = 2;
/**
 * Must stay close to a real portrait forward. A reduced 2x64 shape is ~25x cheaper but
 * inverts the result (4 threads beat 8 there, while the real 8x256 shape favours 8),
 * so calibration is an explicit one-off action rather than a startup step.
 */
export const BENCHMARK_ROWS = 8;
export const BENCHMARK_LENGTH = 256;
export const BENCHMARK_MARKERS = 3;

export interface ThreadSample { threads: number; ms: number }
interface ThreadCache {
  [key: string]: { threads: number; samples: ThreadSample[]; pickedAt: number };
}

/** Core-count-derived CPU thread count, capped so we never oversubscribe badly. */
export function heuristicThreads(cores: number): number {
  return Math.max(1, Math.min(ADAPTIVE_MAX_THREADS,
    Math.floor((Number.isFinite(cores) && cores > 0 ? cores : 4) - 1) || 1));
}

/** Fixed legacy value plus the heuristic; these are the two calibration candidates. */
export function threadCandidates(cores: number): number[] {
  return [...new Set([DEFAULT_INTRA_OP_THREADS, heuristicThreads(cores)])];
}

/**
 * Lowest latency wins only when the gap is meaningful. Two independent calibrations on
 * the same machine produced opposite 4-vs-8 results (14% one way, 42% the other), so a
 * sub-threshold gap is treated as noise and we prefer fewer threads (less oversubscription).
 */
export function pickFastest(samples: ThreadSample[],
  significantRatio = SIGNIFICANT_GAIN): number {
  if (!samples.length) return DEFAULT_INTRA_OP_THREADS;
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const best = sorted[0]!;
  const second = sorted[1];
  if (!second) return best.threads;
  if ((second.ms - best.ms) / Math.max(1e-6, best.ms) < significantRatio) {
    return sorted.reduce((a, b) => a.threads < b.threads ? a : b).threads;
  }
  return best.threads;
}

export function threadCacheKey(modelPath: string, cores: number, nodeVersion: string): string {
  let stamp = "missing";
  try {
    const info = statSync(modelPath);
    stamp = `${info.size}:${Math.floor(info.mtimeMs)}`;
  } catch { /* model may be memory-mapped from another location */ }
  return `${path.resolve(modelPath)}|${stamp}|${cores}|${nodeVersion}|${TUNING_VERSION}`;
}

export function threadCachePath(root = process.cwd()): string {
  return path.join(root, ".local", "real-client-runtime", "laya-threads.json");
}

export function readCachedThreads(filePath: string, key: string, candidates: number[]): number | null {
  try {
    const cache = JSON.parse(readFileSync(filePath, "utf8")) as ThreadCache;
    const value = cache[key]?.threads;
    return typeof value === "number" && candidates.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeCachedThreads(filePath: string, key: string,
  threads: number, samples: ThreadSample[]): void {
  try {
    let cache: ThreadCache = {};
    try { cache = JSON.parse(readFileSync(filePath, "utf8")) as ThreadCache; } catch { /* new file */ }
    cache[key] = { threads, samples, pickedAt: Date.now() };
    // Keep only the most recent 8 model/runtime signatures.
    const entries = Object.entries(cache).sort((a, b) => b[1].pickedAt - a[1].pickedAt).slice(0, 8);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(Object.fromEntries(entries)) + "\n", "utf8");
  } catch { /* cache is an optimisation, never a startup failure */ }
}

/** A realistic-shaped, all-valid batch for timing; values are arbitrary like probeBatch(). */
export function benchmarkBatch(): Batch {
  const rows = BENCHMARK_ROWS;
  const length = BENCHMARK_LENGTH;
  const markers = BENCHMARK_MARKERS;
  const inputIds = new BigInt64Array(rows * length).fill(0n);
  const attentionMask = new BigInt64Array(rows * length).fill(1n);
  const markerPos = new BigInt64Array(rows * markers);
  const markerMask = new Uint8Array(rows * markers).fill(1);
  for (let row = 0; row < rows; row++) {
    for (let index = 0; index < markers; index++) {
      markerPos[row * markers + index] = BigInt(index + 1);
    }
  }
  return {
    rows, length, markers, inputIds, attentionMask, markerPos, markerMask,
    qtype: BigInt64Array.from({ length: rows }, (_, index) => BigInt(index % 3)),
  };
}

export function cachePathExists(filePath: string): boolean { return existsSync(filePath); }
