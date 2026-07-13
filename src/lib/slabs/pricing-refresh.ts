/**
 * Pure decision logic for the detail-page "Refresh pricing" action, kept
 * separate from the Supabase orchestration so the data-safety rules are
 * unit-testable.
 *
 * Two rules matter most:
 *   1. Product resolution: an already-CONFIRMED product is re-valued directly —
 *      refresh never silently re-picks a different card. With no stored product,
 *      only an auto-confirmed search result is used; anything ambiguous defers to
 *      manual confirmation.
 *   2. No data loss: the API returns only an ungraded price for many cards, so a
 *      graded guide value an operator entered by hand must NEVER be overwritten
 *      with the API's null. Variance is only recomputed when the guide changes.
 */

import type { Slab } from "./types";
import { priceVariancePercent } from "./compute-stats";
import { computeValuationConfidence } from "./valuation-derive";
import { isManualProvenance, type ValuationProvenance } from "./valuation-provenance";

/** The subset of a value response the refresh consumes. */
export interface RefreshValue {
  product_id: string;
  product_name: string | null;
  grade_field: string | null;
  guide_value_cents: number | null;
  sales_volume: number | null;
  is_estimate?: boolean;
  designation_exact?: boolean;
}

/** The subset of a search response the refresh consumes. */
export interface RefreshSearch {
  requires_confirmation: boolean;
  auto_confirmed_product_id: string | null;
  candidates: Array<{ product_id: string; match_status: string }>;
}

export type RefreshProductResolution =
  | { kind: "product"; product_id: string; match_status: string | null }
  | { kind: "needs_confirmation" }
  | { kind: "no_product" };

/**
 * Decide which product to re-value. A stored (confirmed) product wins outright.
 * Otherwise only an auto-confirmed search result is accepted; an ambiguous or
 * empty search requires the operator to confirm in intake.
 */
export function resolveRefreshProduct(
  storedProductId: string | null | undefined,
  storedMatchStatus: string | null | undefined,
  search: RefreshSearch | null,
): RefreshProductResolution {
  if (storedProductId) {
    return { kind: "product", product_id: storedProductId, match_status: storedMatchStatus ?? null };
  }
  if (!search) return { kind: "no_product" };
  if (search.requires_confirmation || !search.auto_confirmed_product_id) {
    return search.candidates.length > 0 ? { kind: "needs_confirmation" } : { kind: "no_product" };
  }
  const ms = search.candidates.find((c) => c.product_id === search.auto_confirmed_product_id)?.match_status ?? null;
  return { kind: "product", product_id: search.auto_confirmed_product_id, match_status: ms };
}

/**
 * The scalar PriceCharting mirror fields to write on refresh, passed to
 * apply_slab_pricing so they commit ATOMICALLY with the tier table under the one
 * stale guard (no separate, unguarded UPDATE). It carries NO Final/Quick/
 * Replacement/confidence field, so the operator's approved valuation is
 * structurally untouchable here.
 *
 * `apply_value` is true only when the API actually had a value for the slab's
 * grade; when false, the DB preserves any hand-entered graded guide + variance
 * (never nulled). `variance` is precomputed with the same rule as the UI.
 */
export interface RefreshScalars {
  product_id: string;
  product_name: string | null;
  grade_field: string | null;
  sales_volume: number | null;
  match_status: string | null;
  apply_value: boolean;
  value_cents: number | null;
  variance: number | null;
  apply_provenance: boolean;
  valuation_provenance: ValuationProvenance | null;
  valuation_confidence: string | null;
}

export function buildRefreshScalars(
  slab: Pick<Slab, "final_value_cents" | "pricecharting_value_cents" | "visual_confirmation_status" | "valuation_provenance">,
  value: RefreshValue,
  matchStatus: string | null,
): RefreshScalars {
  const manual = slab.valuation_provenance ? isManualProvenance(slab.valuation_provenance) : false;
  // A background refresh may update linked product metadata/tier comparisons,
  // but never silently replace an operator-entered guide/final provenance.
  const applyValue = value.guide_value_cents !== null && !manual;
  const provenance: ValuationProvenance | null = manual
    ? null
    : applyValue
    ? value.is_estimate
      ? "pricecharting_estimate"
      : value.designation_exact === false
        ? "pricecharting_compatible_tier"
        : "pricecharting_exact_tier"
    : slab.pricecharting_value_cents === null && slab.final_value_cents === null
      ? "tier_unavailable"
      : null;
  const applyProvenance = provenance !== null;
  const confidence = !applyProvenance
    ? null
    : provenance === "tier_unavailable"
      ? null
      : computeValuationConfidence({
          guide_available: true,
          identity_confirmed: true,
          exact_tier: provenance === "pricecharting_exact_tier",
          compatible: provenance === "pricecharting_compatible_tier",
          interpolated: provenance === "pricecharting_estimate",
          visual_confirmed: slab.visual_confirmation_status === "user_confirmed",
          pricing_age_days: 0,
          manual_override: false,
        });
  return {
    product_id: value.product_id,
    product_name: value.product_name,
    grade_field: value.grade_field,
    sales_volume: value.sales_volume,
    match_status: matchStatus,
    apply_value: applyValue,
    value_cents: value.guide_value_cents,
    // Only meaningful when apply_value; matches priceVariancePercent (null when
    // final is null or guide is 0).
    variance: applyValue ? priceVariancePercent(slab.final_value_cents ?? null, value.guide_value_cents) : null,
    apply_provenance: applyProvenance,
    valuation_provenance: provenance,
    valuation_confidence: confidence,
  };
}
