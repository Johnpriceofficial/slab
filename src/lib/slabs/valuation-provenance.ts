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
