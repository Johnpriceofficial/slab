/**
 * Market summary calculations over VERIFIED SALES only (never active listings).
 */

import type { MarketDataPoint, MarketSummary } from "./types";

function saleTime(p: MarketDataPoint): string {
  return p.sold_at ?? p.observed_at;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * Summarize verified sales: count, last (most recent), highest, lowest, median,
 * average. Empty input yields a zero/null summary rather than throwing.
 */
export function summarizeSales(sales: MarketDataPoint[]): MarketSummary {
  const verified = sales.filter((p) => p.kind === "sale" && p.match === "exact");
  if (verified.length === 0) {
    return { count: 0, last_sale_cents: null, last_sale_at: null, highest_cents: null, lowest_cents: null, median_cents: null, average_cents: null };
  }
  const prices = verified.map((p) => p.price_cents);
  const byRecency = [...verified].sort((a, b) => saleTime(b).localeCompare(saleTime(a)));
  const last = byRecency[0];
  return {
    count: verified.length,
    last_sale_cents: last.price_cents,
    last_sale_at: saleTime(last),
    highest_cents: Math.max(...prices),
    lowest_cents: Math.min(...prices),
    median_cents: median(prices),
    average_cents: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
  };
}
