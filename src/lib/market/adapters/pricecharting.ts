/**
 * PriceCharting adapter. Maps a PriceCharting product response (per-tier
 * realized values) into normalized sale candidates — one per priced tier. These
 * are sold-based aggregate values, so they are treated as verified sales.
 *
 * Provider fields stay in this file: the map emits only RawCandidates.
 */

import type { RawCandidate } from "../types";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapter } from "./run";

/** The isolated PriceCharting product response shape (only what we consume). */
export interface PriceChartingProductResponse {
  product_id: string;
  product_name: string;
  url?: string | null;
  sales_volume?: number | null;
  /** One entry per grade tier the product prices. */
  tiers: Array<{
    grader?: string | null;
    grade?: string | null;
    grade_label?: string | null;
    price_cents: number | null;
  }>;
}

/** Pure: PriceCharting product → sale candidates (one per priced tier). */
export function mapPriceCharting(response: PriceChartingProductResponse, retrievedAt: string): RawCandidate[] {
  return (response.tiers ?? [])
    .filter((t) => typeof t.price_cents === "number" && t.price_cents! > 0)
    .map((t) => ({
      source: "pricecharting" as const,
      title: response.product_name,
      price_cents: t.price_cents!,
      currency: "USD",
      url: response.url ?? null,
      sold: true, // PriceCharting values are realized-sale aggregates
      sold_at: retrievedAt,
      observed_at: retrievedAt,
      grader: t.grader ?? null,
      grade: t.grade ?? null,
      grade_label: t.grade_label ?? null,
    }));
}

export function fetchPriceCharting(args: { url: string; query: string }, ctx: AdapterContext): Promise<AdapterResult> {
  return runAdapter("pricecharting", args.query, ctx, { url: args.url }, (body, at) =>
    mapPriceCharting(body as PriceChartingProductResponse, at),
  );
}
