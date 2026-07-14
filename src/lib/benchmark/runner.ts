/**
 * Benchmark orchestration: production refusal, bounded-backoff retry, bounded
 * concurrency + request delay, and safe resume. Pure — every side effect (the
 * model call, the resume store, sleeping) is injected, so the control flow is
 * unit tested with in-memory fakes and never calls OpenAI in CI.
 */

import { aggregate, evaluateSample, type BenchmarkMetrics } from "./metrics";
import {
  PRODUCTION_PROJECT_REF,
  type BenchmarkConfig,
  type BenchmarkSample,
  type SamplePrediction,
  type SampleResult,
} from "./types";

/** Persists completed samples so an interrupted run resumes without repeats. */
export interface ResumeStore {
  has(sampleId: string): boolean;
  get(sampleId: string): SampleResult | undefined;
  put(result: SampleResult, prediction: SamplePrediction): void;
}

/** In-memory resume store (tests; the CLI provides an fs-backed one). */
export class MemoryResumeStore implements ResumeStore {
  private map = new Map<string, SampleResult>();
  has(id: string) {
    return this.map.has(id);
  }
  get(id: string) {
    return this.map.get(id);
  }
  put(result: SampleResult) {
    this.map.set(result.sample_id, result);
  }
}

export interface RunnerDeps {
  /** Calls the deployed analyze-slab Edge Function for one sample. */
  analyze: (sample: BenchmarkSample) => Promise<SamplePrediction>;
  store: ResumeStore;
  sleep: (ms: number) => Promise<void>;
  onProgress?: (info: { sample_id: string; index: number; total: number; resumed: boolean; error?: string }) => void;
}

/** Refuse to run against the production project — by ref OR by URL. */
export function assertNotProduction(config: Pick<BenchmarkConfig, "project_ref" | "supabase_url">): void {
  const ref = config.project_ref.trim();
  if (ref === PRODUCTION_PROJECT_REF || config.supabase_url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `Refusing to run the benchmark against the production project (${PRODUCTION_PROJECT_REF}). ` +
        "Point SUPABASE_URL / project ref at a dedicated test project.",
    );
  }
  if (!ref) throw new Error("A target project_ref is required.");
}

function isTransient(error: unknown): boolean {
  if (error instanceof BenchmarkHttpError) return error.status === 429 || error.status >= 500;
  return true; // network/timeout errors are transient
}

/** An analyze() implementation may throw this to signal an HTTP status. */
export class BenchmarkHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BenchmarkHttpError";
  }
}

/** Retry `fn` with bounded exponential backoff on transient failures only. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; base_delay_ms: number; max_delay_ms: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= opts.retries || !isTransient(error)) throw error;
      const delay = Math.min(opts.max_delay_ms, opts.base_delay_ms * 2 ** attempt);
      await opts.sleep(delay);
      attempt += 1;
    }
  }
}

export interface RunOutcome {
  results: SampleResult[];
  /** null when EVERY sample failed to analyze — there is nothing to score. */
  metrics: BenchmarkMetrics | null;
  completed: number;
  resumed: number;
  failed: Array<{ sample_id: string; error: string }>;
}

/**
 * Run the benchmark over `samples`, honoring concurrency, per-request delay,
 * retry, and resume. Completed samples in the store are reused, not re-called.
 */
export async function runBenchmark(
  samples: BenchmarkSample[],
  config: BenchmarkConfig,
  deps: RunnerDeps,
): Promise<RunOutcome> {
  assertNotProduction(config);
  if (samples.length === 0) throw new Error("Cannot benchmark: the dataset has zero samples.");

  const results: (SampleResult | undefined)[] = new Array(samples.length);
  const failed: Array<{ sample_id: string; error: string }> = [];
  let resumed = 0;
  let completed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= samples.length) return;
      const sample = samples[index];

      if (deps.store.has(sample.sample_id)) {
        const cached = deps.store.get(sample.sample_id);
        if (cached) {
          results[index] = cached;
          resumed += 1;
          deps.onProgress?.({ sample_id: sample.sample_id, index, total: samples.length, resumed: true });
          continue;
        }
      }

      try {
        const prediction = await withRetry(() => deps.analyze(sample), { ...config.retry, sleep: deps.sleep });
        const result = evaluateSample(sample, prediction, config);
        deps.store.put(result, prediction);
        results[index] = result;
        completed += 1;
        deps.onProgress?.({ sample_id: sample.sample_id, index, total: samples.length, resumed: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ sample_id: sample.sample_id, error: message });
        deps.onProgress?.({ sample_id: sample.sample_id, index, total: samples.length, resumed: false, error: message });
      }

      if (config.request_delay_ms > 0) await deps.sleep(config.request_delay_ms);
    }
  };

  const workerCount = Math.max(1, Math.min(config.concurrency, samples.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  const ordered = results.filter((r): r is SampleResult => r !== undefined);
  const metrics = ordered.length > 0 ? aggregate(ordered, config) : null;
  return { results: ordered, metrics, completed, resumed, failed };
}

/**
 * A deterministic analyze() backed by a fixture map (sample_id -> prediction).
 * Powers CI's dry-run mode and the runner tests — no network, no OpenAI.
 */
export function createFixtureAnalyze(
  fixtures: Record<string, SamplePrediction>,
): (sample: BenchmarkSample) => Promise<SamplePrediction> {
  return async (sample) => {
    const fixture = fixtures[sample.sample_id];
    if (!fixture) throw new Error(`No dry-run fixture for sample "${sample.sample_id}".`);
    return fixture;
  };
}
