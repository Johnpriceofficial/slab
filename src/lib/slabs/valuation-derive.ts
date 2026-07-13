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
 * there is no guide, and it keeps source availability separate from confidence.
 */

import type { ValuationProvenance } from "./valuation-provenance";

/**
 * The single canonical Valuation Confidence enum, mirroring VALUATION_CONFIDENCE
 * in constants.ts. Five levels only. "manual" is the only non-derived value —
 * every other level means the figure was derived from a scored PriceCharting
 * match. Legacy "exact"/"probable" were consolidated (exact→high, probable→
 * moderate) and are never produced; "Unavailable" is a display state, not a
 * confidence, so it is NOT a member here.
 */
export type ValuationConfidence = "verified" | "high" | "moderate" | "low" | "manual";

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
  /** A real but non-exact compatible tier was used. */
  compatible?: boolean;
  /** The pricing basis is weak but still usable. */
  weak_derived?: boolean;
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
export function computeValuationConfidence(s: ConfidenceSignals): ValuationConfidence | null {
  if (s.manual_override) return "manual";
  if (!s.guide_available) return null;

  let level: ValuationConfidence;
  if (s.exact_tier && s.identity_confirmed) level = s.visual_confirmed ? "verified" : "high";
  else if ((s.compatible || s.interpolated) && s.identity_confirmed) level = "moderate";
  else level = "low";

  if (s.weak_derived) level = "low";

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
  /** Explicit persisted source/availability provenance. */
  provenance: ValuationProvenance;
  /** Product identity is confirmed independently of the price tier. */
  identity_confirmed?: boolean;
  /** Positive operator artwork confirmation. */
  visual_confirmed?: boolean;
  /** Age of the connected-source pricing, when known. */
  pricing_age_days?: number | null;
}

export interface DerivedValuation {
  guide_cents: number | null;
  quick_sale_cents: number | null;
  replacement_cents: number | null;
  /** Suggested Final Value — the guide itself (0% variance) until the operator edits it. */
  suggested_final_cents: number | null;
  confidence: ValuationConfidence | null;
  availability: "available" | "tier_unavailable";
  provenance: ValuationProvenance;
  /** True when the guide is an interpolated estimate (confidence capped at "moderate"). */
  is_estimate: boolean;
  /** Plain-English explanation of exactly how these numbers were produced. */
  method: string;
}

/**
 * Map a 0–100 identity-match confidence to the canonical Valuation Confidence
 * enum. A pure identity match (no exact tier) never reaches "verified" — that is
 * reserved for an exact-tier match. An interpolated grade estimate is capped at
 * "moderate": it is never "high" no matter how certain the product identity is.
 */
export function mapMatchConfidenceToValuationConfidence(
  score: number | null,
  isEstimate: boolean,
): ValuationConfidence {
  if (score === null || !Number.isFinite(score)) return "low";
  let level: ValuationConfidence;
  if (score >= 85) level = "high";
  else if (score >= 70) level = "moderate";
  else level = "low";
  if (isEstimate && level === "high") level = "moderate";
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
      confidence: null,
      availability: "tier_unavailable",
      provenance: "tier_unavailable",
      is_estimate: isEstimate,
      method:
        "Exact graded tier unavailable from the connected source — values remain blank until an operator enters one.",
    };
  }

  const quick = pct(guide_cents, QUICK_SALE_PERCENTAGE);
  const replacement = pct(guide_cents, REPLACEMENT_VALUE_PERCENTAGE);
  const quickPctLabel = `${Math.round(QUICK_SALE_PERCENTAGE * 100)}%`;
  const replPctLabel = `${Math.round(REPLACEMENT_VALUE_PERCENTAGE * 100)}%`;
  if (input.provenance === "manual_guide" || input.provenance === "manual_value") {
    return {
      guide_cents,
      quick_sale_cents: quick,
      replacement_cents: replacement,
      suggested_final_cents: guide_cents,
      confidence: "manual",
      availability: "available",
      provenance: input.provenance,
      is_estimate: isEstimate,
      method:
        `Operator-entered ${input.provenance === "manual_guide" ? "guide" : "value"}. ` +
        `Final = guide (0% variance until edited); ` +
        `Quick-Sale = ${quickPctLabel} of Final; Replacement = ${replPctLabel} of Final.`,
    };
  }

  const exact = input.provenance === "pricecharting_exact_tier" && !isEstimate;
  const compatible = input.provenance === "pricecharting_compatible_tier";
  const estimate = input.provenance === "pricecharting_estimate" || isEstimate;
  const identityConfirmed = input.identity_confirmed ?? (confidence_score !== null && confidence_score >= 85);
  const confidence = computeValuationConfidence({
    guide_available: true,
    identity_confirmed: identityConfirmed,
    exact_tier: exact,
    interpolated: estimate,
    compatible,
    weak_derived: !exact && !compatible && !estimate,
    visual_confirmed: input.visual_confirmed ?? false,
    pricing_age_days: input.pricing_age_days ?? null,
    manual_override: false,
  });
  const basis = exact
    ? `exact PriceCharting tier${tier ? ` (${tier})` : ""}`
    : compatible
      ? `compatible PriceCharting tier${tier ? ` (${tier})` : ""}`
      : `documented PriceCharting estimate${tier ? ` (${tier})` : ""}`;

  return {
    guide_cents,
    quick_sale_cents: quick,
    replacement_cents: replacement,
    suggested_final_cents: guide_cents,
    confidence,
    availability: "available",
    provenance: input.provenance,
    is_estimate: estimate,
    method:
      `Auto-derived from the ${basis}. ` +
      `Final = guide (0% variance until edited); ` +
      `Quick-Sale = ${quickPctLabel} of guide; Replacement = ${replPctLabel} of guide.`,
  };
}
