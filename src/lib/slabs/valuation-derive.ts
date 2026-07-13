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
export type ValuationConfidence = "verified" | "exact" | "high" | "moderate" | "probable" | "low" | "manual";

/** §6 Multi-signal valuation-confidence inputs. */
export interface ConfidenceSignals {
  /** A usable guide value exists for the requested grade. */
  guide_available: boolean;
  /** The product identity was confirmed (auto or by the user). */
  identity_confirmed: boolean;
  /** The exact grader+grade/designation pricing tier was used. */
  exact_tier: boolean;
  /** An interpolated/adjusted estimate was used instead of an exact tier. */
  interpolated: boolean;
  /** The user visually confirmed the image matches. */
  visual_confirmed: boolean;
  /** Age of the pricing data in days, if known. */
  pricing_age_days: number | null;
  /** The user manually entered or overrode the value. */
  manual_override: boolean;
}

// The §6 confidence ladder (5 levels). Legacy "exact"/"probable" are never
// produced by computeValuationConfidence.
const RANK: ValuationConfidence[] = ["manual", "low", "moderate", "high", "verified"];
function downgrade(c: ValuationConfidence): ValuationConfidence {
  const i = RANK.indexOf(c);
  return i > 1 ? RANK[i - 1] : c; // never below "low" via a downgrade
}
function capAt(c: ValuationConfidence, max: ValuationConfidence): ValuationConfidence {
  return RANK.indexOf(c) > RANK.indexOf(max) ? max : c;
}

/**
 * Compute the overall valuation confidence from all signals. Key rules:
 *  - "manual" ONLY when the user manually entered/overrode (or there is no usable
 *    guide value to derive from).
 *  - Identity confirmation alone never yields Verified/High — a value must exist,
 *    from an exact tier or a documented estimate.
 *  - Stale pricing and unconfirmed identity/visuals downgrade the result.
 */
export function computeValuationConfidence(s: ConfidenceSignals): ValuationConfidence {
  if (s.manual_override) return "manual";
  if (!s.guide_available) return "manual"; // nothing to derive → value must be entered by hand

  let level: ValuationConfidence;
  if (s.exact_tier && s.identity_confirmed) level = s.visual_confirmed ? "verified" : "high";
  else if (s.exact_tier) level = "high";
  else if (s.interpolated) level = "moderate";
  else level = "moderate";

  // Stale pricing reduces confidence one step.
  if (s.pricing_age_days !== null && s.pricing_age_days > 30) level = downgrade(level);
  // Unconfirmed identity caps confidence at Moderate — a value is not "High/Verified"
  // just because a price exists if we're unsure which product it belongs to.
  if (!s.identity_confirmed) level = capAt(level, "moderate");
  return level;
}

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
export const QUICK_SALE_PERCENTAGE = 0.8; // 80% of guide
export const REPLACEMENT_VALUE_PERCENTAGE = 1.1; // 110% of guide

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
  /**
   * When set, the guide value IS the exact PriceCharting tier for the slab's own
   * grade (e.g. "CGC 10 Pristine"), whether provided by the API or entered by the
   * operator from the PriceCharting site. This makes it a Verified exact-tier
   * match — confidence "verified", method "Exact graded-price match" — regardless
   * of any identity-match score. Ignored when the guide is null.
   */
  exact_tier_label?: string | null;
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
  const quickPctLabel = `${Math.round(QUICK_SALE_PERCENTAGE * 100)}%`;
  const replPctLabel = `${Math.round(REPLACEMENT_VALUE_PERCENTAGE * 100)}%`;
  const exactTier = input.exact_tier_label?.trim();

  // Exact-tier guide (API tier for the slab's grade, or the operator's entry of
  // the site figure for that grade) → Verified exact graded-price match.
  if (exactTier && !isEstimate) {
    return {
      guide_cents,
      quick_sale_cents: quick,
      replacement_cents: replacement,
      suggested_final_cents: guide_cents,
      confidence: "verified",
      is_estimate: false,
      method:
        `Exact graded-price match — ${exactTier} guide tier. ` +
        `Final = guide (0% variance until edited); ` +
        `Quick-Sale = ${quickPctLabel} of Final; Replacement = ${replPctLabel} of Final.`,
    };
  }

  const confidence = mapMatchConfidenceToValuationConfidence(confidence_score, isEstimate);
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
