import { describe, expect, it } from "vitest";
import { normalizeMarketIntelligenceResponse } from "@/lib/market/response-schema";
import { normalizeProductList } from "@/lib/pricecharting/product";
import { parsePriceChartingProductResponse } from "@/lib/market/adapters/pricecharting";
import { parseEbayBrowseResponse } from "@/lib/market/adapters/ebay-active";
import { parseEbaySellerOrdersResponse } from "@/lib/market/adapters/ebay-sold";

describe("third-party response validation", () => {
  it("normalizes a missing-array market payload without throwing", () => {
    const result = normalizeMarketIntelligenceResponse({
      identity_hash: "abc",
      grade_tier: "raw",
      summary: { count: 1 },
      verified_sales: null,
      active_listings: "not-an-array",
      sources: undefined,
    });

    expect(result.verified_sales).toEqual([]);
    expect(result.active_listings).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.summary.count).toBe(1);
  });

  it("drops malformed market rows while preserving valid siblings", () => {
    const result = normalizeMarketIntelligenceResponse({
      verified_sales: [
        null,
        { source: "ebay_sold", price_cents: "bad" },
        {
          source: "ebay_sold",
          kind: "sale",
          price_cents: 12500,
          currency: "USD",
          observed_at: "2026-07-21T00:00:00.000Z",
          grade_tier: "psa_10",
          match: "exact",
        },
      ],
    });

    expect(result.verified_sales).toHaveLength(1);
    expect(result.verified_sales[0].price_cents).toBe(12500);
  });

  it("rejects a malformed PriceCharting products collection", () => {
    expect(() => normalizeProductList({ products: {} })).toThrow(/expected an array/i);
  });

  it("rejects malformed provider collection fields before mapping", () => {
    expect(() => parsePriceChartingProductResponse({ tiers: {} })).toThrow(/expected an array/i);
    expect(() => parseEbayBrowseResponse({ itemSummaries: {} })).toThrow(/expected an array/i);
    expect(() => parseEbaySellerOrdersResponse({ orders: {} })).toThrow(/expected an array/i);
  });

  it("accepts valid numeric strings only at provider price boundaries", () => {
    const priceCharting = parsePriceChartingProductResponse({
      product_id: "123",
      product_name: "Card",
      tiers: [{ price_cents: "1999", grader: "PSA", grade: "10" }],
    });
    const ebay = parseEbayBrowseResponse({
      itemSummaries: [{ title: "Card", price: { value: "19.99", currency: "USD" } }],
    });

    expect(priceCharting.tiers[0].price_cents).toBe(1999);
    expect(ebay.itemSummaries[0].price?.value).toBe(19.99);
  });
});
