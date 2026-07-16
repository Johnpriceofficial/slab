/**
 * Map a slab's grader + grade + designation to the canonical tier key used by
 * the page snapshot (and the rest of the app). This is the tier the public page
 * is asked to fill on an API gap — derived from the specimen's grade, NEVER from
 * its certification number.
 */

export function slabTierKey(
  grader: string | null | undefined,
  grade: string | number | null | undefined,
  gradeLabel: string | null | undefined,
): string | null {
  const g = String(grade ?? "").trim();
  const gr = (grader ?? "").trim().toUpperCase();
  if (!g && !gr) return "raw";
  const n = Number(g.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return null;
  const label = (gradeLabel ?? "").toLowerCase();
  const pristine = /pristine/.test(label);
  const perfect = /perfect/.test(label);
  // BGS's top designation shows on PriceCharting as "BGS 10 Black"; a scan may read
  // "Black", "Black Label", or "BL" — any "black" token in a BGS grade-10 context is
  // the Black Label tier (never the ordinary BGS 10).
  const blackLabel = /black/.test(label) || /(^|\s)bl(\s|$)/.test(label);

  if (n === 10) {
    switch (gr) {
      case "PSA": return "psa_10";
      case "SGC": return "sgc_10";
      case "TAG": return "tag_10";
      case "ACE": return "ace_10";
      case "CGC": return pristine ? "cgc_10_pristine" : perfect ? "cgc_10_perfect" : "cgc_10";
      case "BGS": return blackLabel ? "bgs_10_black_label" : pristine ? "bgs_10_pristine" : "bgs_10";
      default: return null; // grade 10 requires a known grader to pick a tier
    }
  }
  if (n === 9.5) return "grade_9_5_general";
  if (n === 9) return "grade_9_general";
  if (n === 8 || n === 8.5) return "grade_8_to_8_5";
  if (n === 7 || n === 7.5) return "grade_7_to_7_5";
  if (Number.isInteger(n) && n >= 1 && n <= 6) return `grade_${n}`;
  return null;
}
