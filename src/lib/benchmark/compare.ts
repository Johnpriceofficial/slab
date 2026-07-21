/**
 * Field comparison and certification safety.
 *
 * Comparison is digit-preserving: certification numbers are compared after
 * removing PERMITTED SEPARATORS ONLY (via normalizeCertification) — an uncertain
 * digit is never "corrected" to make a match. This mirrors the production rule
 * so the benchmark measures the same behavior the app ships.
 */

import {
  COMPARED_FIELDS,
  type CertClass,
  type ComparedField,
  type FieldOutcome,
  type MatchClass,
  type MatchPrediction,
  type PredictedField,
  type SamplePrediction,
} from "./types";

/**
 * The benchmark measures the DEPLOYED analyze-slab function's JSON output, so it
 * deliberately depends on nothing in the app's client code — the normalization
 * helpers below are self-contained and digit-preserving. (They mirror the
 * production rules but are duplicated here on purpose, exactly like the Edge
 * bundle duplicates them, so the harness runs regardless of which client changes
 * are merged.)
 */

/** The minimal shape the harness reads from an analyze-slab success response. */
export interface AnalyzeResponseBody {
  status?: string;
  warnings?: string[];
  proposed: Record<string, { value: string | null; confidence: number; readable: boolean } | undefined>;
}

/** Remove spaces/punctuation ONLY — digits are never replaced (cert safety). */
export function normalizeCertification(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^0-9A-Za-z]/g, "");
}

/** Extract the numeric grade token ("PRISTINE 10" -> "10", "9.5" -> "9.5"). */
export function numericGrade(raw: string | null | undefined): string {
  const m = (raw ?? "").trim().match(/(?<![\d.])\d{1,2}(?:\.\d)?(?![\d.])/);
  return m ? m[0] : (raw ?? "").trim();
}

const GRADER_ALIASES: Record<string, string> = {
  cgc: "CGC", psa: "PSA", bgs: "BGS", beckett: "BGS", sgc: "SGC", ags: "AGS",
};

/** Canonicalize a grader to CGC/PSA/BGS/SGC/AGS (unknown preserved). */
export function normalizeGrader(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  const key = text.toLowerCase().replace(/[.\s]+/g, " ").trim();
  return GRADER_ALIASES[key] ?? text;
}

/** Generic text normalization for comparison (never applied to certifications). */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,]+$/g, "");
}

/**
 * Canonicalize a card number for comparison: keep alphanumerics, drop leading
 * zeros per slash-separated part so "016/064" === "16/64". Digits are preserved,
 * never substituted.
 */
export function canonicalizeCardNumber(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, ""))
    .join("/");
}

/** Normalize one field's value for equality, dispatching per field. */
export function normalizeForCompare(field: ComparedField, value: string): string {
  switch (field) {
    case "certification_number":
      return normalizeCertification(value); // separators only — digits untouched
    case "grader":
      return normalizeGrader(value).toLowerCase();
    case "grade":
      // Compare the numeric grade only ("10" === "10.0"); designation is graded
      // separately as grade_label.
      return String(Number(numericGrade(value)));
    case "card_number":
      return canonicalizeCardNumber(value);
    default:
      return normalizeText(value);
  }
}

const readValue = (f: PredictedField | undefined): string | null =>
  f && f.readable && f.value !== null && f.value !== "" ? f.value : null;

/**
 * Compare one predicted field against ground truth. A field with no ground truth
 * is not evaluable (excluded from accuracy). A blank prediction is evaluable and
 * counts as incorrect, but is never a false-confidence hit.
 */
export function compareField(
  field: ComparedField,
  predicted: PredictedField | undefined,
  truth: string,
  acceptanceThreshold: number,
): FieldOutcome {
  const truthTrim = (truth ?? "").trim();
  const predValue = readValue(predicted);
  const confidence = predicted?.readable ? predicted.confidence : 0;

  if (truthTrim === "") {
    return { field, predicted: predValue, truth: truthTrim, confidence, evaluable: false, blank: predValue === null, exact: false, match: false, false_confidence: false };
  }
  if (predValue === null) {
    return { field, predicted: null, truth: truthTrim, confidence: 0, evaluable: true, blank: true, exact: false, match: false, false_confidence: false };
  }

  const exact = predValue.trim() === truthTrim;
  const match = exact || normalizeForCompare(field, predValue) === normalizeForCompare(field, truthTrim);
  return {
    field,
    predicted: predValue,
    truth: truthTrim,
    confidence,
    evaluable: true,
    blank: false,
    exact,
    match,
    false_confidence: !match && confidence >= acceptanceThreshold,
  };
}

/**
 * Classify a certification reading for the safety report:
 *   correct              — matches after separator-only normalization
 *   blank_unreadable     — nothing was returned (the safe non-answer)
 *   incorrect            — wrong, but below the acceptance threshold
 *   confidently_incorrect— wrong AND at/above the acceptance threshold (a hard fail)
 */
export function classifyCertification(
  predicted: PredictedField | undefined,
  truth: string,
  acceptanceThreshold: number,
): CertClass {
  const predValue = readValue(predicted);
  if ((truth ?? "").trim() === "") return predValue === null ? "blank_unreadable" : "correct";
  if (predValue === null) return "blank_unreadable";
  if (normalizeCertification(predValue) === normalizeCertification(truth)) return "correct";
  const confidence = predicted?.readable ? predicted.confidence : 0;
  return confidence >= acceptanceThreshold ? "confidently_incorrect" : "incorrect";
}

/**
 * Classify the PriceCharting product match for one sample. Correctness is only
 * judgeable when the TRUTH product id is known; otherwise `unjudgeable` (never
 * silently "wrong"). A CONFIRMED wrong id is `false_confident` — the dangerous
 * case, kept distinct from an honest abstention. `truthId`/predicted ids are
 * compared verbatim (PriceCharting ids are opaque, canonical tokens).
 */
export function classifyProductMatch(
  truthId: string | null | undefined,
  match: MatchPrediction | null | undefined,
): MatchClass {
  const truth = (truthId ?? "").trim();
  if (truth === "") return "unjudgeable";
  const predId = match?.pricecharting_id ?? null;
  if (predId !== null && predId === truth) return "match_correct";
  if (match?.status === "confirmed" && predId !== null) return "false_confident";
  if (predId !== null) return "match_wrong";
  return "match_abstained";
}

/**
 * Adapt an analyze-slab response body into the benchmark's field map. Maps the
 * proposal key `set` to the manifest column `set_name`; a field the deployed
 * function doesn't return (e.g. `finish` before that change ships) defaults to
 * blank, so the harness works against any version of the function.
 */
export function extractPrediction(body: AnalyzeResponseBody): Record<ComparedField, PredictedField> {
  const fields = {} as Record<ComparedField, PredictedField>;
  const proposed = body.proposed ?? {};
  for (const field of COMPARED_FIELDS) {
    const proposalKey = field === "set_name" ? "set" : field;
    const p = proposed[proposalKey];
    fields[field] = p
      ? { value: p.value, confidence: p.confidence, readable: p.readable }
      : { value: null, confidence: 0, readable: false };
  }
  return fields;
}

/** Build a SamplePrediction from an analyze-slab body and transport metadata. */
export function predictionFromAnalyze(
  body: AnalyzeResponseBody,
  meta: SamplePrediction["meta"],
): SamplePrediction {
  return { fields: extractPrediction(body), warnings: body.warnings ?? [], meta, raw: body };
}
