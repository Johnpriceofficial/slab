/**
 * Source-priority resolution for ONE requested tier, combining the official API
 * value with the public-page value. Rules:
 *   1. Exact official API tier wins when present.
 *   2. Else the exact verified public-page tier fills the gap.
 *   3. Agreement corroborates (one provider is never double-counted as two).
 *   4. Material conflict is SURFACED and lowers confidence — never auto-pick the
 *      higher value.
 * The public-page value is a current guide/reference value, NEVER a completed
 * sale. This function selects only among graded-tier evidence; loose-price is not
 * a candidate here, so a graded slab can never resolve to a raw value.
 */

export type ValuationSourceLabel = "PRICECHARTING_API" | "PRICECHARTING_PUBLIC_PAGE" | "NONE";

export interface TierSourceResolution {
  value_cents: number | null;
  source: ValuationSourceLabel;
  /** True when API and page both had a value and they materially disagree. */
  conflict: boolean;
  corroborated: boolean;
  /** Suggested confidence descriptor for downstream valuation. */
  confidence_hint: "exact" | "exact_reduced_conflict" | "unavailable";
  note: string;
}

/** Two values "materially" differ if they are more than 5% (and >$0.50) apart. */
function materiallyDiffer(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff > 50 && diff / Math.max(a, b) > 0.05;
}

export function resolveTierSource(input: {
  api_cents: number | null;
  page_cents: number | null;
  page_identity_verified: boolean;
}): TierSourceResolution {
  const { api_cents, page_cents } = input;
  const pageUsable = input.page_identity_verified && typeof page_cents === "number";

  // Both present → corroborate or surface a conflict. API stays the selected source.
  if (typeof api_cents === "number" && pageUsable) {
    if (materiallyDiffer(api_cents, page_cents as number)) {
      return {
        value_cents: api_cents, // do NOT auto-pick the higher value
        source: "PRICECHARTING_API",
        conflict: true,
        corroborated: false,
        confidence_hint: "exact_reduced_conflict",
        note: `API ($${(api_cents / 100).toFixed(2)}) and public page ($${((page_cents as number) / 100).toFixed(2)}) disagree; using API, confidence reduced.`,
      };
    }
    return {
      value_cents: api_cents,
      source: "PRICECHARTING_API",
      conflict: false,
      corroborated: true,
      confidence_hint: "exact",
      note: "Official API and public page agree.",
    };
  }

  // API only.
  if (typeof api_cents === "number") {
    return { value_cents: api_cents, source: "PRICECHARTING_API", conflict: false, corroborated: false, confidence_hint: "exact", note: "Official PriceCharting API tier." };
  }

  // Public page fills the API gap (verified identity only).
  if (pageUsable) {
    return { value_cents: page_cents as number, source: "PRICECHARTING_PUBLIC_PAGE", conflict: false, corroborated: false, confidence_hint: "exact", note: "Exact tier from the confirmed PriceCharting public product page (API omitted it)." };
  }

  // Neither — stays unavailable. Never falls back to loose-price for a graded tier.
  return { value_cents: null, source: "NONE", conflict: false, corroborated: false, confidence_hint: "unavailable", note: "No exact graded tier available from the API or the public page." };
}
