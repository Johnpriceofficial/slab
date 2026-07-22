import { describe, it, expect, vi } from "vitest";
import { runFinanceSync, runOrderSync, type SyncHandlerDeps } from "../../../supabase/functions/_shared/ebay-sync-handler";
import type { CompleteArgs } from "../../../supabase/functions/_shared/ebay-sync-orchestrator";
import type { PageFetchImpl, PaginatedResult } from "../../../supabase/functions/_shared/ebay-pagination-core";
import { fetchAllEbayOrders, type RawOrder } from "../../../supabase/functions/_shared/ebay-orders-pagination";
import type { RawTransaction } from "../../../supabase/functions/_shared/ebay-finances-pagination";

const order = (id: string, sku = "GCV000047", ts = "2026-07-20T00:00:00Z") => ({ orderId: id, lastModifiedDate: ts, lineItems: [{ lineItemId: `${id}-L`, sku, quantity: "1" }] });
const txn = (id: string, ts = "2026-07-20T00:00:00Z") => ({ transactionId: id, transactionDate: ts, amount: { value: "10.00", currency: "USD" } });
const okOrders = (orders: RawOrder[]): PaginatedResult<RawOrder> => ({ ok: true, items: orders, pagesFetched: 1, providerTotal: orders.length, deduplicatedCount: 0 });
const okTxns = (txns: RawTransaction[]): PaginatedResult<RawTransaction> => ({ ok: true, items: txns, pagesFetched: 1, providerTotal: txns.length, deduplicatedCount: 0 });

interface Cfg {
  acquired?: boolean; prior?: string | null; orderPage?: PaginatedResult<RawOrder>; txnPage?: PaginatedResult<RawTransaction>;
  mapOk?: boolean; persistOrdersOkAfter?: number; persistOrdersOk?: boolean; persistFinancesOk?: boolean; completeOk?: boolean; assert?: boolean;
  beginOk?: boolean; beginErrorCode?: string;
}
type Guard = () => Promise<boolean>;
function mk(cfg: Cfg = {}) {
  let orderPersistCalls = 0;
  const spies = {
    fetchOrders: vi.fn(async (_at: string, _q: Record<string, string>, _g: Guard) => cfg.orderPage ?? okOrders([order("A")])),
    fetchFinances: vi.fn(async (_at: string, _q: Record<string, string>, _g: Guard) => cfg.txnPage ?? okTxns([txn("T1")])),
    resolveOrderMappings: vi.fn(async (_acc: string, _skus: string[]) => (cfg.mapOk === false ? { ok: false as const } : { ok: true as const, bySku: new Map<string, string>() })),
    persistOrders: vi.fn(async (_acc: string, _shaped: unknown[]) => {
      orderPersistCalls += 1;
      if (cfg.persistOrdersOk === false) return { ok: false as const };
      if (cfg.persistOrdersOkAfter !== undefined && orderPersistCalls > cfg.persistOrdersOkAfter) return { ok: false as const };
      return { ok: true as const, durableTotal: 42, durableLines: 99, persisted: 1 };
    }),
    persistFinances: vi.fn(async (_acc: string, _shaped: unknown[]) => (cfg.persistFinancesOk === false ? { ok: false as const } : { ok: true as const, durableTotal: 7, persisted: 1 })),
    leaseAcquire: vi.fn(async (_acc: string, _res: string, _tok: string) => ({ acquired: cfg.acquired ?? true, error: false })),
    leaseAssert: vi.fn(async (_acc: string, _res: string, _tok: string) => cfg.assert ?? true),
    leaseRelease: vi.fn(async (_acc: string, _res: string, _tok: string) => ({ released: true })),
    syncBegin: vi.fn(async (_acc: string, _res: string, _tok: string) => (cfg.beginOk === false ? { ok: false as const, errorCode: cfg.beginErrorCode } : { ok: true as const, runId: "RUN", highWatermarkAt: cfg.prior ?? null })),
    syncComplete: vi.fn(async (_acc: string, _res: string, _tok: string, _a: CompleteArgs) => ({ ok: cfg.completeOk ?? true })),
    syncFail: vi.fn(async (_acc: string, _res: string, _run: string, _code: string) => ({ ok: true })),
    recordApiRun: vi.fn(async (_acc: string, _op: string, _status: string, _code: string | null) => ({ ok: true })),
    now: () => Date.parse("2026-07-22T00:00:00Z"),
    uuid: () => "RUN",
    overlapMs: 72 * 3600 * 1000,
  };
  return { spies };
}
const deps = (s: ReturnType<typeof mk>["spies"], collect?: (x: unknown[]) => void): SyncHandlerDeps => ({ ...s, collectProposedSales: collect } as unknown as SyncHandlerDeps);

describe("runOrderSync — fenced, batched order sync", () => {
  it("success → resolves mappings, persists, atomic complete (advanced watermark), confirmed totals surfaced", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", orderPage: okOrders([order("A", "GCV000047", "2026-07-21T00:00:00Z")]) });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.status).toBe("success");
    expect(r.durableTotal).toBe(42);          // confirmed_order_total (NOT the processed batch count)
    expect(r.durableSecondary).toBe(99);      // confirmed_line_total
    expect(spies.syncComplete.mock.calls[0][3].highWatermarkAt).toBe("2026-07-21T00:00:00Z");
    expect(spies.leaseAssert).toHaveBeenCalled(); // fencing
  });
  it("finding #2: begin-run is fenced with the SAME lease token that was acquired", async () => {
    const { spies } = mk({});
    await runOrderSync("ACC", "AT", deps(spies));
    const acquiredToken = spies.leaseAcquire.mock.calls[0][2];
    expect(spies.syncBegin.mock.calls[0]).toEqual(["ACC", "orders", acquiredToken]);
  });
  it("finding #2: a fenced-begin rejection (lease_lost) → 409, ZERO reads/persist/complete", async () => {
    const { spies } = mk({ beginOk: false, beginErrorCode: "lease_lost" });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.errorCode).toBe("lease_lost");
    expect(r.httpStatus).toBe(409);
    expect(spies.fetchOrders).toHaveBeenCalledTimes(0);
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
  });
  it("finding #1: the page guard passed to the fetcher IS the live lease assertion", async () => {
    const { spies } = mk({});
    await runOrderSync("ACC", "AT", deps(spies));
    const guard = spies.fetchOrders.mock.calls[0][2];
    expect(typeof guard).toBe("function");
    const before = spies.leaseAssert.mock.calls.length;
    await guard();                              // invoking the guard exercises the live lease assertion
    expect(spies.leaseAssert.mock.calls.length).toBe(before + 1);
    expect(spies.leaseAssert.mock.calls[before]).toEqual(["ACC", "orders", spies.leaseAcquire.mock.calls[0][2]]);
  });
  it("finding #7: the order query filter is lastmodifieddate (aligned with the watermark)", async () => {
    const { spies } = mk({ prior: "2026-07-10T00:00:00Z" });
    await runOrderSync("ACC", "AT", deps(spies));
    expect(String(spies.fetchOrders.mock.calls[0][1].filter)).toContain("lastmodifieddate:[2026-07-07T00:00:00.000Z");
  });
  it("finding #3: an EMPTY order result still fences + persists + completes (durable total surfaced)", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", orderPage: okOrders([]) });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.status).toBe("success");
    expect(spies.persistOrders).toHaveBeenCalledTimes(1);         // empty batch still persisted/read-back
    expect(spies.persistOrders.mock.calls[0][1]).toEqual([]);
    expect(r.durableTotal).toBe(42);
    expect(spies.syncComplete).toHaveBeenCalledTimes(1);
  });
  it("finding #3: an EMPTY order result whose readback FAILS → fail closed, NO complete", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", orderPage: okOrders([]), persistOrdersOk: false });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.errorCode).toBe("orders_persist_failed");
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
    expect(r.highWatermarkAt).toBe("2026-07-01T00:00:00Z");
  });
  it("second concurrent caller → sync_in_progress, ZERO reads/persist/complete", async () => {
    const { spies } = mk({ acquired: false });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.status).toBe("sync_in_progress");
    expect(spies.fetchOrders).toHaveBeenCalledTimes(0);
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
  });
  it("finding #7: >200 SKUs are resolved in multiple lease-fenced batches", async () => {
    const orders = Array.from({ length: 250 }, (_, i) => order(`O${i}`, `GCV${String(i).padStart(6, "0")}`));
    const { spies } = mk({ orderPage: okOrders(orders) });
    await runOrderSync("ACC", "AT", deps(spies));
    expect(spies.resolveOrderMappings.mock.calls.length).toBeGreaterThanOrEqual(2); // 250 skus → ≥2 batches
    expect(spies.leaseAssert.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("finding #7: >100 orders are persisted in multiple lease-fenced batches", async () => {
    const orders = Array.from({ length: 150 }, (_, i) => order(`O${i}`, `GCV${String(i).padStart(6, "0")}`));
    const { spies } = mk({ orderPage: okOrders(orders) });
    await runOrderSync("ACC", "AT", deps(spies));
    expect(spies.persistOrders.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("a batch-N persist failure → fail closed, NO complete (watermark preserved)", async () => {
    const orders = Array.from({ length: 150 }, (_, i) => order(`O${i}`, `GCV${String(i).padStart(6, "0")}`));
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", orderPage: okOrders(orders), persistOrdersOkAfter: 1 });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.errorCode).toBe("orders_persist_failed");
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
    expect(r.highWatermarkAt).toBe("2026-07-01T00:00:00Z");
  });
  it("a lost lease before a batch → sync_lease_lost, no complete", async () => {
    const { spies } = mk({ assert: false });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.status).toBe("sync_lease_lost");
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
  });
  it("mapping-lookup failure → fail closed, no persist", async () => {
    const { spies } = mk({ mapOk: false });
    const r = await runOrderSync("ACC", "AT", deps(spies));
    expect(r.errorCode).toBe("mapping_lookup_failed");
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
  });
  it("a malformed order page (e.g. duplicate lineItemId) → NO mapping/persist/proposed-sales", async () => {
    const malformed: PaginatedResult<RawOrder> = { ok: false, errorCode: "malformed_provider_response", httpStatus: 502, pagesFetched: 1 };
    let proposed: unknown[] | undefined;
    const { spies } = mk({ orderPage: malformed });
    const r = await runOrderSync("ACC", "AT", deps(spies, (s) => { proposed = s; }));
    expect(r.errorCode).toBe("malformed_provider_response");
    expect(spies.resolveOrderMappings).toHaveBeenCalledTimes(0);
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
    expect(proposed).toBeUndefined(); // collectProposedSales never invoked
  });
  it("END-TO-END: an EMPTY-line order through the REAL paginator never reaches mapping/shaping/persist/proposed/complete", async () => {
    // Wire the handler's fetchOrders to the REAL fetchAllEbayOrders over a mocked HTTP
    // page that returns a zero-line order — proving the whole pipeline fails closed.
    const ORIGIN = "https://api.ebay.com";
    const page = { orders: [{ orderId: "ORDER-1", lineItems: [] as unknown[] }], total: 1, size: 1, offset: 0 };
    const fetchImpl: PageFetchImpl = () => Promise.resolve({ ok: true, status: 200, json: async () => page });
    const realFetchOrders = (accessToken: string, query: Record<string, string>, guard: () => Promise<boolean>) =>
      fetchAllEbayOrders({ fetchImpl, apiOrigin: ORIGIN, accessToken, query, beforePageFetch: guard, timeoutMs: 50 });
    let proposed: unknown[] | undefined;
    const { spies } = mk({});
    const d = { ...spies, fetchOrders: realFetchOrders, collectProposedSales: (s: unknown[]) => { proposed = s; } } as unknown as SyncHandlerDeps;
    const r = await runOrderSync("ACC", "AT", d);
    expect(r.errorCode).toBe("malformed_provider_response");   // real validator rejected the empty-line order
    expect(spies.resolveOrderMappings).toHaveBeenCalledTimes(0); // never reached mapping lookup
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);        // never reached persistence
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);         // watermark never advanced
    expect(proposed).toBeUndefined();                            // no proposed sales
  });
});

describe("runFinanceSync — fenced, batched finance sync", () => {
  it("success → persists, atomic complete, transactionDate filter (no money-movement op)", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", txnPage: okTxns([txn("T1", "2026-07-21T00:00:00Z")]) });
    const r = await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(r.status).toBe("success");
    expect(spies.persistFinances).toHaveBeenCalled();
    expect(spies.syncComplete.mock.calls[0][3].highWatermarkAt).toBe("2026-07-21T00:00:00Z");
    expect(String(spies.fetchFinances.mock.calls[0][1].filter)).toContain("transactionDate");
  });
  it("finding #1: the finance page guard IS the live lease assertion", async () => {
    const { spies } = mk({});
    await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    const guard = spies.fetchFinances.mock.calls[0][2];
    expect(typeof guard).toBe("function");
    const before = spies.leaseAssert.mock.calls.length;
    await guard();
    expect(spies.leaseAssert.mock.calls.length).toBe(before + 1);
  });
  it("finding #3: an EMPTY finance result still fences + persists + completes", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", txnPage: okTxns([]) });
    const r = await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(r.status).toBe("success");
    expect(spies.persistFinances).toHaveBeenCalledTimes(1);
    expect(spies.persistFinances.mock.calls[0][1]).toEqual([]);
    expect(spies.syncComplete).toHaveBeenCalledTimes(1);
  });
  it("finding #3: an EMPTY finance result whose readback FAILS → fail closed, NO complete", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", txnPage: okTxns([]), persistFinancesOk: false });
    const r = await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(r.errorCode).toBe("finances_persist_failed");
    expect(spies.syncComplete).toHaveBeenCalledTimes(0);
  });
  it(">100 transactions persisted in multiple lease-fenced batches", async () => {
    const txns = Array.from({ length: 150 }, (_, i) => txn(`T${i}`));
    const { spies } = mk({ txnPage: okTxns(txns) });
    await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(spies.persistFinances.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
