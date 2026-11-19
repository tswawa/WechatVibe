// Written for this project (not vendored).
// Node/Electron counterpart of laya-mlx's browser `session.ts` OnnxRunner: same ONNX graph,
// same feed names/shapes, backed by onnxruntime-node. Production prefers WebGPU on Windows.

import os from "node:os";

import * as ort from "onnxruntime-node";

import type { Runner } from "./agent";
import {
  BENCHMARK_REPEATS, DEFAULT_INTRA_OP_THREADS, benchmarkBatch, heuristicThreads,
  pickFastest, readCachedThreads, threadCacheKey, threadCachePath, threadCandidates,
  writeCachedThreads, type ThreadSample,
} from "./thread-tuning";
import type { Batch, RunnerOutput } from "./types";

export interface NodeRunnerOptions {
  /**
   * Intra-op CPU threads. Explicit values always win. When omitted and `adaptiveThreads` is
   * set, the CPU path benchmarks 4 vs a core-count-derived value and keeps the faster one.
   */
  intraOpThreads?: number;
  /** Benchmark CPU thread counts once per model/runtime signature, then reuse the result. */
  adaptiveThreads?: boolean;
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  /** Auto tries WebGPU on Windows and falls back to CPU; direct callers default to CPU. */
  executionProvider?: "auto" | "cpu" | "webgpu";
}

/**
 * A minimal, valid batch (2 rows, length 8, 3 markers, one row per qtype family used here) used
 * to probe a freshly created session before accepting it. Token/marker values are arbitrary
 * (pad id 0, marker positions 1-3) — the graph does not care what they are, only that the shapes
 * are valid and more than one row/qtype is exercised.
 *
 * This only proves the selected provider can execute the graph at all (session creation succeeds and
 * `run()` returns finite-shaped output) for this one shape; it is not a numerical-correctness
 * check. Tokenizer/sequence parity is covered by tests/laya.*.test.ts and real inference by
 * scripts/test-model.ts.
 */
function probeBatch(): Batch {
  return {
    rows: 2,
    length: 8,
    markers: 3,
    inputIds: new BigInt64Array(16).fill(0n),
    attentionMask: new BigInt64Array(16).fill(1n),
    markerPos: BigInt64Array.from([1n, 2n, 3n, 1n, 2n, 3n]),
    markerMask: Uint8Array.from([1, 1, 1, 1, 1, 1]),
    qtype: BigInt64Array.from([0n, 2n]),
  };
}

type Provider = "cpu" | "webgpu";

/** Runs a Laya ONNX graph through a single onnxruntime-node session. */
export class NodeOnnxRunner implements Runner {
  session: ort.InferenceSession;
  readonly intraOpThreads: number;
  provider: Provider;
  private runTail: Promise<void> = Promise.resolve();

  private constructor(
    session: ort.InferenceSession,
    intraOpThreads: number,
    provider: Provider,
    private readonly modelPath: string,
    private readonly graphOptimizationLevel: "disabled" | "basic" | "extended" | "all",
    private readonly autoFallback: boolean,
  ) {
    this.session = session;
    this.intraOpThreads = intraOpThreads;
    this.provider = provider;
  }

  private static sessionOptions(
    provider: Provider,
    intraOpThreads: number,
    graphOptimizationLevel: "disabled" | "basic" | "extended" | "all",
  ): ort.InferenceSession.SessionOptions {
    return {
      executionProviders: [provider],
      intraOpNumThreads: intraOpThreads,
      interOpNumThreads: 1,
      executionMode: "sequential",
      enableMemPattern: provider === "cpu",
      graphOptimizationLevel,
      logSeverityLevel: 3,
    };
  }

  /**
   * Load the graph from a local file path (`model.onnx`). The path form avoids holding a second
   * ~647 MB copy in JS memory: onnxruntime reads the file itself.
   */
  static async create(
    modelPath: string,
    options: NodeRunnerOptions = {},
  ): Promise<NodeOnnxRunner> {
    const preference = options.executionProvider ?? "cpu";
    const providers: Provider[] = preference === "auto"
      ? process.platform === "win32" ? ["webgpu", "cpu"] : ["cpu"]
      : [preference];
    const graphOptimizationLevel = options.graphOptimizationLevel ?? "all";
    let lastError: unknown;
    for (const provider of providers) {
      // WebGPU ignores intraOpNumThreads, so only the CPU branch is worth tuning.
      const intraOpThreads = options.intraOpThreads ??
        (options.adaptiveThreads && provider === "cpu"
          ? await this.selectCpuThreads(modelPath, graphOptimizationLevel)
          : DEFAULT_INTRA_OP_THREADS);
      if (!Number.isInteger(intraOpThreads) || intraOpThreads < 1) {
        throw new Error("intraOpThreads must be a positive integer");
      }
      let session: ort.InferenceSession;
      try {
        session = await ort.InferenceSession.create(
          modelPath, this.sessionOptions(provider, intraOpThreads, graphOptimizationLevel),
        );
      } catch (error) {
        lastError = error;
        continue;
      }
      const runner = new NodeOnnxRunner(
        session, intraOpThreads, provider, modelPath, graphOptimizationLevel, preference === "auto",
      );
      try {
        // Session creation alone does not prove that this graph runs on an execution provider.
        await runner.run(probeBatch());
        return runner;
      } catch (error) {
        lastError = error;
        await runner.dispose().catch(() => {});
      }
    }
    throw new Error(`Laya ONNX session failed its probe batch: ${String(lastError)}`, {
      cause: lastError,
    });
  }

  /**
   * Adaptive CPU thread count. A cached measurement always wins; otherwise startup uses
   * the zero-cost core-count heuristic. Real-shape benchmarking is an explicit one-off
   * (`LAYA_BENCHMARK_THREADS=1` or `NodeOnnxRunner.calibrateCpuThreads`) because a valid
   * measurement takes tens of seconds and a cheap small-shape probe inverts the result.
   */
  private static async selectCpuThreads(
    modelPath: string,
    graphOptimizationLevel: "disabled" | "basic" | "extended" | "all",
  ): Promise<number> {
    const cores = (os.availableParallelism?.() ?? os.cpus().length) || 4;
    const candidates = threadCandidates(cores);
    if (candidates.length < 2) return candidates[0]!;
    const cacheFile = threadCachePath();
    const key = threadCacheKey(modelPath, cores, process.versions.node);
    const cached = readCachedThreads(cacheFile, key, candidates);
    if (cached !== null) return cached;
    if (process.env.LAYA_BENCHMARK_THREADS !== "1") return heuristicThreads(cores);
    const measured = await this.measureCpuThreads(
      modelPath, graphOptimizationLevel, candidates, cacheFile, key);
    return measured.threads;
  }

  /** Explicit one-off calibration; returns the measured latency of every candidate. */
  static async calibrateCpuThreads(
    modelPath: string,
    graphOptimizationLevel: "disabled" | "basic" | "extended" | "all" = "all",
  ): Promise<{ threads: number; samples: ThreadSample[]; cores: number }> {
    const cores = (os.availableParallelism?.() ?? os.cpus().length) || 4;
    const candidates = threadCandidates(cores);
    const cacheFile = threadCachePath();
    const key = threadCacheKey(modelPath, cores, process.versions.node);
    const measured = await this.measureCpuThreads(
      modelPath, graphOptimizationLevel, candidates, cacheFile, key);
    return { ...measured, cores };
  }

  private static async measureCpuThreads(
    modelPath: string,
    graphOptimizationLevel: "disabled" | "basic" | "extended" | "all",
    candidates: number[],
    cacheFile: string,
    key: string,
  ): Promise<{ threads: number; samples: ThreadSample[] }> {
    const samples: ThreadSample[] = [];
    for (const threads of candidates) {
      let runner: NodeOnnxRunner | undefined;
      try {
        const session = await ort.InferenceSession.create(
          modelPath, this.sessionOptions("cpu", threads, graphOptimizationLevel),
        );
        runner = new NodeOnnxRunner(
          session, threads, "cpu", modelPath, graphOptimizationLevel, false,
        );
        const batch = benchmarkBatch();
        await runner.run(batch); // warm up kernels and the ORT memory pattern
        const start = performance.now();
        for (let repeat = 0; repeat < BENCHMARK_REPEATS; repeat++) await runner.run(batch);
        samples.push({ threads, ms: (performance.now() - start) / BENCHMARK_REPEATS });
      } catch {
        // A thread count that cannot create/run a session is simply not a candidate.
      } finally {
        await runner?.dispose().catch(() => {});
      }
    }
    const threads = samples.length ? pickFastest(samples) : DEFAULT_INTRA_OP_THREADS;
    if (samples.length) writeCachedThreads(cacheFile, key, threads, samples);
    return { threads, samples };
  }

  /** Serialize forwards so a provider failure can switch sessions without duplicate writers. */
  run(batch: Batch): Promise<RunnerOutput> {
    const task = this.runTail.then(() => this.runWithFallback(batch));
    this.runTail = task.then(() => {}, () => {});
    return task;
  }

  private async runWithFallback(batch: Batch): Promise<RunnerOutput> {
    try {
      return await this.runOnSession(this.session, batch);
    } catch (error) {
      if (!this.autoFallback || this.provider !== "webgpu") throw error;
      const cpu = await ort.InferenceSession.create(
        this.modelPath,
        NodeOnnxRunner.sessionOptions("cpu", this.intraOpThreads, this.graphOptimizationLevel),
      );
      const previous = this.session;
      this.session = cpu;
      this.provider = "cpu";
      await previous.release().catch(() => {});
      return this.runOnSession(cpu, batch);
    }
  }

  private async runOnSession(session: ort.InferenceSession, batch: Batch): Promise<RunnerOutput> {
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", batch.inputIds, [batch.rows, batch.length]),
      attention_mask: new ort.Tensor("int64", batch.attentionMask, [batch.rows, batch.length]),
      marker_pos: new ort.Tensor("int64", batch.markerPos, [batch.rows, batch.markers]),
      marker_mask: new ort.Tensor("bool", batch.markerMask, [batch.rows, batch.markers]),
      qtype: new ort.Tensor("int64", batch.qtype, [batch.rows]),
    };
    const output = await session.run(feeds);
    const logits = output["logits"];
    const actLogits = output["act_logits"];
    if (!logits || !actLogits) {
      throw new Error("ONNX graph did not return logits/act_logits");
    }
    if (logits.dims[0] !== batch.rows) {
      throw new Error(
        `ONNX graph returned logits for ${logits.dims[0]} rows, expected ${batch.rows}`,
      );
    }
    return {
      rows: batch.rows,
      markers: Number(logits.dims[1]),
      actions: Number(actLogits.dims[1]),
      logits: logits.data as Float32Array,
      actLogits: actLogits.data as Float32Array,
    };
  }

  async dispose(): Promise<void> {
    await this.runTail;
    await this.session.release();
  }
}
