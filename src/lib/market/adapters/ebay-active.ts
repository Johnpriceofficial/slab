/**
 * eBay active-listing adapter. Maps eBay Browse item summaries into ACTIVE
 * listing candidates (asking prices). These are supply/replacement context and
 * — by the locked market rules — never enter sold-median, last-sold, liquidity,
 * or realized-value math; the listings separator keeps them apart downstream.
 */

import type { RawCandidate } from "../types";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapter } from "./run";

/** Isolated eBay Browse response shape (only what we consume). */
export interface EbayBrowseResponse {
  itemSummaries?: Array<{
    title?: string | null;
    itemWebUrl?: string | null;
    price?: { value?: string | number | null; currency?: string | null } | null;
  }> | null;
}

function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Pure: eBay Browse summaries → active listing candidates. */
export function mapEbayActive(response: EbayBrowseResponse, retrievedAt: string): RawCandidate[] {
  return (response.itemSummaries ?? [])
    .map((item) => ({
      source: "ebay_active" as const,
      title: item.title ?? null,
      price_cents: toCents(item.price?.value),
      currency: (item.price?.currency ?? "USD").toUpperCase(),
      url: item.itemWebUrl ?? null,
      sold: false,
      sold_at: null,
      observed_at: retrievedAt,
    }))
    .filter((c) => c.price_cents !== null);
}

export function fetchEbayActive(args: { url: string; query: string; token?: string }, ctx: AdapterContext): Promise<AdapterResult> {
  const headers = args.token ? { Authorization: `Bearer ${args.token}` } : undefined;
  return runAdapter("ebay_active", args.query, ctx, { url: args.url, headers }, (body, at) => mapEbayActive(body as EbayBrowseResponse, at));
}
