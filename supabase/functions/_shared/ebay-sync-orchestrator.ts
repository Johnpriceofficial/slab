// The shared, DEPENDENCY-INJECTED order/finance sync orchestrator: single-flight
// lease → read durable sync state → fetch ALL pages from (watermark − overlap) →
// persist idempotently → read durable totals → advance the high watermark and
// commit sync state → checked api-run → checked lease release. ATOMIC run
// completion: the watermark advances and the run is marked complete ONLY after
// every page fetched, every record validated + persisted, and the durable state
// committed. A failure at any stage RETAINS the previous watermark, records a safe
// failure, and never marks the partial result complete — the next run re-fetches
// the overlap and converges. Fully unit-testable (all provider/DB ops injected).

import type { PaginatedResult } from "./ebay-pagination-core.ts";

export const DEFAULT_OVERLAP_MS = 72 * 60 * 60 * 1000; // 72h re-fetch window for late arrivals

export interface SyncState { highWatermarkAt: string | null }

export interface CommitArgs {
  runId: string;
  highWatermarkAt: string | null;
  pagesFetched: number;
  recordsFetched: number;
  recordsPersisted: number;
  durableTotal: number | null;
}

export interface SyncOps<T> {
  acquireLease: () => Promise<{ acquired: boolean; error: boolean }>;
  releaseLease: () => Promise<{ released: boolean }>;
  loadSyncState: () => Promise<{ ok: true; state: SyncState } | { ok: false }>;
  fetchAllPages: (query: Record<string, string>) => Promise<PaginatedResult<T>>;
  persist: (items: T[]) => Promise<{ ok: true; durableTotal: number | null; persisted: number } | { ok: false; errorCode: string }>;
  commitSyncState: (args: CommitArgs) => Promise<{ ok: boolean }>;
  recordFailure: (runId: string, errorCode: string) => Promise<{ ok: boolean }>;
  recordApiRun: (status: string, errorCode: string | null) => Promise<{ ok: boolean }>;
  // Max VALID provider timestamp among items (rejects future/malformed), or null.
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
  deduplicated?: number;
  highWatermarkAt?: string | null;
}

// The bounded incremental start: (prior high watermark − overlap). Null watermark
// (first sync) yields null → buildQuery decides the bounded initial range.
export function incrementalStart(highWatermarkAt: string | null, overlapMs: number, nowMs: number): string | null {
  if (!highWatermarkAt) return null;
  const t = Date.parse(highWatermarkAt);
  if (!Number.isFinite(t)) return null;                     // malformed stored watermark → full bounded initial
  const start = Math.min(t - overlapMs, nowMs);
  return new Date(Math.max(0, start)).toISOString();
}

// Advance the high watermark to the max of the prior watermark and the newest
// VALID record timestamp — never backwards, never on a malformed/future value.
export function advanceWatermark(prior: string | null, latest: string | null): string | null {
  const p = prior ? Date.parse(prior) : NaN;
  const l = latest ? Date.parse(latest) : NaN;
  if (!Number.isFinite(l)) return prior;                    // no valid new timestamp → keep prior
  if (!Number.isFinite(p)) return latest;
  return l > p ? latest : prior;
}

export async function runSync<T>(ops: SyncOps<T>): Promise<SyncResult> {
  const lease = await ops.acquireLease();
  if (lease.error) return { status: "error", errorCode: "sync_lease_acquire_failed", httpStatus: 500 };
  if (!lease.acquired) return { status: "sync_in_progress", httpStatus: 409 };
  const runId = ops.uuid();
  try {
    const loaded = await ops.loadSyncState();
    if (loaded.ok === false) return { status: "error", errorCode: "sync_state_load_failed", httpStatus: 500 };
    const prior = loaded.state.highWatermarkAt;
    const from = incrementalStart(prior, ops.overlapMs ?? DEFAULT_OVERLAP_MS, ops.now());

    const res = await ops.fetchAllPages(ops.buildQuery(from));
    if (res.ok === false) {
      await ops.recordFailure(runId, res.errorCode);
      await ops.recordApiRun("error", res.errorCode);
      return { status: res.errorCode, errorCode: res.errorCode, httpStatus: 502, runId, highWatermarkAt: prior };
    }

    const persisted = await ops.persist(res.items);
    if (persisted.ok === false) {
      await ops.recordFailure(runId, persisted.errorCode);
      await ops.recordApiRun("error", persisted.errorCode);
      return { status: "error", errorCode: persisted.errorCode, httpStatus: 500, runId, highWatermarkAt: prior };
    }

    const newWatermark = advanceWatermark(prior, ops.extractWatermark(res.items));
    const commit = await ops.commitSyncState({ runId, highWatermarkAt: newWatermark, pagesFetched: res.pagesFetched, recordsFetched: res.items.length, recordsPersisted: persisted.persisted, durableTotal: persisted.durableTotal });
    if (!commit.ok) {
      await ops.recordApiRun("error", "sync_state_commit_failed");
      return { status: "error", errorCode: "sync_state_commit_failed", httpStatus: 500, runId, highWatermarkAt: prior };
    }
    const runOk = await ops.recordApiRun("success", null);
    if (!runOk.ok) return { status: "error", errorCode: "api_run_persist_failed", httpStatus: 500, runId };
    return {
      status: "success", httpStatus: 200, runId, pagesFetched: res.pagesFetched,
      recordsFetched: res.items.length, recordsPersisted: persisted.persisted,
      durableTotal: persisted.durableTotal, deduplicated: res.deduplicatedCount, highWatermarkAt: newWatermark,
    };
  } finally {
    const rel = await ops.releaseLease();
    if (!rel.released) await ops.recordApiRun("error", "sync_lease_release_unconfirmed");
  }
}
