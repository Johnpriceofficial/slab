/** Shared market-intelligence types. */

import type { GradeTier } from "./grade-tier";

/** Where a data point came from. */
export type MarketSource = "pricecharting" | "ebay_sold" | "ebay_active" | "population" | "manual";

/** A verified/completed sale vs an active (asking-price) listing. */
export type ListingKind = "sale" | "listing";

/** How a candidate relates to the target card + tier. */
export type MatchClass = "exact" | "compatible" | "rejected";

/** A loosely-shaped candidate as returned by a source, before normalization. */
export interface RawCandidate {
  source: MarketSource;
  title?: string | null;
  price_cents?: number | null;
  currency?: string | null;
  url?: string | null;
  /** true when this is a completed sale (vs an active listing). */
  sold?: boolean | null;
  sold_at?: string | null;
  observed_at?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_label?: string | null;
}

/** A normalized, canonical market data point. */
export interface MarketDataPoint {
  source: MarketSource;
  kind: ListingKind;
  price_cents: number;
  currency: string;
  observed_at: string;
  sold_at: string | null;
  grade_tier: GradeTier;
  match: MatchClass;
  url: string | null;
  title: string | null;
}

export interface MarketSummary {
  count: number;
  last_sale_cents: number | null;
  last_sale_at: string | null;
  highest_cents: number | null;
  lowest_cents: number | null;
  median_cents: number | null;
  average_cents: number | null;
}
