/**
 * Normalize raw page rows into canonical grade tiers + integer cents.
 *
 * Labels map into the SAME canonical tier vocabulary the rest of the app uses,
 * keeping every grade-10 variant DISTINCT (generic Grade 10 vs PSA 10 vs CGC 10
 * vs CGC 10 Pristine vs BGS 10 vs BGS 10 Black Label vs SGC/TAG/ACE 10). A
 * missing value ("-") stays null — never 0, never fabricated. Malformed /
 * implausible values are rejected to null.
 */

import type { PageTierValue } from "./types";
import type { RawPageRow } from "./parse";

/** Upper bound guarding against parse garbage (a single card over $10M is implausible). */
const MAX_PLAUSIBLE_CENTS = 1_000_000_00;

/** Exact page label → canonical tier key. Unknown labels return null (ignored). */
export function pageLabelToTier(rawLabel: string): string | null {
  const l = rawLabel.trim().toLowerCase().replace(/\s+/g, " ");
  switch (l) {
    case "ungraded": return "raw";
    case "grade 1": return "grade_1";
    case "grade 2": return "grade_2";
    case "grade 3": return "grade_3";
    case "grade 4": return "grade_4";
    case "grade 5": return "grade_5";
    case "grade 6": return "grade_6";
    case "grade 7": return "grade_7_to_7_5";
    case "grade 8": return "grade_8_to_8_5";
    case "grade 9": return "grade_9_general";
    case "grade 9.5": return "grade_9_5_general";
    case "psa 10": return "psa_10";
    case "cgc 10": return "cgc_10";
    case "cgc 10 pristine": return "cgc_10_pristine";
    case "cgc 10 perfect": return "cgc_10_perfect";
    case "sgc 10": return "sgc_10";
    case "bgs 10": return "bgs_10";
    case "bgs 10 black":
    case "bgs 10 black label": return "bgs_10_black_label";
    case "tag 10": return "tag_10";
    case "ace 10": return "ace_10";
    default: return null;
  }
}

/**
 * Parse a displayed price into integer cents. USD only. Returns null for a
 * missing value ("-"), or anything malformed, non-positive, or implausible —
 * distinct from a legitimate 0-cent value (there are none in this guide).
 */
export function parsePriceToCents(text: string): number | null {
  const t = (text ?? "").trim();
  if (!t || t === "-" || t === "—" || /^n\/?a$/i.test(t)) return null;
  // Reject anything that isn't a plain USD amount (block foreign currency codes/symbols).
  if (!/^\$?\s?\d[\d,]*(\.\d{1,2})?$/.test(t)) return null;
  const numeric = t.replace(/[$,\s]/g, "");
  const dollars = Number(numeric);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_PLAUSIBLE_CENTS) return null;
  return cents;
}

/** Normalize all recognized rows into canonical tier values (order preserved). */
export function normalizeTiers(rows: RawPageRow[]): PageTierValue[] {
  const out: PageTierValue[] = [];
  for (const row of rows) {
    const tier = pageLabelToTier(row.label);
    if (!tier) continue; // unknown label — never guessed into a tier
    out.push({
      tier,
      displayed_label: row.label.trim(),
      displayed_price_text: row.priceText.trim(),
      value_cents: parsePriceToCents(row.priceText),
    });
  }
  return out;
}
