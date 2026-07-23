import { describe, it, expect, vi } from "vitest";
import { advanceWatermark, incrementalStart, runSync, type CompleteArgs, type SyncOps } from "../../../supabase/functions/_shared/ebay-sync-orchestrator";
import type { PaginatedResult } from "../../../supabase/functions/_shared/ebay-pagination-core";

type Item = { id: string; ts: string };
const okPage = (items: Item[], dedup = 0): PaginatedResult<Item> => ({ ok: true, items, pagesFetched: 1, providerTotal: items.length, deduplicatedCount: dedup });
const failPage = (errorCode: string): PaginatedResult<Item> => ({ ok: false, errorCode, httpStatus: 502, pagesFetched: 1 });

interface Cfg {
  acquired?: boolean; leaseError?: boolean; beginOk?: boolean; beginErrorCode?: string; prior?: string | null;
  page?: PaginatedResult<Item>; assert?: boolean; persistOk?: boolean; complete?: { ok: boolean; errorCode?: string };
  failOk?: boolean; apiRunOk?: boolean; released?: boolean; clock?: () => number; initial?: string;
  throwOn?: string[]; // dependency names that should REJECT (throw) instead of returning
}
function mk(cfg: Cfg = {}) {
  const clock = cfg.clock ?? (() => Date.parse("2026-07-22T00:00:00Z"));
  const initial = cfg.initial ?? "2026-04-23T00:00:00.000Z"; // bounded 90-day initial fallback
  const boom = (name: string) => { if (cfg.throwOn?.includes(name)) throw new Error(`boom:${name}`); };
  const spies = {
    acquireLease: vi.fn(async () => { boom("acquireLease"); return { acquired: cfg.acquired ?? true, error: cfg.leaseError ?? false }; }),
    assertLease: vi.fn(async () => { boom("assertLease"); return cfg.assert ?? true; }),
    releaseLease: vi.fn(async () => { boom("releaseLease"); return { released: cfg.released ?? true }; }),
    beginRun: vi.fn(async () => { boom("beginRun"); return (cfg.beginOk === false ? { ok: false as const, errorCode: cfg.beginErrorCode } : { ok: true as const, state: { highWatermarkAt: cfg.prior ?? null }, runId: "RUN-1" }); }),
    fetchAllPages: vi.fn(async (_q: Record<string, string>) => { boom("fetchAllPages"); return cfg.page ?? okPage([{ id: "A", ts: "2026-07-20T00:00:00Z" }]); }),
    persist: vi.fn(async () => { boom("persist"); return (cfg.persistOk === false ? { ok: false as const, errorCode: "orders_persist_failed" } : { ok: true as const, durableTotal: 3, durableSecondary: 5, persisted: 1 }); }),
    complete: vi.fn(async (_a: CompleteArgs) => { boom("complete"); return cfg.complete ?? { ok: true }; }),
    recordFailure: vi.fn(async (_r: string, _c: string) => { boom("recordFailure"); return { ok: cfg.failOk ?? true }; }),
    recordApiRun: vi.fn(async (_s: string, _c: string | null) => { boom("recordApiRun"); return { ok: cfg.apiRunOk ?? true }; }),
    extractWatermark: vi.fn((items: Item[]) => items.reduce<string | null>((m, i) => (!m || i.ts > m ? i.ts : m), null)),
    // Returns the provider query AND the EXACT effective start it used (finding #6).
    buildQuery: vi.fn((from: string | null) => { const effectiveStartAt = from ?? initial; return { query: { limit: "200", filter: `from:${effectiveStartAt}` }, effectiveStartAt }; }),
    now: clock,
    uuid: () => "RUN-1",
    overlapMs: 72 * 3600 * 1000,
  };
  return { ops: spies as unknown as SyncOps<Item> & typeof spies, spies };
}

describe("incrementalStart / advanceWatermark", () => {
  it("first sync → null; otherwise prior − overlap; malformed → null", () => {
    expect(incrementalStart(null, 1000, Date.parse("2026-07-22T00:00:00Z"))).toBeNull();
    expect(incrementalStart("2026-07-10T00:00:00Z", 72 * 3600 * 1000, Date.parse("2026-07-22T00:00:00Z"))).toBe("2026-07-07T00:00:00.000Z");
    expect(incrementalStart("garbage", 1000, Date.parse("2026-07-22T00:00:00Z"))).toBeNull();
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
    expect(r.releaseUnconfirmed).toBeUndefined();
  });
  it("records the EXACT effective query start in overlap_start_at (incremental = prior − overlap)", async () => {
    const { ops, spies } = mk({ prior: "2026-07-10T00:00:00Z" });
    await runSync(ops);
    // incrementalStart(2026-07-10, 72h) = 2026-07-07; buildQuery echoes it as effectiveStartAt.
    expect(spies.buildQuery.mock.calls[0][0]).toBe("2026-07-07T00:00:00.000Z");
    expect(spies.complete.mock.calls[0][0].overlapStartAt).toBe("2026-07-07T00:00:00.000Z");
  });
  it("first sync (no prior) records the bounded initial start, not null", async () => {
    const { ops, spies } = mk({ prior: null });
    await runSync(ops);
    expect(spies.buildQuery.mock.calls[0][0]).toBeNull();               // from is null on first sync
    expect(spies.complete.mock.calls[0][0].overlapStartAt).toBe("2026-04-23T00:00:00.000Z"); // but the recorded start is the real window
  });
  it("passes a MEASURED latency (now-at-complete − now-at-begin), never a hardcoded 0", async () => {
    let t = Date.parse("2026-07-22T00:00:00Z");
    const { ops, spies } = mk({ clock: () => { const v = t; t += 250; return v; } }); // each now() call advances 250ms
    await runSync(ops);
    expect(spies.complete.mock.calls[0][0].latencyMs).toBeGreaterThan(0);
  });
  it("second concurrent caller → sync_in_progress, no begin/fetch/complete/release", async () => {
    const { ops, spies } = mk({ acquired: false });
    expect((await runSync(ops)).status).toBe("sync_in_progress");
    expect(spies.beginRun).toHaveBeenCalledTimes(0);
    expect(spies.fetchAllPages).toHaveBeenCalledTimes(0);
    expect(spies.complete).toHaveBeenCalledTimes(0);
    expect(spies.releaseLease).toHaveBeenCalledTimes(0);
  });
  it("fenced begin rejects a lease-lost caller → 409, NO fetch/persist/complete", async () => {
    const { ops, spies } = mk({ beginOk: false, beginErrorCode: "lease_lost" });
    const r = await runSync(ops);
    expect(r.errorCode).toBe("lease_lost");
    expect(r.httpStatus).toBe(409);
    expect(spies.fetchAllPages).toHaveBeenCalledTimes(0);
    expect(spies.persist).toHaveBeenCalledTimes(0);
    expect(spies.complete).toHaveBeenCalledTimes(0);
    // the lease was acquired, so release is still attempted for cleanup
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
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
  it("lease-release failure → releaseUnconfirmed surfaced + safe api-run diagnostic", async () => {
    const { ops, spies } = mk({ released: false });
    const r = await runSync(ops);
    expect(r.status).toBe("success");          // the sync itself committed
    expect(r.releaseUnconfirmed).toBe(true);    // but cleanup could not be confirmed
    expect(spies.recordApiRun).toHaveBeenCalledWith("error", "sync_lease_release_unconfirmed");
  });
  it("lease-release failure AND diagnostic failure → releaseUnconfirmed + recoveryUnpersisted", async () => {
    const { ops } = mk({ released: false, apiRunOk: false });
    const r = await runSync(ops);
    expect(r.releaseUnconfirmed).toBe(true);
    expect(r.recoveryUnpersisted).toBe(true);
  });
});

describe("runSync — exception-safe guaranteed release (blocker 2)", () => {
  // Each injected dependency THROWS (rejects) rather than returning a structured error.
  it("acquireLease throws → sync_internal_error, NO begin, NO release (nothing was acquired)", async () => {
    const { ops, spies } = mk({ throwOn: ["acquireLease"] });
    const r = await runSync(ops);
    expect(r).toMatchObject({ status: "sync_internal_error", errorCode: "sync_internal_error", httpStatus: 500 });
    expect(spies.beginRun).toHaveBeenCalledTimes(0);
    expect(spies.releaseLease).toHaveBeenCalledTimes(0);
  });
  it("a non-acquiring second caller → NO release attempted", async () => {
    const { ops, spies } = mk({ acquired: false });
    await runSync(ops);
    expect(spies.releaseLease).toHaveBeenCalledTimes(0);
  });

  // For every case below the lease WAS acquired → release must be attempted exactly once.
  const acquiredThrowCases: Array<[string, string[], string | undefined]> = [
    ["beginRun throws", ["beginRun"], undefined],       // no run_id yet
    ["fetchAllPages throws", ["fetchAllPages"], "RUN-1"],
    ["assertLease throws", ["assertLease"], "RUN-1"],
    ["persist throws", ["persist"], "RUN-1"],
    ["complete throws", ["complete"], "RUN-1"],
  ];
  for (const [name, throwOn, expectRunId] of acquiredThrowCases) {
    it(`${name} → stable sync_internal_error, checked recovery, release attempted exactly once`, async () => {
      const { ops, spies } = mk({ prior: "2026-07-05T00:00:00Z", throwOn });
      const r = await runSync(ops);
      expect(r.status).toBe("sync_internal_error");
      expect(r.errorCode).toBe("sync_internal_error");
      expect(r.httpStatus).toBe(500);
      expect(spies.releaseLease).toHaveBeenCalledTimes(1);       // GUARANTEED release
      // A run that had begun gets a CHECKED failure + error audit; the fail RPC is
      // active-runner-only in SQL, so a possibly-committed complete is not rolled back.
      if (expectRunId) {
        expect(r.runId).toBe(expectRunId);
        expect(spies.recordFailure).toHaveBeenCalledWith(expectRunId, "sync_internal_error");
      }
      expect(spies.recordApiRun).toHaveBeenCalledWith("error", "sync_internal_error");
    });
  }

  it("recordFailure throws during recovery → still sync_internal_error, recoveryUnpersisted, release once", async () => {
    const { ops, spies } = mk({ throwOn: ["fetchAllPages", "recordFailure"] });
    const r = await runSync(ops);
    expect(r.status).toBe("sync_internal_error");
    expect(r.recoveryUnpersisted).toBe(true);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("recordApiRun throws during recovery → recoveryUnpersisted, release once", async () => {
    const { ops, spies } = mk({ throwOn: ["fetchAllPages", "recordApiRun"] });
    const r = await runSync(ops);
    expect(r.status).toBe("sync_internal_error");
    expect(r.recoveryUnpersisted).toBe(true);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("a THROWN releaseLease (success path) is itself converted to release_unconfirmed", async () => {
    const { ops, spies } = mk({ throwOn: ["releaseLease"] });
    const r = await runSync(ops);
    expect(r.status).toBe("success");            // the sync itself committed
    expect(r.releaseUnconfirmed).toBe(true);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("a thrown releaseLease AND a thrown release-diagnostic → release_unconfirmed + recovery_unpersisted", async () => {
    const { ops } = mk({ throwOn: ["releaseLease", "recordApiRun"] });
    const r = await runSync(ops);
    expect(r.releaseUnconfirmed).toBe(true);
    expect(r.recoveryUnpersisted).toBe(true);
  });
  it("no raw exception or provider payload escapes — the promise resolves to a known code", async () => {
    for (const dep of ["beginRun", "fetchAllPages", "persist", "complete", "releaseLease"]) {
      const { ops } = mk({ throwOn: [dep] });
      const r = await runSync(ops); // never rejects
      expect(["sync_internal_error", "success"]).toContain(r.status);
      expect(JSON.stringify(r)).not.toContain("boom"); // the thrown error's message never leaks
    }
  });
});
