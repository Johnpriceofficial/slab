/**
 * Types for the analyze-slab accuracy benchmark.
 *
 * All benchmark LOGIC lives under src/lib/benchmark (pure, typechecked, unit
 * tested — no node/Deno/Supabase imports). The Node CLI that reads files, calls
 * the deployed Edge Function, and writes reports lives in scripts/benchmark and
 * only wires these pure pieces to real I/O.
 */

/** The fields compared against ground truth. Keys are the manifest column names. */
export const COMPARED_FIELDS = [
  "grader",
  "grade",
  "grade_label",
  "certification_number",
  "card_name",
  "set_name",
  "card_number",
  "language",
  "rarity",
  "finish",
  "variation",
] as const;

export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** Fields whose exact agreement defines a correct CARD IDENTITY (vs grade/cert). */
export const IDENTITY_FIELDS: readonly ComparedField[] = ["card_name", "set_name", "card_number", "language"];

/** Category columns used for grouped breakdowns (optional in the manifest). */
export const BREAKDOWN_KEYS = [
  "grader",
  "label_color",
  "language_group",
  "lighting_condition",
  "orientation",
  "image_set",
  "glare",
  "blur",
  "crop_quality",
] as const;

export type BreakdownKey = (typeof BREAKDOWN_KEYS)[number];

/** One row of the dataset manifest (ground truth + capture conditions). */
export interface BenchmarkSample {
  sample_id: string;
  front_image_path: string;
  back_image_path: string | null;
  grader: string;
  grade: string;
  grade_label: string;
  certification_number: string;
  card_name: string;
  set_name: string;
  card_number: string;
  language: string;
  rarity: string;
  finish: string;
  variation: string;
  label_color: string;
  lighting_condition: string;
  orientation: string;
  notes: string;
  /** Optional capture-quality columns; absent → "unspecified" in breakdowns. */
  glare?: string;
  blur?: string;
  crop_quality?: string;
  /**
   * Expected PriceCharting product id, WHEN KNOWN. Absent/blank → the product
   * match is "unjudgeable" for this sample (excluded from match accuracy, never
   * scored as wrong). This is truth for the product-match dimension, which is
   * separate from the analyze-slab OCR fields above.
   */
  pricecharting_product_id?: string;
}

export interface PredictedField {
  value: string | null;
  confidence: number;
  readable: boolean;
}

/** Whether the matcher auto-confirmed a product, punted to review, or gave up. */
export type MatchStatus = "confirmed" | "manual_review" | "unresolved";

/**
 * The PriceCharting product the pipeline selected for a sample. `null` id means
 * the matcher abstained (nothing confident enough). Produced by the LIVE runner
 * from the production matcher; supplied directly by dry-run fixtures.
 */
export interface MatchPrediction {
  pricecharting_id: string | null;
  /** Matcher confidence (0–100), or null when it abstained. */
  confidence: number | null;
  status: MatchStatus;
}

/** The model's reading of one sample, decoupled from the AnalyzeResult shape. */
export interface SamplePrediction {
  fields: Record<ComparedField, PredictedField>;
  warnings: string[];
  meta: {
    status: number;
    model: string | null;
    request_id: string | null;
    latency_ms: number | null;
    analysis_run_id: string | null;
  };
  /** The untouched provider response, preserved verbatim for audit. */
  raw: unknown;
  /**
   * The product match, when the run scored the PriceCharting dimension. Absent
   * when only OCR accuracy was measured — the sample is then match-unjudgeable.
   */
  match?: MatchPrediction | null;
}

/**
 * How the product match came out for one sample:
 *   match_correct    — truth id known, pred id equals it
 *   false_confident  — truth id known, matcher CONFIRMED a DIFFERENT id (dangerous)
 *   match_wrong      — truth id known, pred produced a wrong id without confirming
 *   match_abstained  — truth id known, matcher abstained (null id → review/unresolved)
 *   unjudgeable      — truth id unknown, correctness cannot be judged
 */
export type MatchClass = "match_correct" | "false_confident" | "match_wrong" | "match_abstained" | "unjudgeable";

export type CertClass = "correct" | "blank_unreadable" | "incorrect" | "confidently_incorrect";

export interface FieldOutcome {
  field: ComparedField;
  predicted: string | null;
  truth: string;
  confidence: number;
  /** Ground truth is present, so the field can be scored. */
  evaluable: boolean;
  /** Prediction was blank/unreadable. */
  blank: boolean;
  /** Byte-identical after trim. */
  exact: boolean;
  /** Equal after field-appropriate, digit-preserving normalization. */
  match: boolean;
  /** Incorrect AND confidence at/above the acceptance threshold. */
  false_confidence: boolean;
}

export interface SampleResult {
  sample_id: string;
  fields: Record<ComparedField, FieldOutcome>;
  certification_class: CertClass;
  identity_correct: boolean;
  grade_correct: boolean;
  needs_manual_review: boolean;
  unreadable_count: number;
  /** PriceCharting product-match outcome ("unjudgeable" when no truth id). */
  match_outcome: MatchClass;
  latency_ms: number | null;
  status: number;
  model: string | null;
  request_id: string | null;
  /** Capture conditions carried through for breakdowns. */
  sample: BenchmarkSample;
}

export interface BenchmarkThresholds {
  card_identity_accuracy: number;
  grade_accuracy: number;
  certification_accuracy: number;
  max_confident_wrong_certs: number;
  manual_review_rate: number;
  /** Min product-match accuracy over JUDGEABLE samples (truth id known). */
  product_match_accuracy: number;
  /** Max samples where the matcher CONFIRMED a wrong product. 0 = any is a fail. */
  max_confident_wrong_matches: number;
}

export const DEFAULT_THRESHOLDS: BenchmarkThresholds = {
  card_identity_accuracy: 0.99,
  grade_accuracy: 0.995,
  certification_accuracy: 0.999,
  max_confident_wrong_certs: 0,
  manual_review_rate: 0.05,
  product_match_accuracy: 0.95,
  max_confident_wrong_matches: 0,
};

export interface BenchmarkConfig {
  /** A prediction whose confidence is >= this is treated as "accepted". */
  acceptance_threshold: number;
  thresholds: BenchmarkThresholds;
  concurrency: number;
  request_delay_ms: number;
  retry: { retries: number; base_delay_ms: number; max_delay_ms: number };
  /** Supabase project the run targets — used to refuse production. */
  project_ref: string;
  supabase_url: string;
}

export const DEFAULT_CONFIG: Omit<BenchmarkConfig, "project_ref" | "supabase_url"> = {
  acceptance_threshold: 0.7,
  thresholds: DEFAULT_THRESHOLDS,
  concurrency: 2,
  request_delay_ms: 350,
  retry: { retries: 3, base_delay_ms: 500, max_delay_ms: 8000 },
};

/** The production project ref the benchmark must NEVER run against. */
export const PRODUCTION_PROJECT_REF = "rcbwemkfcefarqnlgrmv";
