/**
 * Grade-tier mapping. A specimen's grade maps to a CANONICAL pricing tier that
 * market data is bucketed by. Grade is a property of the specimen and the tier —
 * never of the card identity hash (see the Master Identity Engine).
 */

export type GradeTier =
  | "raw"
  | "grade_1" | "grade_2" | "grade_3" | "grade_4" | "grade_5"
  | "grade_6" | "grade_7" | "grade_8" | "grade_9"
  | "grade_9_5"
  | "grade_10"
  | "pristine_10"
  | "black_label_10"
  | "unknown";

/** Human label for a tier, for display. */
export const GRADE_TIER_LABELS: Record<GradeTier, string> = {
  raw: "Raw / Ungraded",
  grade_1: "Grade 1", grade_2: "Grade 2", grade_3: "Grade 3", grade_4: "Grade 4",
  grade_5: "Grade 5", grade_6: "Grade 6", grade_7: "Grade 7", grade_8: "Grade 8", grade_9: "Grade 9",
  grade_9_5: "Grade 9.5",
  grade_10: "Grade 10",
  pristine_10: "Pristine 10",
  black_label_10: "Black Label 10",
  unknown: "Unknown",
};

function numericGrade(grade: string): number | null {
  const m = grade.trim().match(/\d{1,2}(?:\.\d)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Map a specimen's grader/grade/label to a canonical tier. No grade ⇒ "raw".
 * A 10 with a "Pristine"/"Black Label" designation maps to the premium tier;
 * a plain 10 maps to grade_10 regardless of grader.
 */
export function mapGradeToTier(
  grader: string | null | undefined,
  grade: string | null | undefined,
  gradeLabel?: string | null,
): GradeTier {
  const g = (grade ?? "").trim();
  if (!g && !(grader ?? "").trim()) return "raw";
  const n = numericGrade(g);
  if (n === null) return "unknown";

  const label = (gradeLabel ?? "").toLowerCase();
  if (n === 10) {
    if (/pristine/.test(label)) return "pristine_10";
    if (/black\s*label/.test(label)) return "black_label_10";
    return "grade_10";
  }
  if (n === 9.5) return "grade_9_5";
  if (Number.isInteger(n) && n >= 1 && n <= 9) return (`grade_${n}` as GradeTier);
  return "unknown";
}

/** Premium 10 tiers price above a plain Grade 10; used for compatible-tier ranking. */
export function isPremiumTier(tier: GradeTier): boolean {
  return tier === "pristine_10" || tier === "black_label_10";
}
