import { describe, it, expect, vi } from "vitest";
import { advanceWatermark, incrementalStart, runSync, type SyncOps } from "../../../supabase/functions/_shared/ebay-sync-orchestrator";
import type { PaginatedResult } from "../../../supabase/functions/_shared/ebay-pagination-core";

type Item = { id: string; ts: string };
const okPage = (items: Item[], dedup = 0): PaginatedResult<Item> => ({ ok: true, items, pagesFetched: 1, providerTotal: items.length, deduplicatedCount: dedup });
const failPage = (errorCode: string): PaginatedResult<Item> => ({ ok: false, errorCode, httpStatus: 502, pagesFetched: 1 });

interface Cfg {
  acquired?: boolean; leaseError?: boolean; loadOk?: boolean; prior?: string | null;
  page?: PaginatedResult<Item>; persistOk?: boolean; commitOk?: boolean; apiRunOk?: boolean; released?: boolean;
}
function mk(cfg: Cfg = {}) {
  const spies = {
    acquireLease: vi.fn(async () => ({ acquired: cfg.acquired ?? true, error: cfg.leaseError ?? false })),
    releaseLease: vi.fn(async () => ({ released: cfg.released ?? true })),
    loadSyncState: vi.fn(async () => (cfg.loadOk === false ? { ok: false as const } : { ok: true as const, state: { highWatermarkAt: cfg.prior ?? null } })),
    fetchAllPages: vi.fn(async () => cfg.page ?? okPage([{ id: "A", ts: "2026-07-10T00:00:00Z" }])),
    persist: vi.fn(async () => (cfg.persistOk === false ? { ok: false as const, errorCode: "orders_persist_failed" } : { ok: true as const, durableTotal: 1, persisted: 1 })),
    commitSyncState: vi.fn(async (_a: { highWatermarkAt: string | null }) => ({ ok: cfg.commitOk ?? true })),
    recordFailure: vi.fn(async () => ({ ok: true })),
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
  it("first sync → null start; otherwise prior − overlap", () => {
    expect(incrementalStart(null, 1000, Date.now())).toBeNull();
    expect(incrementalStart("2026-07-10T00:00:00Z", 72 * 3600 * 1000, Date.parse("2026-07-22T00:00:00Z"))).toBe("2026-07-07T00:00:00.000Z");
    expect(incrementalStart("not-a-date", 1000, Date.now())).toBeNull();
  });
  it("watermark never goes backwards / never on malformed", () => {
    expect(advanceWatermark("2026-07-10T00:00:00Z", "2026-07-15T00:00:00Z")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark("2026-07-15T00:00:00Z", "2026-07-10T00:00:00Z")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark("2026-07-15T00:00:00Z", null)).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark("2026-07-15T00:00:00Z", "garbage")).toBe("2026-07-15T00:00:00Z");
    expect(advanceWatermark(null, "2026-07-10T00:00:00Z")).toBe("2026-07-10T00:00:00Z");
  });
});

describe("runSync — atomic completion + deterministic recovery", () => {
  it("success → fetch, persist, commit (advanced watermark), api-run success, released once", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", page: okPage([{ id: "A", ts: "2026-07-20T00:00:00Z" }]) });
    const r = await runSync(ops);
    expect(r.status).toBe("success");
    expect(spies.commitSyncState).toHaveBeenCalledTimes(1);
    expect(spies.commitSyncState.mock.calls[0][0].highWatermarkAt).toBe("2026-07-20T00:00:00Z");
    expect(spies.recordApiRun).toHaveBeenCalledWith("success", null);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
    // Incremental query starts from prior − overlap.
    expect(spies.buildQuery.mock.calls[0][0]).toBe("2026-07-02T00:00:00.000Z");
  });
  it("a second concurrent caller → sync_in_progress, ZERO reads/writes", async () => {
    const { ops, spies } = mk({ acquired: false });
    const r = await runSync(ops);
    expect(r.status).toBe("sync_in_progress");
    expect(spies.fetchAllPages).toHaveBeenCalledTimes(0);
    expect(spies.persist).toHaveBeenCalledTimes(0);
    expect(spies.commitSyncState).toHaveBeenCalledTimes(0);
    expect(spies.releaseLease).toHaveBeenCalledTimes(0); // never acquired → nothing to release
  });
  it("fetch failure → recordFailure, NO commit, watermark UNCHANGED", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", page: failPage("pagination_loop") });
    const r = await runSync(ops);
    expect(r.status).toBe("pagination_loop");
    expect(r.highWatermarkAt).toBe("2026-07-05T00:00:00Z");
    expect(spies.recordFailure).toHaveBeenCalledWith("RUN-1", "pagination_loop");
    expect(spies.persist).toHaveBeenCalledTimes(0);
    expect(spies.commitSyncState).toHaveBeenCalledTimes(0);
  });
  it("persist failure → recordFailure, NO commit, watermark UNCHANGED", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", persistOk: false });
    const r = await runSync(ops);
    expect(r.errorCode).toBe("orders_persist_failed");
    expect(r.highWatermarkAt).toBe("2026-07-05T00:00:00Z");
    expect(spies.commitSyncState).toHaveBeenCalledTimes(0);
    expect(spies.recordFailure).toHaveBeenCalledTimes(1);
  });
  it("commit failure → error, api-run diagnostic, watermark reported unchanged", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", commitOk: false });
    const r = await runSync(ops);
    expect(r.errorCode).toBe("sync_state_commit_failed");
    expect(spies.recordApiRun).toHaveBeenCalledWith("error", "sync_state_commit_failed");
    expect(r.highWatermarkAt).toBe("2026-07-05T00:00:00Z");
  });
  it("lease-release failure → safe api-run diagnostic", async () => {
    const { ops, spies } = mk({ released: false });
    await runSync(ops);
    expect(spies.recordApiRun).toHaveBeenCalledWith("error", "sync_lease_release_unconfirmed");
  });
  it("empty incremental run keeps the prior watermark", async () => {
    const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", page: okPage([]) });
    await runSync(ops);
    expect(spies.commitSyncState.mock.calls[0][0].highWatermarkAt).toBe("2026-07-05T00:00:00Z");
  });
});
