import { describe, it, expect } from "vitest";
import { classifyProductMatch } from "@/lib/benchmark/compare";
import { aggregate, evaluateSample } from "@/lib/benchmark/metrics";
import { buildReport, buildSummaryMarkdown } from "@/lib/benchmark/report";
import {
  DEFAULT_CONFIG,
  COMPARED_FIELDS,
  type BenchmarkConfig,
  type BenchmarkSample,
  type ComparedField,
  type MatchPrediction,
  type PredictedField,
  type SamplePrediction,
} from "@/lib/benchmark/types";

const config: BenchmarkConfig = { ...DEFAULT_CONFIG, project_ref: "test-ref", supabase_url: "https://test-ref.supabase.co" };

function sample(over: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return {
    sample_id: "s", front_image_path: "f.jpg", back_image_path: null,
    grader: "PSA", grade: "10", grade_label: "GEM MINT", certification_number: "01234567",
    card_name: "Charizard", set_name: "Base Set", card_number: "4/102",
    language: "English", rarity: "Holo Rare", finish: "Holo", variation: "",
    label_color: "red", lighting_condition: "studio", orientation: "vertical", notes: "", ...over,
  };
}

/** All OCR fields correct; attach a product match. */
function predict(s: BenchmarkSample, match: MatchPrediction | null | undefined): SamplePrediction {
  const fields = {} as Record<ComparedField, PredictedField>;
  for (const f of COMPARED_FIELDS) {
    const truth = f === "set_name" ? s.set_name : (s[f] as string);
    fields[f] = { value: truth || null, confidence: 0.95, readable: !!truth };
  }
  return { fields, warnings: [], meta: { status: 200, model: "m", request_id: "r", latency_ms: 100, analysis_run_id: null }, raw: {}, match };
}

const confirmed = (id: string | null): MatchPrediction => ({ pricecharting_id: id, confidence: 96, status: "confirmed" });
const abstain = (): MatchPrediction => ({ pricecharting_id: null, confidence: 40, status: "manual_review" });

describe("classifyProductMatch", () => {
  it("unknown truth id is unjudgeable, never wrong", () => {
    expect(classifyProductMatch(undefined, confirmed("pc-9"))).toBe("unjudgeable");
    expect(classifyProductMatch("", confirmed("pc-9"))).toBe("unjudgeable");
  });
  it("confirmed correct id is match_correct", () => {
    expect(classifyProductMatch("pc-1", confirmed("pc-1"))).toBe("match_correct");
  });
  it("confirmed WRONG id is false_confident (the dangerous case)", () => {
    expect(classifyProductMatch("pc-1", confirmed("pc-2"))).toBe("false_confident");
  });
  it("wrong id without confirmation is match_wrong", () => {
    expect(classifyProductMatch("pc-1", { pricecharting_id: "pc-2", confidence: 55, status: "manual_review" })).toBe("match_wrong");
  });
  it("abstaining (null id) is match_abstained", () => {
    expect(classifyProductMatch("pc-1", abstain())).toBe("match_abstained");
    expect(classifyProductMatch("pc-1", null)).toBe("match_abstained");
  });
});

describe("aggregate — product match dimension", () => {
  it("scores accuracy and passes when confirmed-correct", () => {
    const s1 = sample({ sample_id: "a", pricecharting_product_id: "pc-a" });
    const s2 = sample({ sample_id: "b", pricecharting_product_id: "pc-b" });
    const results = [evaluateSample(s1, predict(s1, confirmed("pc-a")), config), evaluateSample(s2, predict(s2, confirmed("pc-b")), config)];
    const m = aggregate(results, config);
    expect(m.product_match).not.toBeNull();
    expect(m.product_match!.judgeable).toBe(2);
    expect(m.product_match!.accuracy).toBe(1);
    expect(m.product_match!.false_confident).toBe(0);
    expect(m.threshold_results.product_match_accuracy).toBe(true);
    expect(m.threshold_results.confident_wrong_matches).toBe(true);
    expect(m.passed).toBe(true);
  });

  it("a single confidently-wrong match fails the benchmark", () => {
    const s = sample({ pricecharting_product_id: "pc-right" });
    const m = aggregate([evaluateSample(s, predict(s, confirmed("pc-WRONG")), config)], config);
    expect(m.product_match!.false_confident).toBe(1);
    expect(m.product_match!.false_confident_rate).toBe(1);
    expect(m.threshold_results.confident_wrong_matches).toBe(false);
    expect(m.passed).toBe(false);
  });

  it("an abstained match lowers accuracy but is not a confident error", () => {
    const s = sample({ pricecharting_product_id: "pc-1" });
    const m = aggregate([evaluateSample(s, predict(s, abstain()), config)], config);
    expect(m.product_match!.accuracy).toBe(0);
    expect(m.product_match!.abstained).toBe(1);
    expect(m.product_match!.false_confident).toBe(0);
    expect(m.threshold_results.confident_wrong_matches).toBe(true); // abstention is safe
    expect(m.threshold_results.product_match_accuracy).toBe(false); // but 0% accuracy fails the acc gate
  });

  it("is VACUOUSLY passing when no sample carries a truth product id", () => {
    const s = sample(); // no pricecharting_product_id
    const m = aggregate([evaluateSample(s, predict(s, confirmed("pc-anything")), config)], config);
    expect(m.product_match).toBeNull();
    expect(m.threshold_results.product_match_accuracy).toBe(true);
    expect(m.threshold_results.confident_wrong_matches).toBe(true);
    expect(m.passed).toBe(true); // OCR all correct, match not measured
  });
});

describe("report — product match section", () => {
  it("renders the match section and gate rows when measured", () => {
    const s = sample({ pricecharting_product_id: "pc-1" });
    const results = [evaluateSample(s, predict(s, confirmed("pc-1")), config)];
    const md = buildSummaryMarkdown(buildReport(results, aggregate(results, config), "2026-07-21T00:00:00Z"));
    expect(md).toMatch(/PriceCharting product match/);
    expect(md).toMatch(/PriceCharting match accuracy/);
    expect(md).toMatch(/Confidently wrong matches/);
  });

  it("says 'Not measured' when no truth product id is present", () => {
    const s = sample();
    const results = [evaluateSample(s, predict(s, null), config)];
    const md = buildSummaryMarkdown(buildReport(results, aggregate(results, config), "2026-07-21T00:00:00Z"));
    expect(md).toMatch(/PriceCharting product match/);
    expect(md).toMatch(/Not measured/);
  });
});
