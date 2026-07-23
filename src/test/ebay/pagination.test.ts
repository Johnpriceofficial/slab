import { describe, it, expect } from "vitest";
import { fetchAllEbayOrders, validateOrder, ORDERS_PATH } from "../../../supabase/functions/_shared/ebay-orders-pagination";
import { fetchAllEbayFinanceTransactions, validateTransaction, FINANCE_PATH } from "../../../supabase/functions/_shared/ebay-finances-pagination";
import type { PageFetchImpl } from "../../../supabase/functions/_shared/ebay-pagination-core";

const O = "https://api.ebay.com";
const APIZ = "https://apiz.ebay.com";
const ordersUrl = (offset?: number) => `${O}${ORDERS_PATH}?limit=200${offset ? `&offset=${offset}` : ""}`;
const order = (id: string, sku = "GCV000047") => ({ orderId: id, orderFulfillmentStatus: "FULFILLED", lineItems: [{ lineItemId: `${id}-L`, sku, quantity: "1" }] });
const txn = (id: string) => ({ transactionId: id, transactionDate: "2026-07-01T00:00:00Z", transactionStatus: "FUNDS_AVAILABLE", transactionType: "SALE", amount: { value: "10.00", currency: "USD" } });

function mock(pages: Record<string, { status: number; body: unknown } | "throw" | "hang">): { impl: PageFetchImpl; calls: () => number } {
  let calls = 0;
  const impl: PageFetchImpl = (url) => {
    calls += 1;
    const p = pages[url];
    if (p === undefined) throw new Error(`unexpected url: ${url}`);
    if (p === "throw") return Promise.reject(new Error("network"));
    if (p === "hang") return new Promise(() => {});
    return Promise.resolve({ ok: p.status >= 200 && p.status < 300, status: p.status, json: async () => p.body });
  };
  return { impl, calls: () => calls };
}
const runOrders = (pages: Parameters<typeof mock>[0], maxPages = 50) => {
  const m = mock(pages);
  return fetchAllEbayOrders({ fetchImpl: m.impl, apiOrigin: O, accessToken: "AT", maxPages, timeoutMs: 20 }).then((r) => ({ r, calls: m.calls() }));
};
const runOrdersGuarded = (pages: Parameters<typeof mock>[0], beforePageFetch: () => Promise<boolean>) => {
  const m = mock(pages);
  return fetchAllEbayOrders({ fetchImpl: m.impl, apiOrigin: O, accessToken: "AT", maxPages: 50, timeoutMs: 20, beforePageFetch }).then((r) => ({ r, calls: m.calls() }));
};

describe("validateOrder / validateTransaction — strict item contracts", () => {
  it("order requires a non-empty orderId + valid line items", () => {
    expect(validateOrder(order("1")).ok).toBe(true);
    expect(validateOrder({ orderId: "" }).ok).toBe(false);
    expect(validateOrder({ lineItems: [] }).ok).toBe(false);
    expect(validateOrder({ orderId: "1", lineItems: [{ sku: "x" }] }).ok).toBe(false); // line missing lineItemId
    expect(validateOrder({ orderId: "1", lineItems: "nope" }).ok).toBe(false);
  });
  it("strict line-item identity: lineItems must be a present, NON-EMPTY array of uniquely-identified objects", () => {
    // A present, non-empty lineItems array is REQUIRED (an order always carries ≥1 line).
    expect(validateOrder({ orderId: "1" }).ok).toBe(false);                                   // missing lineItems
    expect(validateOrder({ orderId: "1", lineItems: "nope" }).ok).toBe(false);                // non-array lineItems
    expect(validateOrder({ orderId: "1", lineItems: [] }).ok).toBe(false);                    // EMPTY array → no sale lines
    expect(validateOrder({ orderId: "1", lineItems: [42] }).ok).toBe(false);                  // non-object line
    expect(validateOrder({ orderId: "1", lineItems: [{ sku: "x" }] }).ok).toBe(false);        // line missing lineItemId
    expect(validateOrder({ orderId: "1", lineItems: [{ lineItemId: "" }] }).ok).toBe(false);  // empty lineItemId
    // Whitespace-only identities are rejected.
    expect(validateOrder({ orderId: "   ", lineItems: [{ lineItemId: "L1" }] }).ok).toBe(false);   // whitespace orderId
    expect(validateOrder({ orderId: "1", lineItems: [{ lineItemId: "  \t " }] }).ok).toBe(false);  // whitespace lineItemId
    // A single valid line works, and the EXACT provider ids are preserved (not trimmed).
    const one = validateOrder({ orderId: " ORDER-1 ", lineItems: [{ lineItemId: " L1 ", sku: "GCV000047" }] });
    expect(one.ok).toBe(true);
    if (one.ok) { expect(one.id).toBe(" ORDER-1 "); expect((one.item.lineItems as Array<{ lineItemId: string }>)[0].lineItemId).toBe(" L1 "); }
    // Two distinct line ids work.
    expect(validateOrder({ orderId: "1", lineItems: [{ lineItemId: "L1" }, { lineItemId: "L2" }] }).ok).toBe(true);
  });
  it("strict line-item identity: ANY repeated lineItemId in one order fails closed (identical OR conflicting)", () => {
    const dup = (a: Record<string, unknown>, b: Record<string, unknown>) => validateOrder({ orderId: "1", lineItems: [{ lineItemId: "L1", ...a }, { lineItemId: "L1", ...b }] });
    // identical duplicate copies → rejected (never two shaped lines)
    expect(dup({ sku: "GCV000047", quantity: "1", total: { value: "10.00" } }, { sku: "GCV000047", quantity: "1", total: { value: "10.00" } }).ok).toBe(false);
    // conflicting duplicates on slab-relevant data → rejected
    expect(dup({ sku: "GCV000047" }, { sku: "GCV000099" }).ok).toBe(false);                    // different SKU
    expect(dup({ quantity: "1" }, { quantity: "2" }).ok).toBe(false);                          // different quantity
    expect(dup({ total: { value: "10.00" } }, { total: { value: "99.00" } }).ok).toBe(false);  // different price
    expect(dup({ lineItemFulfillmentStatus: "FULFILLED" }, { lineItemFulfillmentStatus: "NOT_STARTED" }).ok).toBe(false); // different status
    // three lines where the 3rd repeats the 1st → rejected
    expect(validateOrder({ orderId: "1", lineItems: [{ lineItemId: "L1" }, { lineItemId: "L2" }, { lineItemId: "L1" }] }).ok).toBe(false);
  });
  it("transaction requires a non-empty transactionId; unknown enums preserved, malformed amount rejected", () => {
    expect(validateTransaction(txn("T1")).ok).toBe(true);
    expect(validateTransaction({ transactionId: "T1", transactionStatus: "SOME_UNKNOWN_CODE" }).ok).toBe(true); // unknown enum kept
    expect(validateTransaction({ transactionId: "" }).ok).toBe(false);
    expect(validateTransaction({ transactionId: "T1", amount: "nope" }).ok).toBe(false);
    expect(validateTransaction({ transactionId: "T1", transactionStatus: 5 }).ok).toBe(false);
  });
});

describe("fetchAllEbayOrders — pagination recovery matrix", () => {
  it("one page (exact final page)", async () => {
    const { r } = await runOrders({ [ordersUrl()]: { status: 200, body: { orders: [order("A"), order("B")], total: 2, size: 2, offset: 0 } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items.map((o) => o.orderId)).toEqual(["A", "B"]);
  });
  it("empty result", async () => {
    const { r } = await runOrders({ [ordersUrl()]: { status: 200, body: { orders: [], total: 0, size: 0 } } });
    expect(r).toMatchObject({ ok: true, items: [] });
  });
  it("multiple pages via next", async () => {
    const { r } = await runOrders({
      [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 2, size: 1, offset: 0, next: ordersUrl(200) } },
      [ordersUrl(200)]: { status: 200, body: { orders: [order("B")], total: 2, size: 1, offset: 200 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.items.map((o) => o.orderId)).toEqual(["A", "B"]); expect(r.pagesFetched).toBe(2); }
  });
  it("identical duplicate across pages → deduped", async () => {
    const { r } = await runOrders({
      [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 1, size: 1, offset: 0, next: ordersUrl(200) } },
      [ordersUrl(200)]: { status: 200, body: { orders: [order("A")], total: 1, size: 1, offset: 200 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.items).toHaveLength(1); expect(r.deduplicatedCount).toBe(1); }
  });
  it("CONFLICTING duplicate across pages → fail closed", async () => {
    const { r } = await runOrders({
      [ordersUrl()]: { status: 200, body: { orders: [order("A", "GCV000001")], total: 2, size: 1, offset: 0, next: ordersUrl(200) } },
      [ordersUrl(200)]: { status: 200, body: { orders: [order("A", "GCV000999")], total: 2, size: 1, offset: 200 } },
    });
    expect(r).toMatchObject({ ok: false, errorCode: "inconsistent_provider_pagination" });
  });
  it("an order with a duplicate lineItemId in one page → malformed_provider_response (never reaches shaping)", async () => {
    const dupOrder = { orderId: "A", lineItems: [{ lineItemId: "L1", sku: "GCV000047" }, { lineItemId: "L1", sku: "GCV000099" }] };
    const { r } = await runOrders({ [ordersUrl()]: { status: 200, body: { orders: [dupOrder], total: 1, size: 1, offset: 0 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "malformed_provider_response" });
  });
  it("an EMPTY-line order in one page → malformed_provider_response through the real paginator", async () => {
    const emptyLineOrder = { orderId: "ORDER-1", lineItems: [] as unknown[] };
    const { r } = await runOrders({ [ordersUrl()]: { status: 200, body: { orders: [emptyLineOrder], total: 1, size: 1, offset: 0 } } });
    expect(r).toMatchObject({ ok: false, errorCode: "malformed_provider_response" });
  });
  const failCases: Array<[string, Parameters<typeof mock>[0], string]> = [
    ["repeated next URL → pagination_loop", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 5, size: 1, offset: 0, next: ordersUrl() } } }, "pagination_loop"],
    ["unsafe next host → unsafe_pagination_url", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 5, size: 1, offset: 0, next: "https://evil.example.com/sell/fulfillment/v1/order?limit=200" } } }, "unsafe_pagination_url"],
    ["unsafe next path → unsafe_pagination_url", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 5, size: 1, offset: 0, next: `${O}/sell/other?x=1` } } }, "unsafe_pagination_url"],
    ["redirect → provider_redirect_rejected", { [ordersUrl()]: { status: 302, body: {} } }, "provider_redirect_rejected"],
    ["malformed JSON → malformed_provider_response", { [ordersUrl()]: { status: 200, body: null } }, "malformed_provider_response"],
    ["malformed orders array → malformed_provider_response", { [ordersUrl()]: { status: 200, body: { orders: "nope", total: 0 } } }, "malformed_provider_response"],
    ["missing total → malformed_provider_response", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], size: 1 } } }, "malformed_provider_response"],
    ["inconsistent total across pages", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 3, size: 1, offset: 0, next: ordersUrl(200) } }, [ordersUrl(200)]: { status: 200, body: { orders: [order("B")], total: 9, size: 1, offset: 200 } } }, "inconsistent_provider_pagination"],
    ["non-increasing offset", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 2, size: 1, offset: 5, next: ordersUrl(200) } }, [ordersUrl(200)]: { status: 200, body: { orders: [order("B")], total: 2, size: 1, offset: 5 } } }, "inconsistent_provider_pagination"],
    ["size != page length", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 1, size: 9, offset: 0 } } }, "inconsistent_provider_pagination"],
    ["incomplete (collected < total, no next)", { [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 5, size: 1, offset: 0 } } }, "incomplete_provider_result"],
    ["provider failure (500)", { [ordersUrl()]: { status: 500, body: {} } }, "provider_lookup_failed"],
    ["network throw → provider_lookup_failed", { [ordersUrl()]: "throw" }, "provider_lookup_failed"],
    ["timeout (hang) → provider_timeout", { [ordersUrl()]: "hang" }, "provider_timeout"],
  ];
  for (const [name, pages, code] of failCases) {
    it(name, async () => { const { r } = await runOrders(pages); expect(r).toMatchObject({ ok: false, errorCode: code }); });
  }
  it("page cap exceeded", async () => {
    const p1 = ordersUrl(), p2 = ordersUrl(200);
    const { r } = await runOrders({ [p1]: { status: 200, body: { orders: [order("A")], total: 9, size: 1, offset: 0, next: p2 } }, [p2]: { status: 200, body: { orders: [order("B")], total: 9, size: 1, offset: 200, next: ordersUrl(400) } } }, 1);
    expect(r).toMatchObject({ ok: false, errorCode: "pagination_limit_exceeded" });
  });
  it("invalid api origin fails before any fetch", async () => {
    const r = await fetchAllEbayOrders({ fetchImpl: async () => { throw new Error("should not fetch"); }, apiOrigin: "https://evil.example.com", accessToken: "AT" });
    expect(r).toMatchObject({ ok: false, errorCode: "invalid_api_origin" });
  });
});

describe("finding #1 — the lease heartbeat guard runs before EVERY page fetch", () => {
  it("guard true on every call → all pages fetched, guard consulted once per page", async () => {
    let guardCalls = 0;
    const { r, calls } = await runOrdersGuarded({
      [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 2, size: 1, offset: 0, next: ordersUrl(200) } },
      [ordersUrl(200)]: { status: 200, body: { orders: [order("B")], total: 2, size: 1, offset: 200 } },
    }, async () => { guardCalls += 1; return true; });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(guardCalls).toBe(2); // consulted before page 1 AND page 2
  });
  it("guard false BEFORE the first page → sync_lease_lost, ZERO provider fetches", async () => {
    const { r, calls } = await runOrdersGuarded({ [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 1, size: 1, offset: 0 } } }, async () => false);
    expect(r).toMatchObject({ ok: false, errorCode: "sync_lease_lost" });
    expect(calls).toBe(0); // never even hit the provider
  });
  it("guard false BEFORE page N (lease lost mid-pagination) → sync_lease_lost, no further page", async () => {
    let n = 0;
    const { r, calls } = await runOrdersGuarded({
      [ordersUrl()]: { status: 200, body: { orders: [order("A")], total: 2, size: 1, offset: 0, next: ordersUrl(200) } },
      [ordersUrl(200)]: { status: 200, body: { orders: [order("B")], total: 2, size: 1, offset: 200 } },
    }, async () => { n += 1; return n === 1; }); // true for page 1, false before page 2
    expect(r).toMatchObject({ ok: false, errorCode: "sync_lease_lost" });
    expect(calls).toBe(1); // page 2 was never fetched
  });
});

describe("validateOrder / validateTransaction — expanded canonical conflict matrix (finding #5)", () => {
  const base = { orderId: "A", orderFulfillmentStatus: "FULFILLED", orderPaymentStatus: "PAID", creationDate: "2026-06-01T00:00:00Z", lastModifiedDate: "2026-07-01T00:00:00Z", pricingSummary: { total: { value: "10.00", currency: "USD" } }, lineItems: [{ lineItemId: "L1", sku: "GCV000047", quantity: "1", total: { value: "10.00", currency: "USD" }, lineItemFulfillmentStatus: "FULFILLED" }] };
  const canonOf = (o: unknown) => { const v = validateOrder(o); return v.ok ? v.canonical : "INVALID"; };
  it("orders: a change to ANY material field yields a DIFFERENT canonical (no false-identical)", () => {
    const b = canonOf(base);
    for (const over of [
      { orderFulfillmentStatus: "IN_PROGRESS" }, { orderPaymentStatus: "PENDING" }, { lastModifiedDate: "2026-07-02T00:00:00Z" },
      { pricingSummary: { total: { value: "12.00", currency: "USD" } } }, { cancelStatus: { cancelState: "CANCELED" } },
      { buyer: { username: "someone_else" } },                                  // buyer identity
      { fulfillmentStartInstructions: [{ shippingStep: { shipTo: { city: "Reno" } } }] }, // ship-to address
      { cancellation: { cancelReason: "BUYER_ASKED" } },                        // cancellation block
      { someFutureUnknownField: "provider-added-value" },                       // unknown top-level field preserved
      { lineItems: [{ lineItemId: "L1", sku: "GCV000099", quantity: "1", total: { value: "10.00", currency: "USD" }, lineItemFulfillmentStatus: "FULFILLED" }] },
      { lineItems: [{ lineItemId: "L1", sku: "GCV000047", quantity: "2", total: { value: "10.00", currency: "USD" }, lineItemFulfillmentStatus: "FULFILLED" }] },
      { lineItems: [{ lineItemId: "L1", sku: "GCV000047", quantity: "1", total: { value: "99.00", currency: "USD" }, lineItemFulfillmentStatus: "FULFILLED" }] },
      { lineItems: [{ lineItemId: "L1", sku: "GCV000047", quantity: "1", total: { value: "10.00", currency: "USD" }, lineItemFulfillmentStatus: "NOT_STARTED" }] },
      { lineItems: [{ lineItemId: "L1", sku: "GCV000047", quantity: "1", total: { value: "10.00", currency: "USD" }, lineItemFulfillmentStatus: "FULFILLED", unknownLineField: "x" }] }, // unknown line field
    ]) {
      expect(canonOf({ ...base, ...over })).not.toBe(b);
    }
  });
  it("orders: line ORDER is normalized (same lines, different array order → identical canonical)", () => {
    const two = { ...base, lineItems: [{ lineItemId: "L1", sku: "a" }, { lineItemId: "L2", sku: "b" }] };
    const swapped = { ...base, lineItems: [{ lineItemId: "L2", sku: "b" }, { lineItemId: "L1", sku: "a" }] };
    expect(canonOf(two)).toBe(canonOf(swapped));
  });
  it("finance: a change to any material field (amount, feeBasis, bookingEntry, orderId, payout) differs", () => {
    const t = { transactionId: "T1", orderId: "O1", transactionType: "SALE", transactionStatus: "FUNDS_AVAILABLE", transactionDate: "2026-07-01T00:00:00Z", amount: { value: "10.00", currency: "USD" }, totalFeeBasisAmount: { value: "9.00" }, bookingEntry: "CREDIT", payoutId: "P1" };
    const c = (o: unknown) => { const v = validateTransaction(o); return v.ok ? v.canonical : "INVALID"; };
    const b = c(t);
    for (const over of [{ amount: { value: "11.00", currency: "USD" } }, { totalFeeBasisAmount: { value: "1.00" } }, { bookingEntry: "DEBIT" }, { orderId: "O2" }, { payoutId: "P2" }]) {
      expect(c({ ...t, ...over })).not.toBe(b);
    }
  });
});

describe("finding #4 — an old order modified recently sets the watermark to its lastModifiedDate", () => {
  it("watermark uses lastModifiedDate; the lastmodifieddate filter is aligned", () => {
    const oldModifiedRecently = { orderId: "A", creationDate: "2026-06-20T00:00:00Z", lastModifiedDate: "2026-07-21T00:00:00Z", lineItems: [{ lineItemId: "L1", sku: "GCV000047" }] };
    const v = validateOrder(oldModifiedRecently);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.canonical).toContain("2026-07-21T00:00:00Z"); // lastModifiedDate is IN the canonical
  });
});

describe("fetchAllEbayFinanceTransactions — apiz host, paginated", () => {
  const url = (offset?: number) => `${APIZ}${FINANCE_PATH}?limit=200${offset ? `&offset=${offset}` : ""}`;
  it("collects across pages", async () => {
    const m = mock({
      [url()]: { status: 200, body: { transactions: [txn("T1")], total: 2, size: 1, offset: 0, next: url(200) } },
      [url(200)]: { status: 200, body: { transactions: [txn("T2")], total: 2, size: 1, offset: 200 } },
    });
    const r = await fetchAllEbayFinanceTransactions({ fetchImpl: m.impl, apiOrigin: APIZ, accessToken: "AT", timeoutMs: 20 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items.map((t) => t.transactionId)).toEqual(["T1", "T2"]);
  });
  it("malformed transaction → malformed_provider_response", async () => {
    const m = mock({ [url()]: { status: 200, body: { transactions: [{ transactionId: "" }], total: 1 } } });
    const r = await fetchAllEbayFinanceTransactions({ fetchImpl: m.impl, apiOrigin: APIZ, accessToken: "AT", timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, errorCode: "malformed_provider_response" });
  });
});
