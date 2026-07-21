import { describe, it, expect } from "vitest";
import { buildIdentity } from "@/lib/identity/identity";
import { buildMarketIntelligence } from "@/server/market-intelligence/engine";
import { mapPriceCharting, mapEbayActive, mapEbaySold, type AdapterResult } from "@/lib/market/adapters";
import { buildProvenance } from "@/lib/market/provenance";

const AT = "2026-07-15T00:00:00Z";

function result(source: AdapterResult["source"], candidates: AdapterResult["candidates"]): AdapterResult {
  return { source, candidates, provenance: buildProvenance({ source, query: "q", retrieved_at: AT, candidate_count: candidates.length, exact_count: 0 }), error: null };
}

describe("buildMarketIntelligence orchestrator", () => {
  it("assembles sales, listings, tiers, summary, liquidity, confidence — asking prices never in the median", async () => {
    const identity = await buildIdentity({ card_name: "Charizard", set: "Base Set", card_number: "4/102", language: "English", grader: "PSA", grade: "10" });

    const pc = result("pricecharting", mapPriceCharting({
      product_id: "6910", product_name: "Charizard Base Set 4/102",
      tiers: [{ grade: null, price_cents: 20000 }, { grader: "PSA", grade: "10", price_cents: 300000 }],
    }, AT).map((c) => ({ ...c })));

    const sold = result("ebay_sold", mapEbaySold({ orders: [
      { orderFulfillmentStatus: "FULFILLED", lineItems: [{ title: "Charizard 4/102 PSA 10", soldAt: "2026-07-12T00:00:00Z", lineItemCost: { value: "310.00" } }] },
      { orderFulfillmentStatus: "FULFILLED", lineItems: [{ title: "Charizard 4/102 PSA 10", soldAt: "2026-07-10T00:00:00Z", lineItemCost: { value: "290.00" } }] },
    ] }, AT).map((c) => ({ ...c, grader: "PSA", grade: "10" })));

    const active = result("ebay_active", mapEbayActive({ itemSummaries: [{ title: "Charizard 4/102 PSA 10", price: { value: "999.00" } }] }, AT).map((c) => ({ ...c, grader: "PSA", grade: "10" })));

    const mi = buildMarketIntelligence(identity, "grade_10", [pc, sold, active], AT);

    // Verified sales are the two individual eBay sold prices — NOT PriceCharting
    // aggregates and NOT the asking price.
    expect(mi.verified_sales.map((s) => s.price_cents).sort()).toEqual([29000, 31000]);
    expect(mi.median_sold_cents).toBe(30000);
    expect(mi.high_sold_cents).toBe(31000);
    // Active listing (the $999 asking) is separate supply context, never a sale.
    expect(mi.active_listings).toHaveLength(1);
    expect(mi.lowest_active_cents).toBe(99900);
    expect(mi.verified_sales.every((s) => s.price_cents !== 99900)).toBe(true);
    // PriceCharting populates the tier reference table only (raw + grade_10).
    expect(mi.grade_tiers.map((t) => t.tier).sort()).toEqual(["grade_10", "raw"]);
    expect(mi.liquidity).toBeGreaterThan(0);
    expect(mi.confidence).toBeGreaterThan(0);
    expect(mi.identity_hash).toBe(identity.hash);
  });

  it("degrades cleanly when a source failed (empty candidates) and records provenance", async () => {
    const identity = await buildIdentity({ card_name: "Pikachu", set: "Jungle", card_number: "60/64" });
    const failed: AdapterResult = { source: "ebay_active", candidates: [], provenance: buildProvenance({ source: "ebay_active", query: "q", retrieved_at: AT, candidate_count: 0, exact_count: 0 }), error: { source: "ebay_active", code: "unauthorized", message: "no creds", retryable: false } };
    const mi = buildMarketIntelligence(identity, "raw", [failed], AT);
    expect(mi.verified_sales).toEqual([]);
    expect(mi.median_sold_cents).toBeNull();
    expect(mi.confidence).toBe(0);
    expect(mi.provenance).toHaveLength(1);
  });
});
