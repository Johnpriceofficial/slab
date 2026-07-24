import { ANALYZE_FIELD_KEYS, type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";
import { reconcileIdentity } from "@/lib/slabs/identity-normalize";

export type CanonicalIdentityDraft = {
  card_name: string;
  set_name: string;
  card_number: string;
  year: string;
  language: string;
  rarity: string;
  finish: string;
  variation: string;
  grader: string;
  grade: string;
  grade_label: string;
  certification_number: string;
  label_description: string;
};

export interface AutoApplyDecision {
  values: Partial<CanonicalIdentityDraft>;
  applied: AnalyzeFieldKey[];
  review: AnalyzeFieldKey[];
}

const FIELD_TO_CANONICAL: Record<AnalyzeFieldKey, keyof CanonicalIdentityDraft> = {
  card_name: "card_name",
  set: "set_name",
  card_number: "card_number",
  year: "year",
  language: "language",
  rarity: "rarity",
  finish: "finish",
  variation: "variation",
  grader: "grader",
  grade: "grade",
  grade_label: "grade_label",
  certification_number: "certification_number",
  label_description: "label_description",
};

const THRESHOLDS: Record<AnalyzeFieldKey, number> = {
  card_name: 0.82,
  set: 0.84,
  card_number: 0.95,
  year: 0.9,
  language: 0.88,
  rarity: 0.82,
  finish: 0.9,
  variation: 0.88,
  grader: 0.9,
  grade: 0.92,
  grade_label: 0.9,
  certification_number: 0.98,
  label_description: 0.8,
};

const MATERIAL_KEYS = new Set<AnalyzeFieldKey>([
  "card_name",
  "set",
  "card_number",
  "language",
  "finish",
  "variation",
  "grader",
  "grade",
  "grade_label",
  "certification_number",
]);

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

function valid(key: AnalyzeFieldKey, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (key === "year") return /^\d{4}$/.test(trimmed);
  if (key === "card_number") return /^\d+[A-Za-z]?\/\d+[A-Za-z]?$/.test(trimmed);
  if (key === "grade") return /^\d+(?:\.\d+)?$/.test(trimmed);
  if (key === "certification_number") return /^[A-Za-z0-9-]{6,32}$/.test(trimmed);
  return true;
}

export function buildAutomaticAnalysisPatch(
  current: CanonicalIdentityDraft,
  result: AnalyzeResult,
): AutoApplyDecision {
  const values: Partial<CanonicalIdentityDraft> = {};
  const applied: AnalyzeFieldKey[] = [];
  const review: AnalyzeFieldKey[] = [];
  const materialConflict = result.label_matches_card === false;

  for (const key of ANALYZE_FIELD_KEYS) {
    const field = result.proposed[key];
    const canonicalKey = FIELD_TO_CANONICAL[key];
    const value = field.value?.trim() ?? "";
    const blockedByConflict = materialConflict && MATERIAL_KEYS.has(key);

    if (
      isBlank(current[canonicalKey]) &&
      field.readable &&
      value !== "" &&
      field.confidence >= THRESHOLDS[key] &&
      valid(key, value) &&
      !blockedByConflict
    ) {
      values[canonicalKey] = value;
      applied.push(key);
    } else if (field.readable && value !== "") {
      review.push(key);
    }
  }

  const merged = { ...current, ...values };
  const reconciled = reconcileIdentity({
    grade: merged.grade,
    grade_label: merged.grade_label,
    rarity: merged.rarity,
    finish: merged.finish,
    variation: merged.variation,
  });

  const normalized: Array<[keyof CanonicalIdentityDraft, string]> = [
    ["grade", reconciled.grade.value],
    ["grade_label", reconciled.grade_label.value],
    ["rarity", reconciled.rarity.value],
    ["finish", reconciled.finish.value],
    ["variation", reconciled.variation.value],
  ];

  for (const [key, value] of normalized) {
    if (value && isBlank(current[key])) values[key] = value;
  }

  return { values, applied, review };
}

export const ANALYSIS_AUTO_APPLY_THRESHOLDS = THRESHOLDS;
