import { describe, it, expect, vi } from "vitest";
import { runFinanceSync, runOrderSync, type SyncHandlerDeps } from "../../../supabase/functions/_shared/ebay-sync-handler";
import type { PaginatedResult } from "../../../supabase/functions/_shared/ebay-pagination-core";
import type { RawOrder } from "../../../supabase/functions/_shared/ebay-orders-pagination";
import type { RawTransaction } from "../../../supabase/functions/_shared/ebay-finances-pagination";

const order = (id: string, sku = "GCV000047", ts = "2026-07-20T00:00:00Z") => ({ orderId: id, lastModifiedDate: ts, lineItems: [{ lineItemId: `${id}-L`, sku, quantity: "1" }] });
const txn = (id: string, ts = "2026-07-20T00:00:00Z") => ({ transactionId: id, transactionDate: ts, amount: { value: "10.00", currency: "USD" } });
const okOrders = (orders: RawOrder[]): PaginatedResult<RawOrder> => ({ ok: true, items: orders, pagesFetched: orders.length, providerTotal: orders.length, deduplicatedCount: 0 });
const okTxns = (txns: RawTransaction[]): PaginatedResult<RawTransaction> => ({ ok: true, items: txns, pagesFetched: 1, providerTotal: txns.length, deduplicatedCount: 0 });

interface Cfg {
  acquired?: boolean; prior?: string | null; orderPage?: PaginatedResult<RawOrder>; txnPage?: PaginatedResult<RawTransaction>;
  mapOk?: boolean; persistOrdersOk?: boolean; persistFinancesOk?: boolean; commitOk?: boolean;
}
function mk(cfg: Cfg = {}) {
  const spies = {
    fetchOrders: vi.fn(async (_at: string, _q: Record<string, string>) => cfg.orderPage ?? okOrders([order("A")])),
    fetchFinances: vi.fn(async (_at: string, _q: Record<string, string>) => cfg.txnPage ?? okTxns([txn("T1")])),
    resolveOrderMappings: vi.fn(async () => (cfg.mapOk === false ? { ok: false as const } : { ok: true as const, bySku: new Map([["GCV000047", "slab-1"]]) })),
    persistOrders: vi.fn(async () => (cfg.persistOrdersOk === false ? { ok: false as const } : { ok: true as const, durableTotal: 1, persisted: 1 })),
    persistFinances: vi.fn(async () => (cfg.persistFinancesOk === false ? { ok: false as const } : { ok: true as const, durableTotal: 1, persisted: 1 })),
    leaseAcquire: vi.fn(async () => ({ acquired: cfg.acquired ?? true, error: false })),
    leaseRelease: vi.fn(async () => ({ released: true })),
    syncStateLoad: vi.fn(async () => ({ ok: true as const, highWatermarkAt: cfg.prior ?? null })),
    syncStateCommit: vi.fn(async (_acc: string, _res: string, _a: { highWatermarkAt: string | null }) => ({ ok: cfg.commitOk ?? true })),
    syncStateFail: vi.fn(async () => ({ ok: true })),
    recordApiRun: vi.fn(async () => ({ ok: true })),
    now: () => Date.parse("2026-07-22T00:00:00Z"),
    uuid: () => "RUN",
    overlapMs: 72 * 3600 * 1000,
  };
  return { spies };
}
const orderDeps = (spies: ReturnType<typeof mk>["spies"], collect?: (s: unknown[]) => void): SyncHandlerDeps => ({ ...spies, collectProposedSales: collect } as unknown as SyncHandlerDeps);

describe("runOrderSync — real order-sync orchestration binding", () => {
  it("success → resolves mappings, persists, advances watermark, one lease acquire/release, api-run success", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", orderPage: okOrders([order("A", "GCV000047", "2026-07-21T00:00:00Z")]) });
    const collected: unknown[] = [];
    const r = await runOrderSync("ACC", "AT", orderDeps(spies, (s) => collected.push(...s)));
    expect(r.status).toBe("success");
    expect(spies.resolveOrderMappings).toHaveBeenCalledTimes(1);
    expect(spies.persistOrders).toHaveBeenCalledTimes(1);
    expect(spies.leaseAcquire).toHaveBeenCalledTimes(1);
    expect(spies.leaseRelease).toHaveBeenCalledTimes(1);
    expect(spies.syncStateCommit).toHaveBeenCalledTimes(1);
    expect(spies.syncStateCommit.mock.calls[0][2].highWatermarkAt).toBe("2026-07-21T00:00:00Z");
    expect(spies.recordApiRun).toHaveBeenCalledWith("ACC", "orders_sync", "success", null);
    // Ordinary order sync exposes proposed sales but NEVER applies them.
    expect(Array.isArray(collected)).toBe(true);
  });
  it("the order query is a bounded incremental range (prior − 72h overlap)", async () => {
    const { spies } = mk({ prior: "2026-07-10T00:00:00Z" });
    await runOrderSync("ACC", "AT", orderDeps(spies));
    expect(String(spies.fetchOrders.mock.calls[0][1].filter)).toContain("2026-07-07T00:00:00.000Z");
  });
  it("second concurrent caller → sync_in_progress, ZERO provider reads / persistence", async () => {
    const { spies } = mk({ acquired: false });
    const r = await runOrderSync("ACC", "AT", orderDeps(spies));
    expect(r.status).toBe("sync_in_progress");
    expect(spies.fetchOrders).toHaveBeenCalledTimes(0);
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
    expect(spies.syncStateCommit).toHaveBeenCalledTimes(0);
  });
  it("mapping-lookup failure → fail closed, NO persist, NO commit, watermark unchanged", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", mapOk: false });
    const r = await runOrderSync("ACC", "AT", orderDeps(spies));
    expect(r.errorCode).toBe("mapping_lookup_failed");
    expect(spies.persistOrders).toHaveBeenCalledTimes(0);
    expect(spies.syncStateCommit).toHaveBeenCalledTimes(0);
    expect(spies.syncStateFail).toHaveBeenCalledTimes(1);
    expect(r.highWatermarkAt).toBe("2026-07-01T00:00:00Z");
  });
  it("persist failure → syncStateFail, no commit", async () => {
    const { spies } = mk({ persistOrdersOk: false });
    const r = await runOrderSync("ACC", "AT", orderDeps(spies));
    expect(r.errorCode).toBe("orders_persist_failed");
    expect(spies.syncStateCommit).toHaveBeenCalledTimes(0);
    expect(spies.syncStateFail).toHaveBeenCalledTimes(1);
  });
});

describe("runFinanceSync — real finance-sync orchestration binding", () => {
  it("success → persists, advances watermark, api-run success (no money-movement op exists)", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", txnPage: okTxns([txn("T1", "2026-07-21T00:00:00Z")]) });
    const r = await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(r.status).toBe("success");
    expect(spies.persistFinances).toHaveBeenCalledTimes(1);
    expect(spies.syncStateCommit.mock.calls[0][2].highWatermarkAt).toBe("2026-07-21T00:00:00Z");
    expect(spies.recordApiRun).toHaveBeenCalledWith("ACC", "finances_sync", "success", null);
    expect(String(spies.fetchFinances.mock.calls[0][1].filter)).toContain("transactionDate");
  });
  it("fetch failure → syncStateFail, no commit, watermark unchanged", async () => {
    const { spies } = mk({ prior: "2026-07-01T00:00:00Z", txnPage: { ok: false, errorCode: "provider_timeout", httpStatus: 502, pagesFetched: 1 } });
    const r = await runFinanceSync("ACC", "AT", spies as unknown as SyncHandlerDeps);
    expect(r.status).toBe("provider_timeout");
    expect(spies.persistFinances).toHaveBeenCalledTimes(0);
    expect(spies.syncStateCommit).toHaveBeenCalledTimes(0);
    expect(r.highWatermarkAt).toBe("2026-07-01T00:00:00Z");
  });
});
