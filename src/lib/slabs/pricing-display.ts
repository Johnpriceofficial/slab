/**
 * Pure builder for the strict slab-pricing DISPLAY hierarchy.
 *
 * Encodes the display rules once, framework-free, so the intake page and the
 * detail page render identical pricing:
 *   - PRIMARY value card: Final Value is the headline; the exact pricing basis
 *     ("CGC 10 Pristine — Exact PriceCharting Tier") sits directly beneath.
 *   - Value-source priority: exact tier > compatible/estimated tier > manual >
 *     unavailable. A missing exact tier is labelled "Estimated" (never silently
 *     substituted); no usable value is "Guide value unavailable" (null, not $0).
 *   - "Compare Other Grades" table: the slab's tier is the Exact Match; ungraded
 *     is "Raw-card reference only"; other graders' 10s are "Comparison only";
 *     other grades are muted. Values are NEVER averaged, and PSA 10 / CGC 10 /
 *     BGS 10 / SGC 10 are never treated as interchangeable.
 */

import { formatCents } from "./format";
import { QUICK_SALE_PERCENTAGE, REPLACEMENT_VALUE_PERCENTAGE } from "./valuation-derive";
import { VALUATION_CONFIDENCE } from "./constants";

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
  /** Per-tier PriceCharting values in cents (buildAvailableValues card keys). */
  available_values_cents?: Record<string, number | null> | null;
  /**
   * When the guide value came from a DIFFERENT tier than the slab's own grade
   * (e.g. a nearby grade used as a stand-in), its label — triggers "Estimated".
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

/** "PRISTINE" → "Pristine"; leaves numbers/short codes intact. */
function titleCase(s: string): string {
  return s.replace(/\b([A-Za-z])([A-Za-z]*)\b/g, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
}

function tierLabelOf(i: PricingInputs): string {
  return [i.grader, i.grade, i.grade_label ? titleCase(i.grade_label) : null]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function confidenceLabel(v: string | null): string {
  if (!v) return "—";
  return VALUATION_CONFIDENCE.find((c) => c.value === v)?.label ?? titleCase(v);
}

/** Grade-10 field key for a grading company, or null for non-10 / unknown. */
function graderTenKey(grader: string | null, grade: string | null): string | null {
  const g = (grader ?? "").trim().toUpperCase();
  const n = Number((grade ?? "").replace(/[^0-9.]/g, ""));
  if (n !== 10) return null;
  if (g === "PSA") return "psa_10";
  if (g === "CGC") return "cgc_10";
  if (g === "BGS") return "bgs_10";
  if (g === "SGC") return "sgc_10";
  return null;
}

/** Static metadata for every card price tier key we may display. */
const TIER_META: Array<{ key: string; label: string; kind: GradeRowKind; note: string | null }> = [
  { key: "ungraded", label: "Ungraded", kind: "raw_reference", note: "Raw-card reference only" },
  { key: "grade_7_to_7_5", label: "Grade 7–7.5", kind: "grade", note: null },
  { key: "grade_8_to_8_5", label: "Grade 8–8.5", kind: "grade", note: null },
  { key: "grade_9_general", label: "Grade 9 (general)", kind: "grade", note: null },
  { key: "grade_9_5_general", label: "Grade 9.5 (general)", kind: "grade", note: null },
  { key: "psa_10", label: "PSA 10", kind: "comparison", note: "Comparison only" },
  { key: "cgc_10", label: "CGC 10", kind: "comparison", note: "Comparison only" },
  { key: "bgs_10", label: "BGS 10", kind: "comparison", note: "Comparison only" },
  { key: "sgc_10", label: "SGC 10", kind: "comparison", note: "Comparison only" },
];

function buildGradeRows(i: PricingInputs, tierLabel: string, exactKey: string | null): GradeRow[] {
  const values = i.available_values_cents ?? {};
  const rows: GradeRow[] = [];

  for (const meta of TIER_META) {
    const cents = values[meta.key];
    if (cents === null || cents === undefined) continue;
    const isExact = exactKey !== null && meta.key === exactKey;
    rows.push({
      key: meta.key,
      // The exact tier shows the slab's full designation (e.g. "CGC 10 Pristine").
      label: isExact ? tierLabel || meta.label : meta.label,
      cents,
      kind: isExact ? "exact" : meta.kind,
      note: isExact ? null : meta.note,
      muted: !isExact,
    });
  }

  // Ensure the slab's own exact tier always appears, even when no per-tier map
  // was supplied (the detail page stores only the guide value).
  const hasExact = rows.some((r) => r.kind === "exact");
  if (!hasExact && i.guide_cents !== null && !i.comparison_tier_label) {
    rows.unshift({
      key: exactKey ?? "exact_tier",
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
  const tierLabel = tierLabelOf(i);
  const exactKey = graderTenKey(i.grader, i.grade);

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
    grade_rows: buildGradeRows(i, tierLabel, exactKey),
  };
}
