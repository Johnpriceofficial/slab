// The shared, DEPENDENCY-INJECTED order/finance sync orchestrator (C.8.1-hardened):
// single-flight FENCED lease → begin a run (durable run_id) → fetch ALL pages from
// (watermark − overlap) → assert the lease → idempotently persist in bounded,
// lease-fenced batches → ATOMICALLY complete (one RPC verifies the lease token +
// run_id, writes the success audit, advances the watermark, marks complete). The
// watermark advances ONLY inside that atomic completion; any failure records a
// CHECKED failure (never leaves the run `running`), retains the prior watermark,
// and the next run re-fetches the overlap and converges. Fully unit-testable.

import type { PaginatedResult } from "./ebay-pagination-core.ts";

export const DEFAULT_OVERLAP_MS = 72 * 60 * 60 * 1000; // 72h re-fetch window for late arrivals

export interface SyncState { highWatermarkAt: string | null }

export interface CompleteArgs {
  runId: string;
  highWatermarkAt: string | null;
  overlapStartAt: string | null;
  pagesFetched: number;
  recordsFetched: number;
  recordsPersisted: number;
  durableTotal: number | null;
}

export interface SyncOps<T> {
  acquireLease: () => Promise<{ acquired: boolean; error: boolean }>;
  assertLease: () => Promise<boolean>;
  releaseLease: () => Promise<{ released: boolean }>;
  beginRun: () => Promise<{ ok: true; state: SyncState; runId: string } | { ok: false }>;
  fetchAllPages: (query: Record<string, string>) => Promise<PaginatedResult<T>>;
  // Persist in bounded, lease-fenced batches; returns the CONFIRMED durable totals.
  persist: (items: T[], runId: string) => Promise<{ ok: true; durableTotal: number | null; durableSecondary?: number | null; persisted: number } | { ok: false; errorCode: string }>;
  // ATOMIC completion: verifies lease token + run_id, writes success audit, advances
  // watermark, marks complete — all in one transaction.
  complete: (args: CompleteArgs) => Promise<{ ok: boolean; errorCode?: string }>;
  recordFailure: (runId: string, errorCode: string) => Promise<{ ok: boolean }>;
  recordApiRun: (status: string, errorCode: string | null) => Promise<{ ok: boolean }>;
  extractWatermark: (items: T[]) => string | null;
  buildQuery: (fromInclusive: string | null) => Record<string, string>;
  overlapMs?: number;
  now: () => number;
  uuid: () => string;
}

export interface SyncResult {
  status: string;
  httpStatus: number;
  errorCode?: string;
  runId?: string;
  pagesFetched?: number;
  recordsFetched?: number;
  recordsPersisted?: number;
  durableTotal?: number | null;
  durableSecondary?: number | null;
  deduplicated?: number;
  highWatermarkAt?: string | null;
  recoveryUnpersisted?: boolean;
}

export function incrementalStart(highWatermarkAt: string | null, overlapMs: number, nowMs: number): string | null {
  if (!highWatermarkAt) return null;
  const t = Date.parse(highWatermarkAt);
  if (!Number.isFinite(t)) return null;
  const start = Math.min(t - overlapMs, nowMs);
  return new Date(Math.max(0, start)).toISOString();
}

export function advanceWatermark(prior: string | null, latest: string | null): string | null {
  const p = prior ? Date.parse(prior) : NaN;
  const l = latest ? Date.parse(latest) : NaN;
  if (!Number.isFinite(l)) return prior;
  if (!Number.isFinite(p)) return latest;
  return l > p ? latest : prior;
}

const READ_FAIL = new Set(["provider_lookup_failed", "provider_redirect_rejected", "provider_timeout", "unsafe_pagination_url", "pagination_loop", "pagination_limit_exceeded", "malformed_provider_response", "inconsistent_provider_pagination", "incomplete_provider_result", "invalid_api_origin"]);

export async function runSync<T>(ops: SyncOps<T>): Promise<SyncResult> {
  const lease = await ops.acquireLease();
  if (lease.error) return { status: "error", errorCode: "sync_lease_acquire_failed", httpStatus: 500 };
  if (!lease.acquired) return { status: "sync_in_progress", httpStatus: 409 };
  try {
    const begun = await ops.beginRun();
    if (begun.ok === false) return { status: "error", errorCode: "sync_state_load_failed", httpStatus: 500 };
    const runId = begun.runId;
    const prior = begun.state.highWatermarkAt;
    const from = incrementalStart(prior, ops.overlapMs ?? DEFAULT_OVERLAP_MS, ops.now());

    // A CHECKED failure path: record the failed state + error audit, and surface
    // whether either recovery write itself failed (never silently leave `running`).
    const fail = async (code: string, http: number): Promise<SyncResult> => {
      const f = await ops.recordFailure(runId, code);
      const a = await ops.recordApiRun("error", code);
      return { status: code, errorCode: code, httpStatus: http, runId, highWatermarkAt: prior, recoveryUnpersisted: (!f.ok || !a.ok) || undefined };
    };

    const res = await ops.fetchAllPages(ops.buildQuery(from));
    if (res.ok === false) return await fail(res.errorCode, READ_FAIL.has(res.errorCode) ? 502 : 500);

    // Fence BEFORE persistence (the persist op fences again per batch; complete
    // fences under lock).
    if (!(await ops.assertLease())) return await fail("sync_lease_lost", 409);

    const persisted = await ops.persist(res.items, runId);
    if (persisted.ok === false) return await fail(persisted.errorCode, persisted.errorCode === "sync_lease_lost" ? 409 : 500);

    const newWatermark = advanceWatermark(prior, ops.extractWatermark(res.items));
    const done = await ops.complete({ runId, highWatermarkAt: newWatermark, overlapStartAt: from, pagesFetched: res.pagesFetched, recordsFetched: res.items.length, recordsPersisted: persisted.persisted, durableTotal: persisted.durableTotal });
    if (!done.ok) return await fail(done.errorCode ?? "sync_complete_failed", done.errorCode === "lease_lost" || done.errorCode === "stale_runner" ? 409 : 500);

    return {
      status: "success", httpStatus: 200, runId, pagesFetched: res.pagesFetched,
      recordsFetched: res.items.length, recordsPersisted: persisted.persisted,
      durableTotal: persisted.durableTotal, durableSecondary: persisted.durableSecondary ?? null,
      deduplicated: res.deduplicatedCount, highWatermarkAt: newWatermark,
    };
  } finally {
    const rel = await ops.releaseLease();
    if (!rel.released) await ops.recordApiRun("error", "sync_lease_release_unconfirmed");
  }
}
