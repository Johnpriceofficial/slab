import { describe, it, expect } from "vitest";
import { aggregate, benchmarkExitCode, breakdownBy, evaluateSample } from "@/lib/benchmark/metrics";
import { buildReport, buildSummaryMarkdown, buildConfidentCertErrorsCsv, buildPerSampleCsv } from "@/lib/benchmark/report";
import { DEFAULT_CONFIG, type BenchmarkConfig, type BenchmarkSample, type SamplePrediction, type PredictedField, type ComparedField, COMPARED_FIELDS } from "@/lib/benchmark/types";

const config: BenchmarkConfig = { ...DEFAULT_CONFIG, project_ref: "test-ref", supabase_url: "https://test-ref.supabase.co" };

function sample(over: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return {
    sample_id: "s", front_image_path: "f.jpg", back_image_path: null,
    grader: "CGC", grade: "10", grade_label: "PRISTINE", certification_number: "01234567",
    card_name: "Mega Dragonite ex", set_name: "Mega Dream ex", card_number: "232/193",
    language: "Japanese", rarity: "Mega Attack Rare", finish: "Holo", variation: "Mega Attack Rare - Holo",
    label_color: "gold", lighting_condition: "studio", orientation: "vertical", notes: "", ...over,
  };
}

function predict(s: BenchmarkSample, over: Partial<Record<ComparedField, PredictedField>> = {}, latency = 100): SamplePrediction {
  const fields = {} as Record<ComparedField, PredictedField>;
  for (const f of COMPARED_FIELDS) {
    const truth = f === "set_name" ? s.set_name : (s[f] as string);
    fields[f] = { value: truth || null, confidence: 0.95, readable: !!truth };
  }
  Object.assign(fields, over);
  return { fields, warnings: [], meta: { status: 200, model: "m", request_id: "r", latency_ms: latency, analysis_run_id: null }, raw: {} };
}

describe("metric aggregation (Requirement 10)", () => {
  it("computes accuracies, latency percentiles, and passes when all correct", () => {
    const samples = [sample({ sample_id: "a" }), sample({ sample_id: "b" })];
    const results = samples.map((s, i) => evaluateSample(s, predict(s, {}, i === 0 ? 100 : 300), config));
    const m = aggregate(results, config);
    expect(m.total_samples).toBe(2);
    expect(m.card_identity_accuracy).toBe(1);
    expect(m.certification_accuracy).toBe(1);
    expect(m.manual_review_rate).toBe(0);
    expect(m.latency_ms.median).not.toBeNull();
    expect(m.passed).toBe(true);
    expect(benchmarkExitCode(m)).toBe(0);
  });

  it("counts a wrong identity as manual review and lowers identity accuracy", () => {
    const s = sample();
    const wrong = predict(s, { card_name: { value: "Blastoise", confidence: 0.9, readable: true } });
    const m = aggregate([evaluateSample(s, wrong, config)], config);
    expect(m.card_identity_accuracy).toBe(0);
    expect(m.manual_review_rate).toBe(1);
    expect(m.false_confidence_rate).toBeGreaterThan(0);
  });

  it("rejects a zero-sample dataset (Requirement 13)", () => {
    expect(() => aggregate([], config)).toThrow(/zero samples/i);
  });
});

describe("certification hard failure (Requirement 9)", () => {
  it("fails the benchmark on a single confidently-incorrect certification", () => {
    const s = sample();
    const badCert = predict(s, { certification_number: { value: "09999999", confidence: 0.99, readable: true } });
    const m = aggregate([evaluateSample(s, badCert, config)], config);
    expect(m.certification.confidently_incorrect).toBe(1);
    expect(m.threshold_results.confident_wrong_certs).toBe(false);
    expect(m.passed).toBe(false);
    expect(benchmarkExitCode(m)).toBe(1);

    const csv = buildConfidentCertErrorsCsv([evaluateSample(s, badCert, config)]);
    expect(csv).toMatch(/09999999/);
  });

  it("does not fail on a safe blank certification", () => {
    const s = sample();
    const blank = predict(s, { certification_number: { value: null, confidence: 0, readable: false } });
    const m = aggregate([evaluateSample(s, blank, config)], config);
    expect(m.certification.blank_unreadable).toBe(1);
    expect(m.threshold_results.confident_wrong_certs).toBe(true);
  });
});

describe("category breakdowns (Requirement 11)", () => {
  it("groups by grader and by English-vs-Japanese", () => {
    const results = [
      evaluateSample(sample({ sample_id: "a", grader: "CGC", language: "Japanese" }), predict(sample({ grader: "CGC", language: "Japanese" })), config),
      evaluateSample(sample({ sample_id: "b", grader: "PSA", language: "English" }), predict(sample({ grader: "PSA", language: "English" })), config),
    ];
    const byGrader = breakdownBy(results, "grader");
    expect(byGrader.map((r) => r.group).sort()).toEqual(["CGC", "PSA"]);
    const byLang = breakdownBy(results, "language_group");
    expect(byLang.map((r) => r.group).sort()).toEqual(["English/Other", "Japanese"]);
  });

  it("groups by front-only vs front+back", () => {
    const results = [
      evaluateSample(sample({ sample_id: "a", back_image_path: null }), predict(sample()), config),
      evaluateSample(sample({ sample_id: "b", back_image_path: "b.jpg" }), predict(sample()), config),
    ];
    expect(breakdownBy(results, "image_set").map((r) => r.group).sort()).toEqual(["front+back", "front-only"]);
  });
});

describe("report generation (Requirement 12)", () => {
  it("builds a markdown summary with pass/fail and a per-sample CSV", () => {
    const s = sample();
    const results = [evaluateSample(s, predict(s), config)];
    const report = buildReport(results, aggregate(results, config), "2026-07-14T00:00:00Z");
    const md = buildSummaryMarkdown(report);
    expect(md).toMatch(/analyze-slab benchmark/);
    expect(md).toMatch(/Result: PASS/);
    expect(md).toMatch(/Confidently incorrect/);
    const csv = buildPerSampleCsv(results);
    expect(csv.split("\n")[0]).toMatch(/sample_id/);
    expect(csv).toMatch(/Mega Dragonite ex/);
  });
});
