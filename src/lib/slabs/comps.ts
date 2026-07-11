/**
 * Pure sales-comparable math. Comps are REAL sold transactions the operator
 * records; PriceCharting is a separate *guide* value and is never mixed in here.
 * All money is integer cents.
 */

import type { SlabComp } from "./types";

export interface CompStats {
  /** Comps with a usable total price. */
  accepted_count: number;
  /** Accepted comps flagged as an exact match for this slab. */
  exact_count: number;
  /** Median total of exact comps (the strongest signal). */
  exact_median_cents: number | null;
  /** Median total of all accepted comps. */
  accepted_median_cents: number | null;
  /** Min/max total across accepted comps. */
  sold_range_cents: { min: number; max: number } | null;
  /** Most recent sale date (YYYY-MM-DD) across accepted comps. */
  most_recent_sale_date: string | null;
}

/** Total for a comp: explicit total, else sold + shipping. Null if no sold price. */
export function compTotalCents(comp: SlabComp): number | null {
  if (comp.total_price_cents !== null && comp.total_price_cents !== undefined) return comp.total_price_cents;
  if (comp.sold_price_cents === null || comp.sold_price_cents === undefined) return null;
  return comp.sold_price_cents + (comp.shipping_cents ?? 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function computeCompStats(comps: SlabComp[]): CompStats {
  const accepted = comps
    .map((c) => ({ comp: c, total: compTotalCents(c) }))
    .filter((x): x is { comp: SlabComp; total: number } => x.total !== null);

  const totals = accepted.map((x) => x.total);
  const exactTotals = accepted.filter((x) => x.comp.exact_match === true).map((x) => x.total);

  const dates = accepted
    .map((x) => x.comp.sale_date)
    .filter((d): d is string => !!d)
    .sort(); // ISO YYYY-MM-DD sorts lexicographically

  return {
    accepted_count: accepted.length,
    exact_count: exactTotals.length,
    exact_median_cents: median(exactTotals),
    accepted_median_cents: median(totals),
    sold_range_cents: totals.length ? { min: Math.min(...totals), max: Math.max(...totals) } : null,
    most_recent_sale_date: dates.length ? dates[dates.length - 1] : null,
  };
}

export type FinalValueBasis = "exact_median" | "accepted_median" | "pricecharting_guide" | "none";

export interface FinalValueSuggestion {
  suggested_cents: number | null;
  basis: FinalValueBasis;
  /** Human-readable explanation of which evidence drove the suggestion. */
  rationale: string;
}

/**
 * Suggest a Final Value, in priority order: exact recent sales → accepted
 * comparable-sales median → PriceCharting guide (secondary evidence only) →
 * none. The operator must approve/adjust; this only proposes.
 */
export function suggestFinalValue(
  stats: CompStats,
  pricechartingGuideCents: number | null,
): FinalValueSuggestion {
  if (stats.exact_median_cents !== null) {
    return {
      suggested_cents: stats.exact_median_cents,
      basis: "exact_median",
      rationale: `Median of ${stats.exact_count} exact sold comp${stats.exact_count === 1 ? "" : "s"}.`,
    };
  }
  if (stats.accepted_median_cents !== null) {
    return {
      suggested_cents: stats.accepted_median_cents,
      basis: "accepted_median",
      rationale: `Median of ${stats.accepted_count} accepted sold comp${stats.accepted_count === 1 ? "" : "s"} (no exact match).`,
    };
  }
  if (pricechartingGuideCents !== null) {
    return {
      suggested_cents: pricechartingGuideCents,
      basis: "pricecharting_guide",
      rationale: "No sold comps — PriceCharting guide value only (secondary evidence, not a sale).",
    };
  }
  return { suggested_cents: null, basis: "none", rationale: "No sold comps and no guide value available." };
}
