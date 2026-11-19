// Pure selection logic for adaptive CPU thread counts. No onnxruntime-node import here.
import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";

import {
  ADAPTIVE_MAX_THREADS, BENCHMARK_LENGTH, BENCHMARK_MARKERS, BENCHMARK_ROWS,
  DEFAULT_INTRA_OP_THREADS, benchmarkBatch, heuristicThreads, pickFastest,
  readCachedThreads, threadCacheKey, threadCachePath, threadCandidates, writeCachedThreads,
} from "../electron/laya/thread-tuning";

it("offers the legacy 4 threads plus a capped core-derived candidate", () => {
  assert.deepEqual(threadCandidates(16), [4, ADAPTIVE_MAX_THREADS]);
  assert.deepEqual(threadCandidates(4), [4, 3]);
  assert.deepEqual(threadCandidates(2), [4, 1]);
  assert.deepEqual(threadCandidates(1), [4, 1]);
  assert.deepEqual(threadCandidates(Number.NaN), [4, 3]);
});

it("uses a saturating core-count heuristic for zero-cost startup", () => {
  assert.equal(heuristicThreads(2), 1);
  assert.equal(heuristicThreads(4), 3);
  assert.equal(heuristicThreads(12), ADAPTIVE_MAX_THREADS);
  assert.equal(heuristicThreads(64), ADAPTIVE_MAX_THREADS);
  assert.equal(heuristicThreads(Number.NaN), 3);
});

it("picks the fastest thread count and prefers fewer threads on a tie", () => {
  assert.equal(pickFastest([{ threads: 4, ms: 120 }, { threads: 8, ms: 90 }]), 8);
  assert.equal(pickFastest([{ threads: 4, ms: 90 }, { threads: 8, ms: 120 }]), 4);
  assert.equal(pickFastest([{ threads: 4, ms: 100 }, { threads: 8, ms: 100 }]), 4);
  // A 10% gap is within measurement noise: stay on the cheaper thread count.
  assert.equal(pickFastest([{ threads: 4, ms: 100 }, { threads: 8, ms: 110 }]), 4);
  assert.equal(pickFastest([{ threads: 4, ms: 110 }, { threads: 8, ms: 100 }]), 4);
  // A 30% gap is significant and may point either way.
  assert.equal(pickFastest([{ threads: 4, ms: 100 }, { threads: 8, ms: 130 }]), 4);
  assert.equal(pickFastest([{ threads: 4, ms: 130 }, { threads: 8, ms: 100 }]), 8);
  assert.equal(pickFastest([]), DEFAULT_INTRA_OP_THREADS);
});

it("builds a realistic, fully valid benchmark batch", () => {
  const batch = benchmarkBatch();
  assert.equal(batch.rows, BENCHMARK_ROWS);
  assert.equal(batch.length, BENCHMARK_LENGTH);
  assert.equal(batch.markers, BENCHMARK_MARKERS);
  assert.equal(batch.inputIds.length, BENCHMARK_ROWS * BENCHMARK_LENGTH);
  assert.equal(batch.attentionMask.length, BENCHMARK_ROWS * BENCHMARK_LENGTH);
  assert.equal(batch.markerPos.length, BENCHMARK_ROWS * BENCHMARK_MARKERS);
  assert.equal(batch.qtype.length, BENCHMARK_ROWS);
  assert.ok(batch.markerMask.every((value) => value === 1));
  assert.ok([...batch.qtype].every((value) => value >= 0n && value <= 2n));
  assert.ok([...batch.markerPos].every((value) => value >= 0n && value < BigInt(BENCHMARK_LENGTH)));
});

it("caches the measured winner and rejects stale or out-of-range entries", () => {
  const file = threadCachePath().replace(/laya-threads\.json$/u, "laya-threads-test.json");
  const key = threadCacheKey(path.resolve(".local/models/laya/model.onnx"), 8, "test-node");
  assert.equal(key.includes("model.onnx"), true);
  assert.equal(readCachedThreads(file, `${key}-missing`, [4, 8]), null);
  writeCachedThreads(file, key, 8, [{ threads: 4, ms: 120 }, { threads: 8, ms: 90 }]);
  assert.equal(readCachedThreads(file, key, [4, 8]), 8);
  assert.equal(readCachedThreads(file, key, [4, 2]), null);
});
