/**
 * Canonical valuation provenance. Availability and confidence are intentionally
 * separate: `tier_unavailable` means the connected source supplied no usable
 * graded tier; it never implies an operator entered a value.
 */
export const VALUATION_PROVENANCE = [
  "pricecharting_exact_tier",
  "pricecharting_compatible_tier",
  "pricecharting_estimate",
  "manual_guide",
  "manual_value",
  "tier_unavailable",
] as const;

export type ValuationProvenance = (typeof VALUATION_PROVENANCE)[number];

/**
 * Resolve the valuation provenance from a PriceCharting lookup result — the ONE
 * shared decision, so the intake page and any server path classify identically
 * (never a parallel copy inside a React component).
 *
 * Hard invariants:
 *  1. A GRADED specimen (a grader is present) is NEVER valued from the ungraded
 *     loose-price tier — that resolves to `tier_unavailable`, not a silent raw price.
 *  2. Consequently an ungraded source tier can never be labeled a grader-COMPATIBLE
 *     value: the graded+ungraded combination is `tier_unavailable`, full stop.
 *  3. `designation_exact` (e.g. a real CGC 10 Pristine tier) → exact; a real but
 *     non-exact graded tier → compatible; an interpolation → estimate.
 */
export function deriveValuationProvenance(input: {
  value_cents: number | null;
  is_estimate?: boolean;
  designation_exact?: boolean;
  /** Whether the specimen being valued is graded (a grading company is present). */
  grader_present: boolean;
  /** The tier key the value came from, e.g. "ungraded", "cgc_10", "cgc_10_pristine". */
  selected_tier_key?: string | null;
  /** The raw PriceCharting field the value came from, e.g. "loose-price". */
  field_used?: string | null;
}): ValuationProvenance {
  const ungradedTier = input.selected_tier_key === "ungraded" || input.field_used === "loose-price";
  if (input.value_cents === null || (input.grader_present && ungradedTier)) return "tier_unavailable";
  if (input.is_estimate) return "pricecharting_estimate";
  if (input.designation_exact) return "pricecharting_exact_tier";
  return "pricecharting_compatible_tier";
}

/** True when the current figures are AUTO-derived (source or formula), not manual. */
export function isAutoDerived(provenance: ValuationProvenance): boolean {
  return provenance.startsWith("pricecharting_");
}

export function isManualProvenance(provenance: ValuationProvenance): boolean {
  return provenance === "manual_guide" || provenance === "manual_value";
}

/**
 * On a MATERIAL identity change: auto-derived (source/formula) valuation is cleared
 * because it may no longer describe the card; a MANUAL valuation is preserved but
 * flagged as possibly stale. Returns what the caller should do.
 */
export function identityChangeAction(provenance: ValuationProvenance): {
  clearAutoValuation: boolean;
  warnManualStale: boolean;
} {
  const manual = isManualProvenance(provenance);
  return { clearAutoValuation: isAutoDerived(provenance), warnManualStale: manual };
}

/**
 * On switching to a DIFFERENT product: the new product's derived valuation REPLACES
 * the previous product's auto-derived figures, but never a manual valuation the
 * operator typed.
 */
export function productSwitchReplacesDerived(provenance: ValuationProvenance): boolean {
  return isAutoDerived(provenance);
}
