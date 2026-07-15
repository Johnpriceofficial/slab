/**
 * Connected-seller verified-sale adapter. Maps the connected eBay seller's
 * COMPLETED orders (fulfillment/transaction data) into verified sale candidates.
 * Unlike active listings, these are real realized prices and DO drive market
 * value. Only fulfilled/paid line items become sales.
 */

import type { RawCandidate } from "../types";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapter } from "./run";

/** Isolated connected-seller order response shape (only what we consume). */
export interface EbaySellerOrdersResponse {
  orders?: Array<{
    orderFulfillmentStatus?: string | null;
    lineItems?: Array<{
      title?: string | null;
      soldAt?: string | null;
      lineItemCost?: { value?: string | number | null; currency?: string | null } | null;
    }> | null;
  }> | null;
}

function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Pure: connected-seller orders → verified sale candidates. */
export function mapEbaySold(response: EbaySellerOrdersResponse, retrievedAt: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const order of response.orders ?? []) {
    // Only completed/fulfilled orders are verified sales.
    if (order.orderFulfillmentStatus && !/fulfilled|paid|complete/i.test(order.orderFulfillmentStatus)) continue;
    for (const item of order.lineItems ?? []) {
      const cents = toCents(item.lineItemCost?.value);
      if (cents === null) continue;
      out.push({
        source: "ebay_sold",
        title: item.title ?? null,
        price_cents: cents,
        currency: (item.lineItemCost?.currency ?? "USD").toUpperCase(),
        url: null,
        sold: true,
        sold_at: item.soldAt ?? retrievedAt,
        observed_at: retrievedAt,
      });
    }
  }
  return out;
}

export function fetchEbaySold(args: { url: string; query: string; token?: string }, ctx: AdapterContext): Promise<AdapterResult> {
  const headers = args.token ? { Authorization: `Bearer ${args.token}` } : undefined;
  return runAdapter("ebay_sold", args.query, ctx, { url: args.url, headers }, (body, at) => mapEbaySold(body as EbaySellerOrdersResponse, at));
}
