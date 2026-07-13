/**
 * §1E valuation provenance — pure decisions extracted from the intake page so the
 * identity-change and product-switch rules are unit-testable.
 *
 *   - "source":  figures came from a confirmed PriceCharting product's tier value
 *   - "formula": figures were computed from an operator-entered guide value
 *   - "manual":  figures were typed directly by the operator
 */
export type ValuationProvenance = "source" | "formula" | "manual";

/** True when the current figures are AUTO-derived (source or formula), not manual. */
export function isAutoDerived(provenance: ValuationProvenance): boolean {
  return provenance === "source" || provenance === "formula";
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
  const manual = provenance === "manual";
  return { clearAutoValuation: !manual, warnManualStale: manual };
}

/**
 * On switching to a DIFFERENT product: the new product's derived valuation REPLACES
 * the previous product's auto-derived figures, but never a manual valuation the
 * operator typed.
 */
export function productSwitchReplacesDerived(provenance: ValuationProvenance): boolean {
  return isAutoDerived(provenance);
}
