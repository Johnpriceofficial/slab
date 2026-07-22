import { describe, it, expect } from "vitest";
import { fetchAllOffersForSku, validateNextUrl, type OffersFetchImpl } from "../../../supabase/functions/_shared/ebay-offers";

const O = "https://api.ebay.com";
const SANDBOX = "https://api.sandbox.ebay.com";
const SKU = "GCV000047";
const path = "/sell/inventory/v1/offer";
const first = `${O}${path}?sku=${SKU}&limit=100`;
const p2 = `${O}${path}?sku=${SKU}&limit=100&offset=100`;
const p3 = `${O}${path}?sku=${SKU}&limit=100&offset=200`;
const offer = (id: string) => ({ offerId: id, sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE" });

// URL→response map; an unmapped URL throws (surfaces accidental over-fetch).
function mock(pages: Record<string, { status: number; body: unknown } | "throw">): OffersFetchImpl {
  return async (url) => {
    const p = pages[url];
    if (p === undefined) throw new Error(`unexpected url: ${url}`);
    if (p === "throw") throw new Error("network");
    return { ok: p.status >= 200 && p.status < 300, status: p.status, json: async () => p.body };
  };
}
const run = (pages: Parameters<typeof mock>[0], maxPages = 20) =>
  fetchAllOffersForSku({ fetchImpl: mock(pages), apiOrigin: O, accessToken: "AT", sku: SKU, maxPages });

describe("fetchAllOffersForSku — success paths", () => {
  it("one-page zero-offer success", async () => {
    const r = await run({ [first]: { status: 200, body: { offers: [], total: 0, size: 0 } } });
    expect(r).toMatchObject({ ok: true, offers: [], pagesFetched: 1 });
  });
  it("documented no-offer 404 → success (empty)", async () => {
    const r = await run({ [first]: { status: 404, body: { errors: [{ errorId: 25713 }] } } });
    expect(r).toMatchObject({ ok: true, offers: [], pagesFetched: 0 });
  });
  it("collects and dedupes across three pages", async () => {
    const r = await run({
      [first]: { status: 200, body: { offers: [offer("A"), offer("B")], total: 5, size: 2, next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("B"), offer("C")], total: 5, size: 2, next: p3 } }, // B duplicated
      [p3]: { status: 200, body: { offers: [offer("D"), offer("E")], total: 5, size: 1 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.offers.map((o) => o.offerId).sort()).toEqual(["A", "B", "C", "D", "E"]); expect(r.pagesFetched).toBe(3); expect(r.deduplicatedCount).toBe(1); }
  });
});

describe("fetchAllOffersForSku — fails closed", () => {
  it("arbitrary 404 (no documented no-offer id) → provider_lookup_failed", async () => {
    const r = await run({ [first]: { status: 404, body: { errors: [{ errorId: 99999 }] } } });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed", httpStatus: 404, safeProviderErrorId: 99999 });
  });
  it("a repeated next URL → pagination_loop (NOT partial success)", async () => {
    const r = await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 9, next: first } } }); // next points back to first
    expect(r).toMatchObject({ ok: false, errorCode: "pagination_loop" });
  });
  it("another page beyond the cap → pagination_limit_exceeded", async () => {
    const r = await run({
      [first]: { status: 200, body: { offers: [offer("A")], next: p2 } },
      [p2]: { status: 200, body: { offers: [offer("B")], next: p3 } },
    }, 2); // cap of 2; a 3rd page remains
    expect(r).toMatchObject({ ok: false, errorCode: "pagination_limit_exceeded" });
  });
  it("provider total greater than collected (no more pages) → incomplete_provider_result", async () => {
    const r = await run({ [first]: { status: 200, body: { offers: [offer("A")], total: 3, size: 1 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "incomplete_provider_result" });
  });
  it("page-two network failure → provider_lookup_failed", async () => {
    const r = await run({ [first]: { status: 200, body: { offers: [offer("A")], next: p2 } }, [p2]: "throw" });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed" });
  });
  it("page-two provider error → provider_lookup_failed", async () => {
    const r = await run({ [first]: { status: 200, body: { offers: [offer("A")], next: p2 } }, [p2]: { status: 500, body: { errors: [{ errorId: 500 }] } } });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_lookup_failed", httpStatus: 500 });
  });

  for (const [name, badNext] of [
    ["http (not https)", `http://api.ebay.com${path}?sku=${SKU}`],
    ["foreign origin", `https://evil.example.com${path}?sku=${SKU}`],
    ["same host, alternate port", `https://api.ebay.com:8443${path}?sku=${SKU}`],
    ["wrong path", `${O}/sell/inventory/v1/inventory_item?sku=${SKU}`],
    ["fragment", `${O}${path}?sku=${SKU}#x`],
    ["embedded credentials", `https://u:p@api.ebay.com${path}?sku=${SKU}`],
    ["different SKU", `${O}${path}?sku=GCV999999`],
  ] as const) {
    it(`rejects an unsafe next URL (${name}) → unsafe_pagination_url`, async () => {
      const r = await run({ [first]: { status: 200, body: { offers: [offer("A")], next: badNext } } });
      expect(r).toMatchObject({ ok: false, errorCode: "unsafe_pagination_url" });
    });
  }
});

describe("validateNextUrl", () => {
  it("accepts the exact approved origin + path + sku (production and sandbox)", () => {
    expect(validateNextUrl(`${O}${path}?sku=${SKU}&offset=100`, O, SKU).ok).toBe(true);
    expect(validateNextUrl(`${SANDBOX}${path}?sku=${SKU}`, SANDBOX, SKU).ok).toBe(true);
  });
  it("rejects protocol, origin, port, path, credentials, fragment, and SKU violations", () => {
    expect(validateNextUrl(`http://api.ebay.com${path}?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "protocol" });
    expect(validateNextUrl(`https://evil.com${path}?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "origin" });
    expect(validateNextUrl(`https://api.ebay.com:8443${path}?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "origin" });
    expect(validateNextUrl(`${O}/wrong/path?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "path" });
    expect(validateNextUrl(`https://u:p@api.ebay.com${path}?sku=${SKU}`, O, SKU)).toMatchObject({ ok: false, reason: "credentials" });
    expect(validateNextUrl(`${O}${path}?sku=${SKU}#frag`, O, SKU)).toMatchObject({ ok: false, reason: "fragment" });
    expect(validateNextUrl(`${O}${path}?sku=OTHER`, O, SKU)).toMatchObject({ ok: false, reason: "sku" });
    expect(validateNextUrl("not a url", O, SKU)).toMatchObject({ ok: false, reason: "unparseable" });
  });
});
