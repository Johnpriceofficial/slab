import { describe, it, expect, vi } from "vitest";
import { buildIdentity } from "@/lib/identity/identity";
import {
  mapPriceCharting, fetchPriceCharting, type PriceChartingProductResponse,
  mapEbayActive, fetchEbayActive, type EbayBrowseResponse,
  mapEbaySold, type EbaySellerOrdersResponse,
  mapManualComps,
  cacheKey,
  throttleDelayMs, isAllowed, recordRequest, DEFAULT_MIN_INTERVAL_MS,
  type AdapterFetch, type AdapterHttpResponse,
} from "@/lib/market/adapters";
import { classifyCandidates, separateMarket, summarizeSales } from "@/lib/market";

const AT = "2026-07-15T00:00:00Z";
const ok = (body: unknown): AdapterHttpResponse => ({ status: 200, ok: true, body });
const fail = (status: number): AdapterHttpResponse => ({ status, ok: false, body: null });
const ctx = (fetch: AdapterFetch) => ({ fetch, retrieved_at: AT });

describe("PriceCharting adapter", () => {
  const response: PriceChartingProductResponse = {
    product_id: "6910", product_name: "Charizard Base Set 4/102", url: "https://pc/6910",
    tiers: [
      { grade: null, price_cents: 20000 }, // raw
      { grader: "PSA", grade: "10", price_cents: 300000 },
      { grader: "PSA", grade: "9", price_cents: 60000 },
      { grader: "PSA", grade: "10", price_cents: null }, // dropped (no price)
    ],
  };

  it("maps priced tiers to verified sale candidates and drops unpriced tiers", () => {
    const candidates = mapPriceCharting(response, AT);
    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.source === "pricecharting" && c.sold === true)).toBe(true);
    expect(candidates.map((c) => c.price_cents)).toEqual([20000, 300000, 60000]);
  });

  it("fetch returns candidates on 200 and a typed error on failure", async () => {
    const good = await fetchPriceCharting({ url: "https://pc/6910", query: "Charizard" }, ctx(async () => ok(response)));
    expect(good.error).toBeNull();
    expect(good.candidates).toHaveLength(3);
    expect(good.provenance.candidate_count).toBe(3);

    const bad = await fetchPriceCharting({ url: "x", query: "y" }, ctx(async () => fail(429)));
    expect(bad.candidates).toEqual([]);
    expect(bad.error).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("captures a network throw as a retryable network_error", async () => {
    const res = await fetchPriceCharting({ url: "x", query: "y" }, ctx(async () => { throw new Error("boom"); }));
    expect(res.error).toMatchObject({ code: "network_error", retryable: true });
  });
});

describe("eBay active-listing adapter", () => {
  const response: EbayBrowseResponse = {
    itemSummaries: [
      { title: "Charizard 4/102 PSA 10", itemWebUrl: "https://ebay/1", price: { value: "450.00", currency: "USD" } },
      { title: "Charizard 4/102 PSA 10", itemWebUrl: "https://ebay/2", price: { value: null } }, // dropped
    ],
  };
  it("maps to ACTIVE listings (never sales)", () => {
    const c = mapEbayActive(response, AT);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: "ebay_active", sold: false, price_cents: 45000, sold_at: null });
  });
  it("passes a bearer token when provided", async () => {
    const fetch = vi.fn(async () => ok(response));
    await fetchEbayActive({ url: "https://ebay/search", query: "Charizard", token: "TKN" }, ctx(fetch));
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: "Bearer TKN" } }));
  });
});

describe("connected-seller verified-sale adapter", () => {
  const response: EbaySellerOrdersResponse = {
    orders: [
      { orderFulfillmentStatus: "FULFILLED", lineItems: [{ title: "Charizard 4/102 PSA 10", soldAt: "2026-07-10T00:00:00Z", lineItemCost: { value: "320.00", currency: "USD" } }] },
      { orderFulfillmentStatus: "NOT_STARTED", lineItems: [{ title: "Unpaid", lineItemCost: { value: "999.00" } }] }, // skipped
    ],
  };
  it("maps only fulfilled orders into verified sales", () => {
    const c = mapEbaySold(response, AT);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: "ebay_sold", sold: true, price_cents: 32000, sold_at: "2026-07-10T00:00:00Z" });
  });
});

describe("manual verified-comp adapter", () => {
  it("maps operator comps into verified sales and drops unpriced ones", () => {
    const c = mapManualComps([
      { title: "Charizard 4/102 PSA 10", price_cents: 31000, sold_at: "2026-07-01T00:00:00Z", grader: "PSA", grade: "10" },
      { title: "bad", price_cents: 0 },
    ], AT);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ source: "manual", sold: true, price_cents: 31000 });
  });
});

describe("cache key + rate limiting", () => {
  it("cache key is stable regardless of param order", () => {
    expect(cacheKey("ebay_sold", "abc", { b: 2, a: 1 })).toBe(cacheKey("ebay_sold", "abc", { a: 1, b: 2 }));
    expect(cacheKey("pricecharting", "abc")).toBe("pricecharting|abc");
  });
  it("rate limit gates by minimum interval, deterministically", () => {
    const state = { last_request_at: "2026-07-15T00:00:00Z", min_interval_ms: 1000 };
    expect(throttleDelayMs(state, "2026-07-15T00:00:00.400Z")).toBe(600);
    expect(isAllowed(state, "2026-07-15T00:00:00.400Z")).toBe(false);
    expect(isAllowed(state, "2026-07-15T00:00:02Z")).toBe(true);
    expect(isAllowed(recordRequest(state, "2026-07-15T00:00:02Z"), "2026-07-15T00:00:02Z")).toBe(false);
    expect(DEFAULT_MIN_INTERVAL_MS.manual).toBe(0);
  });
});

describe("strict pipeline: adapter → classifier → summary (no provider fields leak)", () => {
  it("feeds normalized candidates through the pure engine; asking prices never enter the sold median", async () => {
    const identity = await buildIdentity({ card_name: "Charizard", set: "Base Set", card_number: "4/102", language: "English", grader: "PSA", grade: "10" });

    // Two providers, mapped ONLY into RawCandidates.
    const sold = mapEbaySold({ orders: [
      { orderFulfillmentStatus: "FULFILLED", lineItems: [{ title: "Charizard 4/102 PSA 10", soldAt: "2026-07-10T00:00:00Z", lineItemCost: { value: "300.00" } }] },
      { orderFulfillmentStatus: "FULFILLED", lineItems: [{ title: "Charizard 4/102 PSA 10", soldAt: "2026-07-12T00:00:00Z", lineItemCost: { value: "340.00" } }] },
    ] }, AT).map((c) => ({ ...c, grader: "PSA", grade: "10" }));
    const active = mapEbayActive({ itemSummaries: [{ title: "Charizard 4/102 PSA 10", price: { value: "999.00" } }] }, AT).map((c) => ({ ...c, grader: "PSA", grade: "10" }));

    const points = classifyCandidates(identity, "grade_10", [...sold, ...active], AT);
    const { sales, active: activeOut } = separateMarket(points);
    const summary = summarizeSales(sales);

    expect(summary.count).toBe(2); // only the two sold
    expect(summary.median_cents).toBe(32000); // (30000+34000)/2 — the $999 asking price is excluded
    expect(summary.highest_cents).toBe(34000);
    expect(activeOut).toHaveLength(1);
  });
});
