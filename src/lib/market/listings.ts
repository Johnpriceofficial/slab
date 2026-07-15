/**
 * Active-listing vs verified-sale separation.
 *
 * A price a seller is ASKING (active listing) is not a price a card SOLD for.
 * Market summaries and valuations must be driven by verified sales; active
 * listings are context (supply/asking), never the sale value. Rejected matches
 * are excluded from both.
 */

import type { MarketDataPoint } from "./types";

export interface SeparatedMarket {
  /** Exact-match verified sales — the basis for value. */
  sales: MarketDataPoint[];
  /** Exact-match active listings — asking prices, supply context only. */
  active: MarketDataPoint[];
  /** Same card at other tiers — tier-relative context. */
  compatible: MarketDataPoint[];
}

export function separateMarket(points: MarketDataPoint[]): SeparatedMarket {
  const sales: MarketDataPoint[] = [];
  const active: MarketDataPoint[] = [];
  const compatible: MarketDataPoint[] = [];
  for (const p of points) {
    if (p.match === "rejected") continue;
    if (p.match === "compatible") {
      compatible.push(p);
      continue;
    }
    // exact
    (p.kind === "sale" ? sales : active).push(p);
  }
  return { sales, active, compatible };
}
