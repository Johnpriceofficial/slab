/**
 * Per-sample evaluation, dataset-level metric aggregation, category breakdowns,
 * and threshold gating. All pure.
 */

import { classifyCertification, compareField } from "./compare";
import {
  BREAKDOWN_KEYS,
  COMPARED_FIELDS,
  IDENTITY_FIELDS,
  type BenchmarkConfig,
  type BenchmarkSample,
  type BreakdownKey,
  type ComparedField,
  type FieldOutcome,
  type SamplePrediction,
  type SampleResult,
} from "./types";

/** Evaluate one sample's prediction against its ground truth. */
export function evaluateSample(
  sample: BenchmarkSample,
  prediction: SamplePrediction,
  config: BenchmarkConfig,
): SampleResult {
  const fields = {} as Record<ComparedField, FieldOutcome>;
  for (const field of COMPARED_FIELDS) {
    fields[field] = compareField(field, prediction.fields[field], sample[field], config.acceptance_threshold);
  }

  const identity_correct = IDENTITY_FIELDS.every((f) => !fields[f].evaluable || fields[f].match);
  const grade_correct = !fields.grade.evaluable || fields.grade.match;
  const evaluableFields = COMPARED_FIELDS.filter((f) => fields[f].evaluable);
  const needs_manual_review = evaluableFields.some((f) => !fields[f].match);
  const unreadable_count = evaluableFields.filter((f) => fields[f].blank).length;

  return {
    sample_id: sample.sample_id,
    fields,
    certification_class: classifyCertification(prediction.fields.certification_number, sample.certification_number, config.acceptance_threshold),
    identity_correct,
    grade_correct,
    needs_manual_review,
    unreadable_count,
    latency_ms: prediction.meta.latency_ms,
    status: prediction.meta.status,
    model: prediction.meta.model,
    request_id: prediction.meta.request_id,
    sample,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function fieldAccuracy(results: SampleResult[], field: ComparedField): { accuracy: number; evaluable: number; correct: number } {
  const evaluable = results.filter((r) => r.fields[field].evaluable);
  const correct = evaluable.filter((r) => r.fields[field].match).length;
  return { accuracy: ratio(correct, evaluable.length), evaluable: evaluable.length, correct };
}

function percentile(values: number[], p: number): number | null {
  const nums = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

export interface CertificationReport {
  correct: number;
  blank_unreadable: number;
  incorrect: number;
  confidently_incorrect: number;
}

export interface BenchmarkMetrics {
  total_samples: number;
  field_accuracy: Record<ComparedField, { accuracy: number; evaluable: number; correct: number }>;
  card_identity_accuracy: number;
  grade_accuracy: number;
  certification_accuracy: number;
  certification: CertificationReport;
  average_field_confidence: number;
  latency_ms: { median: number | null; p95: number | null };
  manual_review_rate: number;
  unreadable_field_rate: number;
  false_confidence_rate: number;
  thresholds: BenchmarkConfig["thresholds"];
  threshold_results: {
    card_identity_accuracy: boolean;
    grade_accuracy: boolean;
    certification_accuracy: boolean;
    confident_wrong_certs: boolean;
    manual_review_rate: boolean;
  };
  passed: boolean;
}

/**
 * Aggregate per-sample results into dataset metrics and threshold gates.
 * Rejects an empty dataset — a benchmark over zero samples proves nothing.
 */
export function aggregate(results: SampleResult[], config: BenchmarkConfig): BenchmarkMetrics {
  if (results.length === 0) {
    throw new Error("Cannot benchmark: the dataset has zero samples.");
  }

  const field_accuracy = {} as BenchmarkMetrics["field_accuracy"];
  for (const field of COMPARED_FIELDS) field_accuracy[field] = fieldAccuracy(results, field);

  const identityEvaluable = results.filter((r) => IDENTITY_FIELDS.some((f) => r.fields[f].evaluable));
  const card_identity_accuracy = ratio(identityEvaluable.filter((r) => r.identity_correct).length, identityEvaluable.length);

  const grade = field_accuracy.grade;
  const cert = field_accuracy.certification_number;

  const certification: CertificationReport = { correct: 0, blank_unreadable: 0, incorrect: 0, confidently_incorrect: 0 };
  for (const r of results) certification[r.certification_class] += 1;

  // Confidence averaged over readable predicted cells across all fields.
  const confidences: number[] = [];
  let evaluableCells = 0;
  let blankCells = 0;
  let falseConfidenceCells = 0;
  for (const r of results) {
    for (const field of COMPARED_FIELDS) {
      const f = r.fields[field];
      if (!f.evaluable) continue;
      evaluableCells += 1;
      if (f.blank) blankCells += 1;
      else confidences.push(f.confidence);
      if (f.false_confidence) falseConfidenceCells += 1;
    }
  }

  const latencies = results.map((r) => r.latency_ms).filter((v): v is number => typeof v === "number");

  const metrics: Omit<BenchmarkMetrics, "threshold_results" | "passed"> = {
    total_samples: results.length,
    field_accuracy,
    card_identity_accuracy,
    grade_accuracy: grade.accuracy,
    certification_accuracy: cert.accuracy,
    certification,
    average_field_confidence: ratio(confidences.reduce((a, b) => a + b, 0), confidences.length),
    latency_ms: { median: percentile(latencies, 50), p95: percentile(latencies, 95) },
    manual_review_rate: ratio(results.filter((r) => r.needs_manual_review).length, results.length),
    unreadable_field_rate: ratio(blankCells, evaluableCells),
    false_confidence_rate: ratio(falseConfidenceCells, evaluableCells),
    thresholds: config.thresholds,
  };

  const t = config.thresholds;
  const threshold_results = {
    card_identity_accuracy: metrics.card_identity_accuracy >= t.card_identity_accuracy,
    grade_accuracy: metrics.grade_accuracy >= t.grade_accuracy,
    certification_accuracy: metrics.certification_accuracy >= t.certification_accuracy,
    // A single confidently-incorrect certification fails, regardless of the max.
    confident_wrong_certs: certification.confidently_incorrect <= t.max_confident_wrong_certs,
    manual_review_rate: metrics.manual_review_rate <= t.manual_review_rate,
  };
  const passed = Object.values(threshold_results).every(Boolean);

  return { ...metrics, threshold_results, passed };
}

/** Process exit code: non-zero whenever the benchmark did not pass every gate. */
export function benchmarkExitCode(metrics: BenchmarkMetrics): number {
  return metrics.passed ? 0 : 1;
}

export interface BreakdownRow {
  key: BreakdownKey;
  group: string;
  samples: number;
  card_identity_accuracy: number;
  grade_accuracy: number;
  certification_correct: number;
  certification_incorrect: number;
  certification_confidently_incorrect: number;
  manual_review_rate: number;
}

function groupValue(result: SampleResult, key: BreakdownKey): string {
  const s = result.sample;
  switch (key) {
    case "language_group":
      return /^(japanese|jp|ja)$/i.test(s.language.trim()) ? "Japanese" : "English/Other";
    case "image_set":
      return s.back_image_path ? "front+back" : "front-only";
    case "glare":
      return s.glare ?? "unspecified";
    case "blur":
      return s.blur ?? "unspecified";
    case "crop_quality":
      return s.crop_quality ?? "unspecified";
    default:
      return (s[key as keyof BenchmarkSample] as string)?.trim() || "unspecified";
  }
}

/** Metrics grouped by one category key. */
export function breakdownBy(results: SampleResult[], key: BreakdownKey): BreakdownRow[] {
  const groups = new Map<string, SampleResult[]>();
  for (const r of results) {
    const g = groupValue(r, key);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(r);
  }
  return [...groups.entries()]
    .map(([group, rows]) => {
      const identityEvaluable = rows.filter((r) => IDENTITY_FIELDS.some((f) => r.fields[f].evaluable));
      const cert = { correct: 0, incorrect: 0, confidently_incorrect: 0 };
      for (const r of rows) {
        if (r.certification_class === "correct") cert.correct += 1;
        else if (r.certification_class === "incorrect") cert.incorrect += 1;
        else if (r.certification_class === "confidently_incorrect") cert.confidently_incorrect += 1;
      }
      return {
        key,
        group,
        samples: rows.length,
        card_identity_accuracy: ratio(identityEvaluable.filter((r) => r.identity_correct).length, identityEvaluable.length),
        grade_accuracy: fieldAccuracy(rows, "grade").accuracy,
        certification_correct: cert.correct,
        certification_incorrect: cert.incorrect,
        certification_confidently_incorrect: cert.confidently_incorrect,
        manual_review_rate: ratio(rows.filter((r) => r.needs_manual_review).length, rows.length),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** All configured breakdowns keyed by category. */
export function allBreakdowns(results: SampleResult[]): Record<BreakdownKey, BreakdownRow[]> {
  const out = {} as Record<BreakdownKey, BreakdownRow[]>;
  for (const key of BREAKDOWN_KEYS) out[key] = breakdownBy(results, key);
  return out;
}
