/**
 * CGC Population Report domain types.
 *
 * Population data measures graded SUPPLY (scarcity). It is intentionally
 * separate from PriceCharting value, sold comps, identity confidence,
 * certification verification, and valuation confidence — it never determines
 * value by itself.
 *
 * The 15 count fields mirror the Apify actor's output verbatim and are kept
 * DISTINCT: Perfect 10, Pristine 10, and Gem Mint 10 are never merged.
 */

/** The 13 count columns that carry a numeric population (excludes AU/AA authenticity). */
export const GRADE_COUNT_FIELDS = [
  "count_perfect_10",
  "count_pristine_10",
  "count_gem_mint_10",
  "count_mint_plus_9_5",
  "count_mint_9",
  "count_nm_mint_plus_8_5",
  "count_nm_mint_8",
  "count_nm_plus_7_5",
  "count_nm_7",
  "count_ex_nm_plus_6_5",
  "count_ex_nm_6",
  "count_lower_grades",
] as const;

/** Authenticity counts — not graded ranks; never included in higher/lower sums. */
export const AUTHENTIC_COUNT_FIELDS = ["count_au", "count_aa"] as const;

export type GradeCountField = (typeof GRADE_COUNT_FIELDS)[number];

/**
 * Ordered high → low. `rank` 0 is the top. Used to compute "population higher"
 * (strictly smaller rank) and "population lower" (strictly larger rank).
 * NOTE: ranking Perfect 10 above Pristine 10 is a GradedCardValue.com display assumption —
 * CGC's card ceiling is Pristine 10; count_perfect_10 is typically 0 for cards.
 */
export interface GradeTier {
  field: GradeCountField;
  /** Human label shown in the grade table. */
  label: string;
  /** Numeric grade the tier corresponds to (null for the "Lower grades" bucket). */
  grade: number | null;
  /** Designation keyword for grade-10 tiers (perfect / pristine / gem_mint), else null. */
  designation: "perfect" | "pristine" | "gem_mint" | null;
  rank: number;
}

export const GRADE_TIERS: GradeTier[] = [
  { field: "count_perfect_10", label: "Perfect 10", grade: 10, designation: "perfect", rank: 0 },
  { field: "count_pristine_10", label: "Pristine 10", grade: 10, designation: "pristine", rank: 1 },
  { field: "count_gem_mint_10", label: "Gem Mint 10", grade: 10, designation: "gem_mint", rank: 2 },
  { field: "count_mint_plus_9_5", label: "Mint+ 9.5", grade: 9.5, designation: null, rank: 3 },
  { field: "count_mint_9", label: "Mint 9", grade: 9, designation: null, rank: 4 },
  { field: "count_nm_mint_plus_8_5", label: "NM-Mint+ 8.5", grade: 8.5, designation: null, rank: 5 },
  { field: "count_nm_mint_8", label: "NM-Mint 8", grade: 8, designation: null, rank: 6 },
  { field: "count_nm_plus_7_5", label: "NM+ 7.5", grade: 7.5, designation: null, rank: 7 },
  { field: "count_nm_7", label: "NM 7", grade: 7, designation: null, rank: 8 },
  { field: "count_ex_nm_plus_6_5", label: "EX-NM+ 6.5", grade: 6.5, designation: null, rank: 9 },
  { field: "count_ex_nm_6", label: "EX-NM 6", grade: 6, designation: null, rank: 10 },
  { field: "count_lower_grades", label: "Lower grades", grade: null, designation: null, rank: 11 },
];

/** A validated + normalized population card (one variant in a set). */
export interface CgcPopulationCard {
  cgc_card_id: number | null;
  card_name: string | null;
  normalized_card_name: string | null;
  card_number: string | null;
  normalized_card_number: string | null;
  /** Canonical numerator token (e.g. "289" from "289/S-P") — retrieval aid only. */
  card_number_token: string | null;
  parallel_or_variant: string | null;
  normalized_variant: string | null;
  autograph: boolean | null;
  memorabilia: boolean | null;
  set_name: string | null;
  normalized_set_name: string | null;
  cgc_set_id: number | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  year: string | null;
  report_url: string | null;
  /** Grade counts — null means "not reported", NEVER a claimed zero. */
  counts: Record<GradeCountField | (typeof AUTHENTIC_COUNT_FIELDS)[number] | "total_graded", number | null>;
  source_retrieved_at: string | null;
  raw_record: unknown;
}

export type PopulationRunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "aborted";

export type PopulationMatchStatus =
  | "confirmed_exact"
  | "high_confidence_proposed"
  | "needs_review"
  | "ambiguous"
  | "rejected"
  | "no_record_found"
  | "not_indexed"
  | "not_applicable";

export const MATCH_STATUS_LABEL: Record<PopulationMatchStatus, string> = {
  confirmed_exact: "Confirmed exact population match",
  high_confidence_proposed: "High-confidence proposed population match",
  needs_review: "Needs review",
  ambiguous: "Ambiguous",
  rejected: "Rejected",
  no_record_found: "No population record found",
  not_indexed: "Population data not indexed",
  not_applicable: "Not applicable (non-CGC slab)",
};

/**
 * GradedCardValue.com scarcity buckets — configurable, and explicitly NOT official CGC
 * labels. Population counts themselves are always shown as the raw factual value.
 */
export interface ScarcityBand {
  label: string;
  min: number;
  max: number | null;
}
export const SCARCITY_BANDS: ScarcityBand[] = [
  { label: "Pop 1", min: 1, max: 1 },
  { label: "Population 2–5", min: 2, max: 5 },
  { label: "Population 6–10", min: 6, max: 10 },
  { label: "Population 11–25", min: 11, max: 25 },
  { label: "Population 26–100", min: 26, max: 100 },
  { label: "Population 100+", min: 101, max: null },
];

export function scarcityBand(count: number | null): ScarcityBand | null {
  if (count === null || count <= 0) return null;
  return SCARCITY_BANDS.find((b) => count >= b.min && (b.max === null || count <= b.max)) ?? null;
}
