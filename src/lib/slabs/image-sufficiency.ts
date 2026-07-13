/**
 * Front-image sufficiency assessment.
 *
 * The overhaul makes the back photo genuinely optional: a slab whose front label
 * carries every field needed to save should not be blocked on a back image, and
 * the operator should be told SPECIFICALLY what (if anything) is still missing —
 * not shown a blanket "add the back" message.
 *
 * This is derived purely from the per-field evidence the analyze-slab handler
 * already returns (each field has `readable` + a `source`), so it needs no change
 * to that handler. A field is "obtained" when it was read with a concrete value.
 *
 * Levels:
 *   - "sufficient"               every field required to save was read from the front.
 *   - "sufficient_with_warnings" all required fields read, but some
 *                                match-improving fields (set / number / year /
 *                                language) are still missing.
 *   - "insufficient"             a field REQUIRED to save could not be read.
 */

import { type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";

export type FrontImageSufficiency = "sufficient" | "sufficient_with_warnings" | "insufficient";

/** Fields REQUIRED to save a slab — mirrors validateSlabInput in save-slab.ts. */
export const CRITICAL_FIELDS: readonly AnalyzeFieldKey[] = [
  "card_name",
  "grader",
  "grade",
  "certification_number",
] as const;

/** Fields that materially improve PriceCharting matching but don't block a save. */
export const VALUABLE_FIELDS: readonly AnalyzeFieldKey[] = [
  "set",
  "card_number",
  "year",
  "language",
] as const;

/** Fields whose ground truth typically lives on the BACK of a slab label. */
const TYPICALLY_ON_BACK: readonly AnalyzeFieldKey[] = ["certification_number"] as const;

const LABELS: Record<AnalyzeFieldKey, string> = {
  card_name: "card name",
  set: "set",
  card_number: "card number",
  year: "year",
  language: "language",
  rarity: "rarity",
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
  /** Required fields the front image did not yield. */
  missing_critical: SufficiencyField[];
  /** Match-improving fields the front image did not yield. */
  missing_valuable: SufficiencyField[];
  /** True when uploading the back image is the recommended next step. */
  back_recommended: boolean;
  /** A specific, field-naming message — never a generic "add the back". */
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

/**
 * Assess whether the front image alone is enough, from an analyze-slab result.
 * @param backProvided whether a back image was included in the analysis — changes
 *        the recapture guidance (retake vs. add the back).
 */
export function assessFrontImageSufficiency(
  result: AnalyzeResult,
  opts: { backProvided?: boolean } = {},
): FrontImageSufficiencyAssessment {
  const backProvided = !!opts.backProvided;
  const missing_critical = fields(CRITICAL_FIELDS.filter((k) => !obtained(result, k)));
  const missing_valuable = fields(VALUABLE_FIELDS.filter((k) => !obtained(result, k)));

  const certMissing = missing_critical.some((f) => TYPICALLY_ON_BACK.includes(f.key));
  const anyMissing = missing_critical.length > 0 || missing_valuable.length > 0;
  const back_recommended = !backProvided && anyMissing;

  let level: FrontImageSufficiency;
  let message: string;

  if (missing_critical.length > 0) {
    level = "insufficient";
    const backGuidance = backProvided
      ? "Retake a sharper, glare-free photo of the affected area."
      : certMissing
        ? "The certification number is usually on the back — upload the back image, or retake a sharper front photo."
        : "Upload the back image or retake a sharper front photo.";
    message = `The front image is missing field(s) required to save: ${list(missing_critical)}. ${backGuidance}`;
  } else if (missing_valuable.length > 0) {
    level = "sufficient_with_warnings";
    const tail = backProvided
      ? "You can save now; fill these in manually to improve the PriceCharting match."
      : "You can save now — or add the back image to help read them for a better PriceCharting match.";
    message = `The front image captured everything required to save, but couldn't read ${list(
      missing_valuable,
    )}. ${tail}`;
  } else {
    level = "sufficient";
    message =
      "The front image alone captured every field required to save (card name, grader, grade, and certification number). The back image is optional.";
  }

  return { level, missing_critical, missing_valuable, back_recommended, message };
}
