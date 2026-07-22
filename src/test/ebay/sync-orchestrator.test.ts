import { describe, it, expect, vi } from "vitest";
import { advanceWatermark, incrementalStart, runSync, type SyncOps } from "../../../supabase/functions/_shared/ebay-sync-orchestrator";
import type { PaginatedResult } from "../../../supabase/functions/_shared/ebay-pagination-core";

type Item = { id: string; ts: string };
const okPage = (items: Item[], dedup = 0): PaginatedResult<Item> => ({ ok: true, items, pagesFetched: 1, providerTotal: items.length, deduplicatedCount: dedup });
const failPage = (errorCode: string): PaginatedResult<Item> => ({ ok: false, errorCode, httpStatus: 502, pagesFetched: 1 });

interface Cfg {
  acquired?: boolean; leaseError?: boolean; beginOk?: boolean; prior?: string | null;
  page?: PaginatedResult<Item>; assert?: boolean; persistOk?: boolean; complete?: { ok: boolean; errorCode?: string };
  failOk?: boolean; apiRunOk?: boolean; released?: boolean;
}
function mk(cfg: Cfg = {}) {
  const spies = {
    acquireLease: vi.fn(async () => ({ acquired: cfg.acquired ?? true, error: cfg.leaseError ?? false })),
    assertLease: vi.fn(async () => cfg.assert ?? true),
    releaseLease: vi.fn(async () => ({ released: cfg.released ?? true })),
    beginRun: vi.fn(async () => (cfg.beginOk === false ? { ok: false as const } : { ok: true as const, state: { highWatermarkAt: cfg.prior ?? null }, runId: "RUN-1" })),
    fetchAllPages: vi.fn(async () => cfg.page ?? okPage([{ id: "A", ts: "2026-07-20T00:00:00Z" }])),
    persist: vi.fn(async () => (cfg.persistOk === false ? { ok: false as const, errorCode: "orders_persist_failed" } : { ok: true as const, durableTotal: 3, durableSecondary: 5, persisted: 1 })),
    complete: vi.fn(async (_a: { highWatermarkAt: string | null }) => cfg.complete ?? { ok: true }),
    recordFailure: vi.fn(async () => ({ ok: cfg.failOk ?? true })),
    recordApiRun: vi.fn(async () => ({ ok: cfg.apiRunOk ?? true })),
    extractWatermark: vi.fn((items: Item[]) => items.reduce<string | null>((m, i) => (!m || i.ts > m ? i.ts : m), null)),
    buildQuery: vi.fn((from: string | null) => ({ limit: "200", ...(from ? { filter: `from:${from}` } : {}) })),
    now: () => Date.parse("2026-07-22T00:00:00Z"),
    uuid: () => "RUN-1",
    overlapMs: 72 * 3600 * 1000,
  };
  return { ops: spies as unknown as SyncOps<Item> & typeof spies, spies };
}

describe("incrementalStart / advanceWatermark", () => {
  it("first sync → null; otherwise prior − overlap; malformed → null", () => {
    expect(incrementalStart(null, 1000, Date.now())).toBeNull();
    expect(incrementalStart("2026-07-10T00:00:00Z", 72 * 3600 * 1000, Date.parse("2026-07-22T00:00:00Z"))).toBe("2026-07-07T00:00:00.000Z");
    expect(incrementalStart("garbage", 1000, Date.now())).toBeNull();
  });
  it("watermark never regresses / never on malformed", () => {
    expect(advanceWatermark("2026-07-10T00:00:00Z", "2026-07-15T00:00:00Z")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark("2026-07-15T00:00:00Z", "2026-07-10T00:00:00Z")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark("2026-07-15T00:00:00Z", "garbage")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark(null, "2026-07-10T00:00:00Z")).toBe("2026-07-10T00:00:00Z");
  });
});

describe("runSync — fenced lease + atomic completion + checked recovery", () => {
  it("success → begin, assertLease, persist, atomic complete (advanced watermark), released", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", page: okPage([{ id: "A", ts: "2026-07-20T00:00:00Z" }]) });
    const r = await runSync(ops);
    expect(r.status).toBe("success");
    expect(spies.assertLease).toHaveBeenCalled();
    expect(spies.complete).toHaveBeenCalledTimes(1);
    expect(spies.complete.mock.calls[0][0].highWatermarkAt).toBe("2026-07-20T00:00:00Z");
    expect(r.durableTotal).toBe(3);
    expect(r.durableSecondary).toBe(5);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("second concurrent caller → sync_in_progress, no begin/fetch/complete/release", async () => {
    const { ops, spies } = mk({ acquired: false });
    expect((await runSync(ops)).status).toBe("sync_in_progress");
    expect(spies.beginRun).toHaveBeenCalledTimes(0);
    expect(spies.fetchAllPages).toHaveBeenCalledTimes(0);
    expect(spies.complete).toHaveBeenCalledTimes(0);
    expect(spies.releaseLease).toHaveBeenCalledTimes(0);
  });
  it("fetch failure → recordFailure + error api-run, NO complete, watermark unchanged", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", page: failPage("pagination_loop") });
    const r = await runSync(ops);
    expect(r.status).toBe("pagination_loop");
    expect(r.highWatermarkAt).toBe("2026-07-05T00:00:00Z");
    expect(spies.recordFailure).toHaveBeenCalledWith("RUN-1", "pagination_loop");
    expect(spies.recordApiRun).toHaveBeenCalledWith("error", "pagination_loop");
    expect(spies.complete).toHaveBeenCalledTimes(0);
  });
  it("lost lease before persistence → sync_lease_lost, NO persist/complete", async () => {
    const { ops, spies } = mk({ assert: false });
    const r = await runSync(ops);
    expect(r.status).toBe("sync_lease_lost");
    expect(spies.persist).toHaveBeenCalledTimes(0);
    expect(spies.complete).toHaveBeenCalledTimes(0);
  });
  it("persist failure → recordFailure, NO complete", async () => {
    const { ops, spies } = mk({ persistOk: false });
    expect((await runSync(ops)).errorCode).toBe("orders_persist_failed");
    expect(spies.complete).toHaveBeenCalledTimes(0);
    expect(spies.recordFailure).toHaveBeenCalledTimes(1);
  });
  it("atomic complete rejects a stale/lease-lost runner → error, watermark unchanged", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", complete: { ok: false, errorCode: "stale_runner" } });
    const r = await runSync(ops);
    expect(r.errorCode).toBe("stale_runner");
    expect(r.highWatermarkAt).toBe("2026-07-05T00:00:00Z");
    expect(spies.recordFailure).toHaveBeenCalledWith("RUN-1", "stale_runner");
  });
  it("a failed recovery write is surfaced (never silently leaves running)", async () => {
    const { ops } = mk({ page: failPage("provider_timeout"), failOk: false });
    const r = await runSync(ops);
    expect(r.status).toBe("provider_timeout");
    expect(r.recoveryUnpersisted).toBe(true);
  });
  it("lease-release failure → safe api-run diagnostic", async () => {
    const { ops, spies } = mk({ released: false });
    await runSync(ops);
    expect(spies.recordApiRun).toHaveBeenCalledWith("error", "sync_lease_release_unconfirmed");
  });
});
