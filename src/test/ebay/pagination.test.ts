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

describe("validateOrder / validateTransaction — strict item contracts", () => {
  it("order requires a non-empty orderId + valid line items", () => {
    expect(validateOrder(order("1")).ok).toBe(true);
    expect(validateOrder({ orderId: "" }).ok).toBe(false);
    expect(validateOrder({ lineItems: [] }).ok).toBe(false);
    expect(validateOrder({ orderId: "1", lineItems: [{ sku: "x" }] }).ok).toBe(false); // line missing lineItemId
    expect(validateOrder({ orderId: "1", lineItems: "nope" }).ok).toBe(false);
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
