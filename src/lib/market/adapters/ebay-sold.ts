/**
 * Connected-seller verified-sale adapter. Validates completed-order payloads
 * before mapping fulfilled/paid line items into verified sale candidates.
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

export interface EbaySellerOrdersResponse {
  orders: Array<{
    orderFulfillmentStatus?: string | null;
    lineItems?: Array<{
      title?: string | null;
      soldAt?: string | null;
      lineItemCost?: { value?: string | number | null; currency?: string | null } | null;
    }>;
  }>;
}

export function parseEbaySellerOrdersResponse(value: unknown): EbaySellerOrdersResponse {
  const body = requireRecord("eBay Fulfillment", value);
  const orders = optionalArray("eBay Fulfillment", body.orders, "$.orders").map((order, orderIndex) => {
    const row = optionalRecord("eBay Fulfillment", order, `$.orders[${orderIndex}]`);
    if (!row) throw new Error("order missing");
    const lineItems = optionalArray("eBay Fulfillment", row.lineItems, `$.orders[${orderIndex}].lineItems`).map((item, itemIndex) => {
      const line = optionalRecord("eBay Fulfillment", item, `$.orders[${orderIndex}].lineItems[${itemIndex}]`);
      if (!line) throw new Error("line item missing");
      const cost = optionalRecord("eBay Fulfillment", line.lineItemCost, `$.orders[${orderIndex}].lineItems[${itemIndex}].lineItemCost`);
      return {
        title: optionalString("eBay Fulfillment", line.title, `$.orders[${orderIndex}].lineItems[${itemIndex}].title`),
        soldAt: optionalString("eBay Fulfillment", line.soldAt, `$.orders[${orderIndex}].lineItems[${itemIndex}].soldAt`),
        lineItemCost: cost ? {
          value: optionalNumberLike("eBay Fulfillment", cost.value, `$.orders[${orderIndex}].lineItems[${itemIndex}].lineItemCost.value`),
          currency: optionalString("eBay Fulfillment", cost.currency, `$.orders[${orderIndex}].lineItems[${itemIndex}].lineItemCost.currency`),
        } : null,
      };
    });
    return {
      orderFulfillmentStatus: optionalString("eBay Fulfillment", row.orderFulfillmentStatus, `$.orders[${orderIndex}].orderFulfillmentStatus`),
      lineItems,
    };
  });
  return { orders };
}

export function mapEbaySold(response: EbaySellerOrdersResponse, retrievedAt: string): RawCandidate[] {
  const output: RawCandidate[] = [];
  for (const order of response.orders) {
    if (order.orderFulfillmentStatus && !/fulfilled|paid|complete/i.test(order.orderFulfillmentStatus)) continue;
    for (const item of order.lineItems ?? []) {
      const raw = item.lineItemCost?.value;
      const value = raw === null || raw === undefined ? null : Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      output.push({
        source: "ebay_sold",
        title: item.title ?? null,
        price_cents: Math.round(value * 100),
        currency: (item.lineItemCost?.currency ?? "USD").toUpperCase(),
        url: null,
        sold: true,
        sold_at: item.soldAt ?? retrievedAt,
        observed_at: retrievedAt,
      });
    }
  }
  return output;
}

export function fetchEbaySold(args: { url: string; query: string; token?: string }, ctx: AdapterContext): Promise<AdapterResult> {
  const headers = args.token ? { Authorization: `Bearer ${args.token}` } : undefined;
  return runAdapter("ebay_sold", args.query, ctx, { url: args.url, headers }, (body, at) =>
    mapEbaySold(parseEbaySellerOrdersResponse(body), at),
  );
}
