/**
 * PriceCharting adapter. Maps a validated PriceCharting product response into
 * normalized grade-tier candidates. Malformed upstream data becomes a typed
 * parse_error in runAdapter and never reaches the market engine.
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

export interface PriceChartingProductResponse {
  product_id: string;
  product_name: string;
  url?: string | null;
  sales_volume?: string | number | null;
  tiers: Array<{
    grader?: string | null;
    grade?: string | null;
    grade_label?: string | null;
    price_cents: string | number | null;
  }>;
}

export function parsePriceChartingProductResponse(value: unknown): PriceChartingProductResponse {
  const body = requireRecord("PriceCharting", value);
  const tiers = optionalArray("PriceCharting", body.tiers, "$.tiers").map((tier, index) => {
    const row = optionalRecord("PriceCharting", tier, `$.tiers[${index}]`);
    if (!row) throw new Error("tier missing");
    return {
      grader: optionalString("PriceCharting", row.grader, `$.tiers[${index}].grader`),
      grade: optionalString("PriceCharting", row.grade, `$.tiers[${index}].grade`),
      grade_label: optionalString("PriceCharting", row.grade_label, `$.tiers[${index}].grade_label`),
      price_cents: optionalNumberLike("PriceCharting", row.price_cents, `$.tiers[${index}].price_cents`),
    };
  });
  return {
    product_id: optionalString("PriceCharting", body.product_id, "$.product_id") ?? "",
    product_name: optionalString("PriceCharting", body.product_name, "$.product_name") ?? "Unknown product",
    url: optionalString("PriceCharting", body.url, "$.url"),
    sales_volume: optionalNumberLike("PriceCharting", body.sales_volume, "$.sales_volume"),
    tiers,
  };
}

export function mapPriceCharting(response: PriceChartingProductResponse, retrievedAt: string): RawCandidate[] {
  return response.tiers.flatMap((tier) => {
    const value = tier.price_cents === null || tier.price_cents === undefined ? null : Number(tier.price_cents);
    if (!Number.isFinite(value) || value <= 0) return [];
    return [{
      source: "pricecharting" as const,
      title: response.product_name,
      price_cents: Math.round(value),
      currency: "USD",
      url: response.url ?? null,
      sold: true,
      sold_at: retrievedAt,
      observed_at: retrievedAt,
      grader: tier.grader ?? null,
      grade: tier.grade ?? null,
      grade_label: tier.grade_label ?? null,
    }];
  });
}

export function fetchPriceCharting(args: { url: string; query: string }, ctx: AdapterContext): Promise<AdapterResult> {
  return runAdapter("pricecharting", args.query, ctx, { url: args.url }, (body, at) =>
    mapPriceCharting(parsePriceChartingProductResponse(body), at),
  );
}
