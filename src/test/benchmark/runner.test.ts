import { describe, it, expect, vi } from "vitest";
import {
  assertNotProduction,
  runBenchmark,
  withRetry,
  MemoryResumeStore,
  BenchmarkHttpError,
  createFixtureAnalyze,
} from "@/lib/benchmark/runner";
import { DEFAULT_CONFIG, PRODUCTION_PROJECT_REF, type BenchmarkConfig, type BenchmarkSample, type ComparedField, type PredictedField, type SamplePrediction, COMPARED_FIELDS } from "@/lib/benchmark/types";

const noSleep = async () => {};
const config = (over: Partial<BenchmarkConfig> = {}): BenchmarkConfig => ({
  ...DEFAULT_CONFIG,
  concurrency: 1,
  request_delay_ms: 0,
  project_ref: "test-ref",
  supabase_url: "https://test-ref.supabase.co",
  ...over,
});

function sample(id: string): BenchmarkSample {
  return {
    sample_id: id, front_image_path: `${id}.jpg`, back_image_path: null,
    grader: "CGC", grade: "10", grade_label: "PRISTINE", certification_number: "01234567",
    card_name: "Charizard", set_name: "Base Set", card_number: "4/102", language: "English",
    rarity: "Holo Rare", finish: "Holo", variation: "Holo Rare - Holo",
    label_color: "gold", lighting_condition: "studio", orientation: "vertical", notes: "",
  };
}

function correctPrediction(s: BenchmarkSample): SamplePrediction {
  const fields = {} as Record<ComparedField, PredictedField>;
  for (const f of COMPARED_FIELDS) {
    const truth = f === "set_name" ? s.set_name : (s[f] as string);
    fields[f] = { value: truth, confidence: 0.95, readable: true };
  }
  return { fields, warnings: [], meta: { status: 200, model: "m", request_id: `r-${s.sample_id}`, latency_ms: 50, analysis_run_id: null }, raw: { id: s.sample_id } };
}

describe("production refusal (Requirement 3)", () => {
  it("refuses to run against the production project ref", () => {
    expect(() => assertNotProduction({ project_ref: PRODUCTION_PROJECT_REF, supabase_url: "https://x.supabase.co" })).toThrow(/production/i);
  });

  it("refuses when the URL contains the production ref", () => {
    expect(() => assertNotProduction({ project_ref: "test", supabase_url: `https://${PRODUCTION_PROJECT_REF}.supabase.co` })).toThrow(/production/i);
  });

  it("allows a genuine test project", () => {
    expect(() => assertNotProduction({ project_ref: "test-ref", supabase_url: "https://test-ref.supabase.co" })).not.toThrow();
  });

  it("runBenchmark aborts before calling analyze when pointed at production", async () => {
    const analyze = vi.fn();
    await expect(
      runBenchmark([sample("a")], config({ project_ref: PRODUCTION_PROJECT_REF }), { analyze, store: new MemoryResumeStore(), sleep: noSleep }),
    ).rejects.toThrow(/production/i);
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe("retry with bounded backoff (Requirement 5)", () => {
  it("retries a transient 500 then succeeds, with growing delays", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new BenchmarkHttpError(500, "boom");
        return "ok";
      },
      { retries: 3, base_delay_ms: 100, max_delay_ms: 8000, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]); // exponential, bounded
  });

  it("does not retry a non-transient 400", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new BenchmarkHttpError(400, "bad"); }, { retries: 3, base_delay_ms: 1, max_delay_ms: 10, sleep: noSleep }),
    ).rejects.toThrow(/bad/);
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget and records the sample as failed", async () => {
    const analyze = vi.fn(async () => { throw new BenchmarkHttpError(503, "unavailable"); });
    const out = await runBenchmark([sample("a"), sample("b")], config({ retry: { retries: 1, base_delay_ms: 0, max_delay_ms: 0 } }), {
      analyze, store: new MemoryResumeStore(), sleep: noSleep,
    });
    expect(out.failed).toHaveLength(2);
    expect(analyze).toHaveBeenCalledTimes(4); // 2 samples × (1 + 1 retry)
  });
});

describe("resume behavior (Requirement 4)", () => {
  it("skips samples already in the store and reuses their results", async () => {
    const store = new MemoryResumeStore();
    const analyze = vi.fn(async (s: BenchmarkSample) => correctPrediction(s));

    // First run completes sample "a".
    await runBenchmark([sample("a")], config(), { analyze, store, sleep: noSleep });
    expect(analyze).toHaveBeenCalledTimes(1);

    // Resumed run over [a, b] must only call analyze for the NEW sample "b".
    analyze.mockClear();
    const out = await runBenchmark([sample("a"), sample("b")], config(), { analyze, store, sleep: noSleep });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ sample_id: "b" }));
    expect(out.resumed).toBe(1);
    expect(out.completed).toBe(1);
    expect(out.results).toHaveLength(2);
  });
});

describe("end-to-end via dry-run fixtures (Requirement 8 / no OpenAI)", () => {
  it("runs the full pipeline deterministically and passes when all correct", async () => {
    const samples = [sample("a"), sample("b")];
    const fixtures = Object.fromEntries(samples.map((s) => [s.sample_id, correctPrediction(s)]));
    const out = await runBenchmark(samples, config(), { analyze: createFixtureAnalyze(fixtures), store: new MemoryResumeStore(), sleep: noSleep });
    expect(out.metrics!.passed).toBe(true);
    expect(out.metrics!.total_samples).toBe(2);
    expect(out.failed).toEqual([]);
  });
});
