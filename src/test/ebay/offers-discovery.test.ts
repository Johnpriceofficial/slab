import { describe, it, expect } from "vitest";
import { fetchAllOffersForSku, validateNextUrl, validateApiOrigin, canonicalizeUrl, type OffersFetchImpl } from "../../../supabase/functions/_shared/ebay-offers";

const O = "https://api.ebay.com";
const SANDBOX = "https://api.sandbox.ebay.com";
const SKU = "GCV000047";
const path = "/sell/inventory/v1/offer";
const first = `${O}${path}?sku=${SKU}&limit=100`;
const p2 = `${O}${path}?sku=${SKU}&limit=100&offset=100`;
const p3 = `${O}${path}?sku=${SKU}&limit=100&offset=200`;
const offer = (id: string) => ({ offerId: id, sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE" });

function mock(pages: Record<string, { status: number; body: unknown } | "throw">): { impl: OffersFetchImpl; calls: () => number } {
  let calls = 0;
  const impl: OffersFetchImpl = async (url) => {
    calls += 1;
    const p = pages[url];
    if (p === undefined) throw new Error(`unexpected url: ${url}`);
    if (p === "throw") throw new Error("network");
    return { ok: p.status >= 200 && p.status < 300, status: p.status, json: async () => p.body };
  };
  return { impl, calls: () => calls };
}
const run = (pages: Parameters<typeof mock>[0], maxPages = 20, origin = O) => {
  const m = mock(pages);
  return fetchAllOffersForSku({ fetchImpl: m.impl, apiOrigin: origin, accessToken: "AT", sku: SKU, maxPages }).then((r) => ({ r, calls: m.calls() }));
};

describe("fetchAllOffersForSku — success", () => {
  it("one-page zero-offer with coherent metadata", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [], total: 0, size: 0 } } });
    expect(r).toMatchObject({ ok: true, offers: [], pagesFetched: 1 });
  });
  it("documented no-offer 404 → empty success", async () => {
    const { r } = await run({ [first]: { status: 404, body: { errors: [{ errorId: 25713 }] } } });
    expect(r).toMatchObject({ ok: true, offers: [] });
  });
  it("collects across three coherent pages (total constant, size=page count, offset monotonic)", async () => {
    const { r } = await run({
      [first]: { status: 200, body: { offers: [offer("A"), offer("B")], total: 5, size: 2, offset: 0, next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("C"), offer("D")], total: 5, size: 2, offset: 100, next: p3 } },
      [p3]: { status: 200, body: { offers: [offer("E")], total: 5, size: 1, offset: 200 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.offers.map((o) => o.offerId).sort()).toEqual(["A", "B", "C", "D", "E"]); expect(r.pagesFetched).toBe(3); }
  });
});

describe("fetchAllOffersForSku — redirects fail closed", () => {
  for (const status of [301, 302, 307, 308]) {
    it(`a ${status} redirect → provider_redirect_rejected, fetched exactly once`, async () => {
      const { r, calls } = await run({ [first]: { status, body: {} } });
      expect(r).toMatchObject({ ok: false, errorCode: "provider_redirect_rejected", httpStatus: status });
      expect(calls).toBe(1); // the redirect target is NEVER fetched (token not forwarded)
    });
  }
});

describe("fetchAllOffersForSku — apiOrigin + fails closed", () => {
  it("rejects an unapproved apiOrigin BEFORE any fetch", async () => {
    const { r, calls } = await run({}, 20, "https://evil.example.com");
    expect(r).toMatchObject({ ok: false, errorCode: "invalid_api_origin" });
    expect(calls).toBe(0);
  });
  it("arbitrary 404 → provider_lookup_failed", async () => {
    const { r } = await run({ [first]: { status: 404, body: { errors: [{ errorId: 99999 }] } } });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed", httpStatus: 404 });
  });
  it("repeated next → pagination_loop", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 9, next: first } } });
    expect(r).toMatchObject({ ok: false, errorCode: "pagination_loop" });
  });
  it("page beyond the cap → pagination_limit_exceeded", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 9, next: p2 } }, [p2]: { status: 200, body: { offers: [offer("B")], total: 9, next: p3 } } }, 2);
    expect(r).toMatchObject({ ok: false, errorCode: "pagination_limit_exceeded" });
  });
  it("total greater than collected → incomplete_provider_result", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 3, size: 1 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "incomplete_provider_result" });
  });
  it("page-two network failure / provider error → provider_lookup_failed", async () => {
    expect((await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 9, next: p2 } }, [p2]: "throw" })).r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed" });
    expect((await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 9, next: p2 } }, [p2]: { status: 500, body: {} } })).r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed", httpStatus: 500 });
  });

  for (const [name, badNext] of [
    ["http", `http://api.ebay.com${path}?sku=${SKU}`],
    ["foreign origin", `https://evil.example.com${path}?sku=${SKU}`],
    ["alternate port", `https://api.ebay.com:8443${path}?sku=${SKU}`],
    ["wrong path", `${O}/sell/inventory/v1/inventory_item?sku=${SKU}`],
    ["fragment", `${O}${path}?sku=${SKU}#x`],
    ["credentials", `https://u:p@api.ebay.com${path}?sku=${SKU}`],
    ["different SKU", `${O}${path}?sku=GCV999999`],
    ["two sku params", `${O}${path}?sku=${SKU}&sku=OTHER`],
  ] as const) {
    it(`unsafe next URL (${name}) → unsafe_pagination_url`, async () => {
      const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], next: badNext } } });
      expect(r).toMatchObject({ ok: false, errorCode: "unsafe_pagination_url" });
    });
  }
});

describe("fetchAllOffersForSku — incoherent pagination metadata", () => {
  it("changing total across pages → inconsistent_provider_pagination", async () => {
    const { r } = await run({
      [first]: { status: 200, body: { offers: [offer("A")], total: 200, size: 1, offset: 0, next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("B")], total: 2, size: 1, offset: 100 } },
    });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
  it("size not equal to the page offer count → inconsistent_provider_pagination", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], size: 5 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
  it("non-monotonic offset → inconsistent_provider_pagination", async () => {
    const { r } = await run({
      [first]: { status: 200, body: { offers: [offer("A")], total: 9, size: 1, offset: 100, next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("B")], size: 1, offset: 100 } }, // not advancing
    });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
  it("an offerId repeated across pages → inconsistent_provider_pagination (not silently deduped)", async () => {
    const { r } = await run({
      [first]: { status: 200, body: { offers: [offer("A")], total: 9, size: 1, offset: 0, next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("A")], size: 1, offset: 100 } },
    });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
});

describe("fetchAllOffersForSku — malformed 2xx fails closed (invalid_provider_response)", () => {
  const cases: Array<[string, unknown]> = [
    ["null body (unparseable JSON)", null],
    ["non-object body", "not an object"],
    ["missing offers field", { total: 0 }],
    ["offers not an array", { offers: "nope" }],
    ["offer entry missing offerId", { offers: [{ sku: SKU }] }],
    ["offer entry not an object", { offers: ["x"] }],
    ["non-integer total", { offers: [], total: "5" }],
    ["negative offset", { offers: [], offset: -1 }],
    ["non-safe-integer size", { offers: [], size: 1.5 }],
  ];
  for (const [name, body] of cases) {
    it(`${name} → invalid_provider_response`, async () => {
      const { r } = await run({ [first]: { status: 200, body } });
      expect(r).toMatchObject({ ok: false, errorCode: "invalid_provider_response" });
    });
  }
  it("a paginated page (has next) without a total → invalid_provider_response", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [offer("A")], next: p2 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "invalid_provider_response" });
  });
  it("href not matching the current URL → inconsistent_provider_pagination", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [], total: 0, href: `${O}${path}?sku=${SKU}&limit=999` } } });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
  it("an unsafe prev URL → inconsistent_provider_pagination", async () => {
    const { r } = await run({ [first]: { status: 200, body: { offers: [], total: 0, prev: "https://evil.example.com/x" } } });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
});

describe("no-offer 404 classification", () => {
  it("accepts empty ONLY when EVERY error is a documented no-offer id", async () => {
    expect((await run({ [first]: { status: 404, body: { errors: [{ errorId: 25702 }] } } })).r.ok).toBe(true);
    // mixed accepted + unknown → NOT empty
    expect((await run({ [first]: { status: 404, body: { errors: [{ errorId: 25702 }, { errorId: 99999 }] } } })).r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed" });
    // multiple unknown, empty array, malformed → NOT empty
    expect((await run({ [first]: { status: 404, body: { errors: [{ errorId: 1 }, { errorId: 2 }] } } })).r.ok).toBe(false);
    expect((await run({ [first]: { status: 404, body: { errors: [] } } })).r.ok).toBe(false);
    expect((await run({ [first]: { status: 404, body: {} } })).r.ok).toBe(false);
    // 25710 (generic missing-resource) is NOT accepted as a getOffers no-offer result
    expect((await run({ [first]: { status: 404, body: { errors: [{ errorId: 25710 }] } } })).r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed" });
  });
});

describe("validateApiOrigin / canonicalizeUrl / validateNextUrl", () => {
  it("validateApiOrigin approves only bare approved eBay origins", () => {
    expect(validateApiOrigin(O)).toBe(true);
    expect(validateApiOrigin(SANDBOX)).toBe(true);
    expect(validateApiOrigin("https://api.ebay.com/sell")).toBe(false);
    expect(validateApiOrigin("https://api.ebay.com?x=1")).toBe(false);
    expect(validateApiOrigin("http://api.ebay.com")).toBe(false);
    expect(validateApiOrigin("https://evil.example.com")).toBe(false);
  });
  it("canonicalizeUrl makes query order irrelevant for loop detection", () => {
    expect(canonicalizeUrl(`${O}${path}?b=2&a=1`)).toBe(canonicalizeUrl(`${O}${path}?a=1&b=2`));
  });
  it("validateNextUrl accepts prod + sandbox, rejects two-sku and violations", () => {
    expect(validateNextUrl(`${O}${path}?sku=${SKU}&offset=100`, O, SKU).ok).toBe(true);
    expect(validateNextUrl(`${SANDBOX}${path}?sku=${SKU}`, SANDBOX, SKU).ok).toBe(true);
    expect(validateNextUrl(`${O}${path}?sku=${SKU}&sku=OTHER`, O, SKU)).toMatchObject({ ok: false, reason: "sku" });
    expect(validateNextUrl(`https://api.ebay.com:8443${path}?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "origin" });
  });
});
