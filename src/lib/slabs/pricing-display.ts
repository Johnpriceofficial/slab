/**
 * Pure builder for the strict slab-pricing DISPLAY hierarchy.
 *
 * Encodes the display rules once, framework-free, so the intake page and the
 * detail page render IDENTICAL pricing from the same canonical PriceTier[] —
 * whether those tiers come live from the value response (intake) or hydrated
 * from the persisted JSONB (detail).
 *
 *   - PRIMARY value card: Final Value is the headline; the exact pricing basis
 *     ("CGC 10 Pristine — Exact PriceCharting Tier") sits directly beneath.
 *   - Value-source priority: exact tier > compatible/estimated tier > manual >
 *     unavailable (null figures, never $0).
 *   - "Compare Other Grades": the slab's tier is the Exact Match; ungraded is
 *     "Raw-card reference only"; other graders' 10s are "Comparison only"; other
 *     grades muted. Never averaged; PSA/CGC/BGS/SGC 10 never interchangeable.
 */

import { formatCents } from "./format";
import { QUICK_SALE_PERCENTAGE, REPLACEMENT_VALUE_PERCENTAGE } from "./valuation-derive";
import { VALUATION_CONFIDENCE } from "./constants";
import { buildPriceTiers, tierLabelOf, titleCase, type PriceTier } from "./pricing-tiers";

export type PricingMatchKind = "exact" | "estimated" | "manual" | "unavailable";

export interface PricingInputs {
  final_cents: number | null;
  guide_cents: number | null;
  quick_cents: number | null;
  replacement_cents: number | null;
  valuation_confidence: string | null;
  price_variance_percent: number | null;
  grader: string | null;
  grade: string | null;
  grade_label: string | null;
  product_name: string | null;
  product_id: string | null;
  /**
   * Canonical persisted/live tiers (preferred). When omitted, tiers are built
   * from `available_values_cents`.
   */
  tiers?: PriceTier[] | null;
  /** Per-tier PriceCharting values in cents (buildAvailableValues card keys). */
  available_values_cents?: Record<string, number | null> | null;
  /**
   * When the guide value came from a DIFFERENT tier than the slab's own grade
   * (a nearby grade used as a stand-in), its label — triggers "Estimated".
   */
  comparison_tier_label?: string | null;
}

export type GradeRowKind = "exact" | "raw_reference" | "comparison" | "grade";

export interface GradeRow {
  key: string;
  label: string;
  cents: number | null;
  kind: GradeRowKind;
  /** "Raw-card reference only" / "Comparison only" / null. */
  note: string | null;
  muted: boolean;
}

export interface PricingModel {
  match_kind: PricingMatchKind;
  exact_match: boolean;
  unavailable: boolean;
  tier_label: string;
  basis_label: string;
  final_cents: number | null;
  guide_cents: number | null;
  quick_cents: number | null;
  replacement_cents: number | null;
  confidence_label: string;
  variance_percent: number | null;
  method_label: string;
  note: string;
  disclaimer: string;
  grade_rows: GradeRow[];
}

const DISCLAIMER = "Current PriceCharting Guide Value — not a last-sold or eBay-sold price.";

function confidenceLabel(v: string | null): string {
  if (!v) return "—";
  return VALUATION_CONFIDENCE.find((c) => c.value === v)?.label ?? titleCase(v);
}

/** Classify a canonical tier into a display row. */
function rowForTier(t: PriceTier, exactLabel: string): GradeRow {
  if (t.exact_match) {
    return { key: t.tier, label: exactLabel || t.label, cents: t.value_cents, kind: "exact", note: null, muted: false };
  }
  if (t.tier === "ungraded") {
    return {
      key: t.tier,
      label: t.label,
      cents: t.value_cents,
      kind: "raw_reference",
      note: "Raw-card reference only",
      muted: true,
    };
  }
  if (t.grader) {
    // A grader-specific 10 for a DIFFERENT company — comparison only, never merged.
    return { key: t.tier, label: t.label, cents: t.value_cents, kind: "comparison", note: "Comparison only", muted: true };
  }
  return { key: t.tier, label: t.label, cents: t.value_cents, kind: "grade", note: null, muted: true };
}

function buildGradeRows(i: PricingInputs, tiers: PriceTier[] | null, tierLabel: string): GradeRow[] {
  const rows: GradeRow[] = (tiers ?? [])
    .filter((t) => t.available) // only real values; never fabricate a $0/absent row
    .map((t) => rowForTier(t, tierLabel));

  // Ensure the slab's own exact tier always appears, even when no per-tier data
  // was supplied (a detail page that stored only the guide value).
  const hasExact = rows.some((r) => r.kind === "exact");
  if (!hasExact && i.guide_cents !== null && !i.comparison_tier_label) {
    rows.unshift({
      key: "exact_tier",
      label: tierLabel || "This grade",
      cents: i.guide_cents,
      kind: "exact",
      note: null,
      muted: false,
    });
  }
  return rows;
}

export function buildPricingModel(i: PricingInputs): PricingModel {
  const tierLabel = tierLabelOf({ grader: i.grader, grade: i.grade, grade_label: i.grade_label });
  const tiers = i.tiers ?? (i.available_values_cents ? buildPriceTiers(i.available_values_cents, i) : null);

  let match_kind: PricingMatchKind;
  if (i.guide_cents === null && i.final_cents === null) match_kind = "unavailable";
  else if (i.guide_cents !== null) match_kind = i.comparison_tier_label ? "estimated" : "exact";
  else match_kind = "manual";

  const exact_match = match_kind === "exact";
  const unavailable = match_kind === "unavailable";

  const basis_label =
    match_kind === "exact"
      ? `${tierLabel} — Exact PriceCharting Tier`
      : match_kind === "estimated"
        ? `${tierLabel} — Estimated from ${i.comparison_tier_label}`
        : match_kind === "manual"
          ? "Manual valuation"
          : "Guide value unavailable";

  const method_label =
    match_kind === "exact"
      ? "Exact graded-price match"
      : match_kind === "estimated"
        ? `Estimated from ${i.comparison_tier_label} (nearest available tier)`
        : match_kind === "manual"
          ? "Manual valuation"
          : "Guide value unavailable";

  const quickPct = `${Math.round(QUICK_SALE_PERCENTAGE * 100)}%`;
  const replPct = `${Math.round(REPLACEMENT_VALUE_PERCENTAGE * 100)}%`;
  const product = i.product_name
    ? `The PriceCharting product was confirmed as ${i.product_name}${i.product_id ? `, PriceCharting ID ${i.product_id}` : ""}. `
    : "";

  let note: string;
  if (match_kind === "exact") {
    note =
      `${product}Final Value uses the exact ${tierLabel} guide tier of ${formatCents(i.guide_cents)}. ` +
      `Quick-Sale Value is ${quickPct} of Final Value, and Replacement Value is ${replPct} of Final Value. ` +
      `PriceCharting's guide is a current estimated value and is not a confirmed last-sold transaction.`;
  } else if (match_kind === "estimated") {
    note =
      `${product}No exact ${tierLabel} tier was available, so the value is ESTIMATED from ${i.comparison_tier_label} ` +
      `(${formatCents(i.guide_cents)}). Confidence is reduced accordingly. PriceCharting's guide is a current ` +
      `estimated value, not a confirmed last-sold transaction.`;
  } else if (match_kind === "manual") {
    note =
      `${product}No PriceCharting guide tier was used; this is a manual valuation. ` +
      `PriceCharting figures are current estimated values, not confirmed last-sold transactions.`;
  } else {
    note =
      `${product}No usable PriceCharting guide value is available for ${tierLabel || "this grade"}. ` +
      `Values are left empty (null, not $0) for manual valuation.`;
  }

  return {
    match_kind,
    exact_match,
    unavailable,
    tier_label: tierLabel,
    basis_label,
    final_cents: i.final_cents,
    guide_cents: i.guide_cents,
    quick_cents: i.quick_cents,
    replacement_cents: i.replacement_cents,
    confidence_label: unavailable ? "—" : confidenceLabel(i.valuation_confidence),
    variance_percent: i.price_variance_percent,
    method_label,
    note,
    disclaimer: DISCLAIMER,
    grade_rows: buildGradeRows(i, tiers, tierLabel),
  };
}
