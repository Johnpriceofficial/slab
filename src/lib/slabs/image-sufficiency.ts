/**
 * Front-image sufficiency assessment.
 *
 * A graded Pokemon slab front is the primary evidence surface. Missing or
 * ambiguous fields must be resolved from a sharper front-label image or manual
 * review; the back remains optional supplemental evidence and never becomes a
 * workflow prerequisite.
 */

import { type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";

export type FrontImageSufficiency = "sufficient" | "sufficient_with_warnings" | "insufficient";

/** Fields required to save a verified slab — mirrors validateSlabInput. */
export const CRITICAL_FIELDS: readonly AnalyzeFieldKey[] = [
  "card_name",
  "grader",
  "grade",
  "certification_number",
] as const;

/** Fields that improve exact PriceCharting matching but do not block a draft. */
export const VALUABLE_FIELDS: readonly AnalyzeFieldKey[] = [
  "set",
  "card_number",
  "year",
  "language",
] as const;

const LABELS: Record<AnalyzeFieldKey, string> = {
  card_name: "card name",
  set: "set",
  card_number: "card number",
  year: "year",
  language: "language",
  rarity: "rarity",
  finish: "finish",
  variation: "variation",
  grader: "grader",
  grade: "grade",
  grade_label: "grade label",
  certification_number: "certification number",
  label_description: "label description",
};

export interface SufficiencyField {
  key: AnalyzeFieldKey;
  label: string;
}

export interface FrontImageSufficiencyAssessment {
  level: FrontImageSufficiency;
  missing_critical: SufficiencyField[];
  missing_valuable: SufficiencyField[];
  /** True only as a non-blocking suggestion for supplemental documentation. */
  back_recommended: boolean;
  message: string;
}

function obtained(result: AnalyzeResult, key: AnalyzeFieldKey): boolean {
  const f = result.proposed[key];
  return !!f && f.readable && f.value !== null && f.value !== "";
}

function fields(keys: readonly AnalyzeFieldKey[]): SufficiencyField[] {
  return keys.map((k) => ({ key: k, label: LABELS[k] }));
}

function list(items: SufficiencyField[]): string {
  const names = items.map((i) => i.label);
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function assessFrontImageSufficiency(
  result: AnalyzeResult,
  opts: { backProvided?: boolean } = {},
): FrontImageSufficiencyAssessment {
  const backProvided = !!opts.backProvided;
  const missing_critical = fields(CRITICAL_FIELDS.filter((k) => !obtained(result, k)));
  const missing_valuable = fields(VALUABLE_FIELDS.filter((k) => !obtained(result, k)));
  const anyMissing = missing_critical.length > 0 || missing_valuable.length > 0;
  const back_recommended = !backProvided && anyMissing;

  let level: FrontImageSufficiency;
  let message: string;

  if (missing_critical.length > 0) {
    level = "insufficient";
    message =
      `The front image did not reliably capture ${list(missing_critical)}. ` +
      "Retake a sharper, glare-free front-label photo or enter the value manually. " +
      "An optional back image may add documentation, but it is not required to continue the normal slab workflow.";
  } else if (missing_valuable.length > 0) {
    level = "sufficient_with_warnings";
    message =
      `The front captured everything required to save, but could not reliably read ${list(missing_valuable)}. ` +
      "You can continue now and review these fields manually. The back image is optional supplemental evidence.";
  } else {
    level = "sufficient";
    message =
      "The front image captured the primary identity required for identification, valuation, and inventory. The back image is optional supplemental documentation.";
  }

  return { level, missing_critical, missing_valuable, back_recommended, message };
}
