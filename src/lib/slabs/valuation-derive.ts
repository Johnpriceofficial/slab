/**
 * Auto-population of a slab's valuation from a CONFIRMED PriceCharting guide value.
 *
 * Why this exists: linking a PriceCharting product used to fill only the guide
 * value and leave Quick-Sale / Replacement blank and Valuation Confidence stuck
 * on "Manual" — even though the numbers were, in fact, derived from a confirmed
 * market value. That is exactly the contradiction the overhaul forbids: a value
 * auto-derived from PriceCharting must NOT be labelled "Manual", and the derived
 * numbers must be reproducible from a DOCUMENTED, single-source config.
 *
 * This module is pure and framework-agnostic. It never invents a value when
 * there is no guide (returns nulls + "manual"); it never presents an interpolated
 * grade estimate as anything better than "Probable".
 */

/**
 * The Valuation Confidence enum, mirroring VALUATION_CONFIDENCE in constants.ts.
 * "manual" is the only non-derived value — every other level means the figure
 * was derived from a scored PriceCharting match.
 */
export type ValuationConfidence = "exact" | "high" | "probable" | "low" | "manual";

/**
 * DOCUMENTED valuation ratios, applied to the Current PriceCharting Guide Value.
 * These are the defaults the auto-population uses; the operator can always
 * override the resulting figures in the form.
 *
 *  - Quick-Sale = the price to liquidate quickly, a deliberate discount to the
 *    guide (sell today, accept a haircut).
 *  - Replacement = insurance / reacquisition value at retail, a premium over the
 *    raw guide (what it costs to buy this slab back on the open market).
 *
 * Change these two constants to retune every auto-derived valuation in one place.
 */
export const QUICK_SALE_PERCENTAGE = 0.85; // 85% of guide
export const REPLACEMENT_VALUE_PERCENTAGE = 1.2; // 120% of guide

/** Inputs describing the confirmed PriceCharting match the valuation derives from. */
export interface ValuationDeriveInput {
  /** Current PriceCharting Guide Value at the requested grade, integer cents. */
  guide_cents: number | null;
  /** The matcher's confidence in the product identity, 0–100. */
  confidence_score: number | null;
  /** True when the guide value is an interpolated grade estimate, not a direct tier. */
  is_estimate?: boolean;
  /** Human label of the price tier used (e.g. "CGC 10", "General Grade 9"). */
  field_meaning?: string | null;
}

export interface DerivedValuation {
  guide_cents: number | null;
  quick_sale_cents: number | null;
  replacement_cents: number | null;
  /** Suggested Final Value — the guide itself (0% variance) until the operator edits it. */
  suggested_final_cents: number | null;
  /** Never "manual" when a guide value was actually derived from PriceCharting. */
  confidence: ValuationConfidence;
  /** True when the guide is an interpolated estimate (confidence capped at "probable"). */
  is_estimate: boolean;
  /** Plain-English explanation of exactly how these numbers were produced. */
  method: string;
}

/**
 * Map a 0–100 identity-match confidence to the slab's Valuation Confidence enum.
 * An interpolated grade estimate is capped at "probable" — it is never "exact"
 * or "high" no matter how certain the product identity is.
 */
export function mapMatchConfidenceToValuationConfidence(
  score: number | null,
  isEstimate: boolean,
): ValuationConfidence {
  if (score === null || !Number.isFinite(score)) return "manual";
  let level: ValuationConfidence;
  if (score >= 95) level = "exact";
  else if (score >= 85) level = "high";
  else if (score >= 70) level = "probable";
  else level = "low";
  if (isEstimate && (level === "exact" || level === "high")) level = "probable";
  return level;
}

function pct(cents: number, ratio: number): number {
  return Math.round(cents * ratio);
}

/**
 * Derive Quick-Sale, Replacement, a suggested Final Value, and a NON-"manual"
 * Valuation Confidence from a confirmed PriceCharting guide value.
 *
 * When there is no guide value, everything derived is null and confidence falls
 * back to "manual" with a method that says so — the caller must value by hand.
 */
export function deriveValuation(input: ValuationDeriveInput): DerivedValuation {
  const { guide_cents, confidence_score } = input;
  const isEstimate = !!input.is_estimate;
  const tier = input.field_meaning?.trim();

  if (guide_cents === null || !Number.isFinite(guide_cents)) {
    return {
      guide_cents: null,
      quick_sale_cents: null,
      replacement_cents: null,
      suggested_final_cents: null,
      confidence: "manual",
      is_estimate: isEstimate,
      method:
        "No PriceCharting guide value is available for this grade — enter the valuation manually.",
    };
  }

  const quick = pct(guide_cents, QUICK_SALE_PERCENTAGE);
  const replacement = pct(guide_cents, REPLACEMENT_VALUE_PERCENTAGE);
  const confidence = mapMatchConfidenceToValuationConfidence(confidence_score, isEstimate);
  const quickPctLabel = `${Math.round(QUICK_SALE_PERCENTAGE * 100)}%`;
  const replPctLabel = `${Math.round(REPLACEMENT_VALUE_PERCENTAGE * 100)}%`;

  const basis = isEstimate
    ? `interpolated grade estimate${tier ? ` (${tier})` : ""}`
    : `confirmed PriceCharting value${tier ? ` (${tier})` : ""}`;

  return {
    guide_cents,
    quick_sale_cents: quick,
    replacement_cents: replacement,
    suggested_final_cents: guide_cents,
    confidence,
    is_estimate: isEstimate,
    method:
      `Auto-derived from the ${basis}. ` +
      `Final = guide (0% variance until edited); ` +
      `Quick-Sale = ${quickPctLabel} of guide; Replacement = ${replPctLabel} of guide.`,
  };
}
