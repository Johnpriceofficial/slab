// The REAL order/finance sync orchestration behind injected domain dependencies —
// the same routing the deployed ebay-order-sync / ebay-finances-sync entrypoints
// delegate to (handleEbay is a thin wrapper). It binds the shared fail-closed
// paginator + watermark orchestrator to durable persistence, sync-state, and the
// single-flight sync lease. Ordinary order sync NEVER marks a slab sold, creates a
// sold comp, mutates a listing, or calls APPLY_SALES; finance sync NEVER moves
// money. Fully unit-testable (all provider/DB ops injected).

import { shapeEbayFinanceTransactions, shapeEbayOrders } from "./ebay-orders-core.ts";
import type { PaginatedResult } from "./ebay-pagination-core.ts";
import type { RawOrder } from "./ebay-orders-pagination.ts";
import type { RawTransaction } from "./ebay-finances-pagination.ts";
import { DEFAULT_OVERLAP_MS, runSync, type SyncOps, type SyncResult } from "./ebay-sync-orchestrator.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
// The newest VALID (parseable, not-future) provider timestamp among records.
function maxValidTs(values: Array<string | undefined>, nowMs: number): string | null {
  let best: number | null = null, bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || t > nowMs) continue;         // malformed or future → ignored (never corrupts the watermark)
    if (best === null || t > best) { best = t; bestStr = v; }
  }
  return bestStr;
}

export interface SyncHandlerDeps {
  fetchOrders: (accessToken: string, query: Record<string, string>) => Promise<PaginatedResult<RawOrder>>;
  fetchFinances: (accessToken: string, query: Record<string, string>) => Promise<PaginatedResult<RawTransaction>>;
  resolveOrderMappings: (accountId: string, skus: string[]) => Promise<{ ok: true; bySku: Map<string, string> } | { ok: false }>;
  persistOrders: (accountId: string, shaped: unknown[]) => Promise<{ ok: true; durableTotal: number | null; persisted: number } | { ok: false }>;
  persistFinances: (accountId: string, shaped: unknown[]) => Promise<{ ok: true; durableTotal: number | null; persisted: number } | { ok: false }>;
  leaseAcquire: (accountId: string, resource: string, token: string) => Promise<{ acquired: boolean; error: boolean }>;
  leaseRelease: (accountId: string, resource: string, token: string) => Promise<{ released: boolean }>;
  syncStateLoad: (accountId: string, resource: string) => Promise<{ ok: true; highWatermarkAt: string | null } | { ok: false }>;
  syncStateCommit: (accountId: string, resource: string, args: { runId: string; highWatermarkAt: string | null; pagesFetched: number; recordsFetched: number; recordsPersisted: number; durableTotal: number | null }) => Promise<{ ok: boolean }>;
  syncStateFail: (accountId: string, resource: string, runId: string, errorCode: string) => Promise<{ ok: boolean }>;
  recordApiRun: (accountId: string, operation: string, status: string, errorCode: string | null) => Promise<{ ok: boolean }>;
  // Optional: receive the proposed-sale audit rows derived from the shaped orders
  // (surfaced by the handler to the UI; APPLY_SALES stays a separate operation).
  collectProposedSales?: (sales: unknown[]) => void;
  now: () => number;
  uuid: () => string;
  overlapMs?: number;
  initialWindowMs?: number;   // bounded first-sync range
}

const DEFAULT_INITIAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90d bounded initial sync

// Shared SyncOps built with a PER-RUN lease token (a local ref — never shared
// module state, so concurrent order + finance runs cannot clobber each other).
function commonOps(accountId: string, resource: string, deps: SyncHandlerDeps, tokenRef: { current: string }) {
  return {
    acquireLease: async () => { tokenRef.current = deps.uuid(); return deps.leaseAcquire(accountId, resource, tokenRef.current); },
    releaseLease: () => deps.leaseRelease(accountId, resource, tokenRef.current),
    loadSyncState: async () => { const s = await deps.syncStateLoad(accountId, resource); return s.ok ? { ok: true as const, state: { highWatermarkAt: s.highWatermarkAt } } : { ok: false as const }; },
    commitSyncState: (args: { runId: string; highWatermarkAt: string | null; pagesFetched: number; recordsFetched: number; recordsPersisted: number; durableTotal: number | null }) => deps.syncStateCommit(accountId, resource, args),
    recordFailure: (runId: string, errorCode: string) => deps.syncStateFail(accountId, resource, runId, errorCode),
    recordApiRun: (status: string, errorCode: string | null) => deps.recordApiRun(accountId, `${resource}_sync`, status, errorCode),
    now: deps.now,
    uuid: deps.uuid,
    overlapMs: deps.overlapMs ?? DEFAULT_OVERLAP_MS,
  };
}

export async function runOrderSync(accountId: string, accessToken: string, deps: SyncHandlerDeps): Promise<SyncResult> {
  const tokenRef = { current: "" };
  const initialFrom = new Date(Math.max(0, deps.now() - (deps.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS))).toISOString();
  const ops: SyncOps<RawOrder> = {
    ...commonOps(accountId, "orders", deps, tokenRef),
    fetchAllPages: (query) => deps.fetchOrders(accessToken, query),
    persist: async (orders) => {
      const skus = [...new Set(orders.flatMap((o) => (Array.isArray(o.lineItems) ? o.lineItems : []).map((li) => str((li as Record<string, unknown>).sku)).filter(Boolean)))];
      const mapRes = skus.length ? await deps.resolveOrderMappings(accountId, skus) : { ok: true as const, bySku: new Map<string, string>() };
      if (mapRes.ok === false) return { ok: false, errorCode: "mapping_lookup_failed" };
      const { shaped, proposed_sales } = shapeEbayOrders(orders, mapRes.bySku);
      const p = await deps.persistOrders(accountId, shaped);
      if (p.ok) deps.collectProposedSales?.(proposed_sales); // only from successfully persisted lines
      return p.ok ? { ok: true, durableTotal: p.durableTotal, persisted: p.persisted } : { ok: false, errorCode: "orders_persist_failed" };
    },
    extractWatermark: (orders) => maxValidTs(orders.map((o) => str(o.lastModifiedDate) || str(o.creationDate)), deps.now()),
    buildQuery: (from) => ({ limit: "200", filter: `creationdate:[${from ?? initialFrom}..]` }),
  };
  return runSync(ops);
}

export async function runFinanceSync(accountId: string, accessToken: string, deps: SyncHandlerDeps): Promise<SyncResult> {
  const tokenRef = { current: "" };
  const initialFrom = new Date(Math.max(0, deps.now() - (deps.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS))).toISOString();
  const ops: SyncOps<RawTransaction> = {
    ...commonOps(accountId, "finances", deps, tokenRef),
    fetchAllPages: (query) => deps.fetchFinances(accessToken, query),
    persist: async (txns) => {
      const shaped = shapeEbayFinanceTransactions(txns);
      const p = await deps.persistFinances(accountId, shaped);
      return p.ok ? { ok: true, durableTotal: p.durableTotal, persisted: p.persisted } : { ok: false, errorCode: "finances_persist_failed" };
    },
    extractWatermark: (txns) => maxValidTs(txns.map((t) => str(t.transactionDate)), deps.now()),
    buildQuery: (from) => ({ limit: "200", filter: `transactionDate:[${from ?? initialFrom}..]` }),
  };
  return runSync(ops);
}
