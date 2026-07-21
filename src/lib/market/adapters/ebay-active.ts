/**
 * eBay active-listing adapter. Validates Browse API item summaries before
 * mapping them into asking-price context. Unsupported payloads become a typed
 * parse_error and never reach rendering code.
 */

import type { RawCandidate } from "../types";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapter } from "./run";
import {
  optionalArray,
  optionalNumberLike,
  optionalRecord,
  optionalString,
  requireRecord,
} from "@/lib/providers/response-schema";

export interface EbayBrowseResponse {
  itemSummaries: Array<{
    title: string | null;
    itemWebUrl: string | null;
    price: { value: number | null; currency: string | null } | null;
  }>;
}

export function parseEbayBrowseResponse(value: unknown): EbayBrowseResponse {
  const body = requireRecord("eBay Browse", value);
  const itemSummaries = optionalArray("eBay Browse", body.itemSummaries, "$.itemSummaries").map((item, index) => {
    const row = optionalRecord("eBay Browse", item, `$.itemSummaries[${index}]`);
    if (!row) throw new Error("item summary missing");
    const price = optionalRecord("eBay Browse", row.price, `$.itemSummaries[${index}].price`);
    return {
      title: optionalString("eBay Browse", row.title, `$.itemSummaries[${index}].title`),
      itemWebUrl: optionalString("eBay Browse", row.itemWebUrl, `$.itemSummaries[${index}].itemWebUrl`),
      price: price ? {
        value: optionalNumberLike("eBay Browse", price.value, `$.itemSummaries[${index}].price.value`),
        currency: optionalString("eBay Browse", price.currency, `$.itemSummaries[${index}].price.currency`),
      } : null,
    };
  });
  return { itemSummaries };
}

export function mapEbayActive(response: EbayBrowseResponse, retrievedAt: string): RawCandidate[] {
  return response.itemSummaries
    .map((item) => ({
      source: "ebay_active" as const,
      title: item.title,
      price_cents: item.price?.value && item.price.value > 0 ? Math.round(item.price.value * 100) : null,
      currency: (item.price?.currency ?? "USD").toUpperCase(),
      url: item.itemWebUrl,
      sold: false,
      sold_at: null,
      observed_at: retrievedAt,
    }))
    .filter((candidate) => candidate.price_cents !== null);
}

export function fetchEbayActive(args: { url: string; query: string; token?: string }, ctx: AdapterContext): Promise<AdapterResult> {
  const headers = args.token ? { Authorization: `Bearer ${args.token}` } : undefined;
  return runAdapter("ebay_active", args.query, ctx, { url: args.url, headers }, (body, at) =>
    mapEbayActive(parseEbayBrowseResponse(body), at),
  );
}
