// The REAL order/finance sync orchestration behind injected domain dependencies
// (C.8.1-hardened): a FENCED single-flight lease (asserted before mapping lookup
// and before every bounded persistence batch, and verified under lock at atomic
// completion), a run identity, deterministic bounded batching, and confirmed
// durable totals. Ordinary order sync NEVER marks a slab sold, creates a sold comp,
// mutates a listing, or calls APPLY_SALES; finance sync NEVER moves money. Fully
// unit-testable (all provider/DB ops injected).

import { shapeEbayFinanceTransactions, shapeEbayOrders } from "./ebay-orders-core.ts";
import type { PaginatedResult } from "./ebay-pagination-core.ts";
import type { RawOrder } from "./ebay-orders-pagination.ts";
import type { RawTransaction } from "./ebay-finances-pagination.ts";
import { type CompleteArgs, DEFAULT_OVERLAP_MS, runSync, type SyncOps, type SyncResult } from "./ebay-sync-orchestrator.ts";

// Server-controlled deterministic batch sizes (bounded so larger real-world
// results cannot exceed a single query/payload).
export const SKU_BATCH = 200;
export const ORDER_BATCH = 100;
export const FINANCE_BATCH = 100;
const DEFAULT_INITIAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90d bounded initial sync

const str = (v: unknown): string => (typeof v === "string" ? v : "");
function chunk<T>(a: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
function maxValidTs(values: Array<string | undefined>, nowMs: number): string | null {
  let best: number | null = null, bestStr: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (best === null || t > best) { best = t; bestStr = v; }
  }
  return bestStr;
}

export interface SyncHandlerDeps {
  fetchOrders: (accessToken: string, query: Record<string, string>, beforePageFetch: () => Promise<boolean>) => Promise<PaginatedResult<RawOrder>>;
  fetchFinances: (accessToken: string, query: Record<string, string>, beforePageFetch: () => Promise<boolean>) => Promise<PaginatedResult<RawTransaction>>;
  resolveOrderMappings: (accountId: string, skus: string[]) => Promise<{ ok: true; bySku: Map<string, string> } | { ok: false }>;
  persistOrders: (accountId: string, shaped: unknown[]) => Promise<{ ok: true; durableTotal: number | null; durableLines?: number | null; persisted: number } | { ok: false }>;
  persistFinances: (accountId: string, shaped: unknown[]) => Promise<{ ok: true; durableTotal: number | null; persisted: number } | { ok: false }>;
  leaseAcquire: (accountId: string, resource: string, token: string) => Promise<{ acquired: boolean; error: boolean }>;
  leaseAssert: (accountId: string, resource: string, token: string) => Promise<boolean>;
  leaseRelease: (accountId: string, resource: string, token: string) => Promise<{ released: boolean }>;
  syncBegin: (accountId: string, resource: string, token: string) => Promise<{ ok: true; runId: string; highWatermarkAt: string | null } | { ok: false; errorCode?: string }>;
  syncComplete: (accountId: string, resource: string, token: string, args: CompleteArgs) => Promise<{ ok: boolean; errorCode?: string }>;
  syncFail: (accountId: string, resource: string, runId: string, errorCode: string) => Promise<{ ok: boolean }>;
  recordApiRun: (accountId: string, operation: string, status: string, errorCode: string | null) => Promise<{ ok: boolean }>;
  collectProposedSales?: (sales: unknown[]) => void;
  now: () => number;
  uuid: () => string;
  overlapMs?: number;
  initialWindowMs?: number;
}

function commonOps(accountId: string, resource: string, deps: SyncHandlerDeps, tokenRef: { current: string }) {
  return {
    acquireLease: async () => { tokenRef.current = deps.uuid(); return deps.leaseAcquire(accountId, resource, tokenRef.current); },
    assertLease: () => deps.leaseAssert(accountId, resource, tokenRef.current),
    releaseLease: () => deps.leaseRelease(accountId, resource, tokenRef.current),
    beginRun: async () => { const b = await deps.syncBegin(accountId, resource, tokenRef.current); if (b.ok === false) return { ok: false as const, errorCode: b.errorCode }; return { ok: true as const, state: { highWatermarkAt: b.highWatermarkAt }, runId: b.runId }; },
    complete: (args: CompleteArgs) => deps.syncComplete(accountId, resource, tokenRef.current, args),
    recordFailure: (runId: string, errorCode: string) => deps.syncFail(accountId, resource, runId, errorCode),
    recordApiRun: (status: string, errorCode: string | null) => deps.recordApiRun(accountId, `${resource}_sync`, status, errorCode),
    now: deps.now,
    uuid: deps.uuid,
    overlapMs: deps.overlapMs ?? DEFAULT_OVERLAP_MS,
  };
}

export async function runOrderSync(accountId: string, accessToken: string, deps: SyncHandlerDeps): Promise<SyncResult> {
  const tokenRef = { current: "" };
  const common = commonOps(accountId, "orders", deps, tokenRef);
  const initialFrom = new Date(Math.max(0, deps.now() - (deps.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS))).toISOString();
  const ops: SyncOps<RawOrder> = {
    ...common,
    fetchAllPages: (query) => deps.fetchOrders(accessToken, query, common.assertLease),
    persist: async (orders) => {
      // 1) Resolve SKU→slab mappings in bounded, lease-fenced batches.
      const skus = [...new Set(orders.flatMap((o) => (Array.isArray(o.lineItems) ? o.lineItems : []).map((li) => str((li as Record<string, unknown>).sku)).filter(Boolean)))];
      const bySku = new Map<string, string>();
      for (const batch of chunk(skus, SKU_BATCH)) {
        if (!(await common.assertLease())) return { ok: false, errorCode: "sync_lease_lost" };
        const m = await deps.resolveOrderMappings(accountId, batch);
        if (m.ok === false) return { ok: false, errorCode: "mapping_lookup_failed" };
        for (const [k, v] of m.bySku) bySku.set(k, v);
      }
      const { shaped, proposed_sales } = shapeEbayOrders(orders, bySku);
      // 2) Persist in bounded, lease-fenced batches; the CONFIRMED durable totals are
      // read back from the private tables (idempotent under retries + overlap). An
      // EMPTY result still fences + checks its readback (no fail-open path).
      let persisted = 0, confirmed: number | null = null, confirmedLines: number | null = null;
      for (const batch of (shaped.length === 0 ? [[]] : chunk(shaped, ORDER_BATCH))) {
        if (!(await common.assertLease())) return { ok: false, errorCode: "sync_lease_lost" };
        const p = await deps.persistOrders(accountId, batch);
        if (p.ok === false) return { ok: false, errorCode: "orders_persist_failed" };
        persisted += p.persisted; confirmed = p.durableTotal; confirmedLines = p.durableLines ?? null;
      }
      deps.collectProposedSales?.(proposed_sales); // only after every batch persisted
      return { ok: true, durableTotal: confirmed, durableSecondary: confirmedLines, persisted };
    },
    // Fulfillment getOrders `lastmodifieddate` filter is aligned with the watermark
    // (which uses lastModifiedDate), so an older order modified recently is captured.
    extractWatermark: (orders) => maxValidTs(orders.map((o) => str(o.lastModifiedDate) || str(o.creationDate)), deps.now()),
    buildQuery: (from) => { const effectiveStartAt = from ?? initialFrom; return { query: { limit: "200", filter: `lastmodifieddate:[${effectiveStartAt}..]` }, effectiveStartAt }; },
  };
  return runSync(ops);
}

export async function runFinanceSync(accountId: string, accessToken: string, deps: SyncHandlerDeps): Promise<SyncResult> {
  const tokenRef = { current: "" };
  const common = commonOps(accountId, "finances", deps, tokenRef);
  const initialFrom = new Date(Math.max(0, deps.now() - (deps.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS))).toISOString();
  const ops: SyncOps<RawTransaction> = {
    ...common,
    fetchAllPages: (query) => deps.fetchFinances(accessToken, query, common.assertLease),
    persist: async (txns) => {
      const shaped = shapeEbayFinanceTransactions(txns);
      let persisted = 0, confirmed: number | null = null;
      // An EMPTY result still fences + checks its readback (no fail-open path).
      for (const batch of (shaped.length === 0 ? [[]] : chunk(shaped, FINANCE_BATCH))) {
        if (!(await common.assertLease())) return { ok: false, errorCode: "sync_lease_lost" };
        const p = await deps.persistFinances(accountId, batch);
        if (p.ok === false) return { ok: false, errorCode: "finances_persist_failed" };
        persisted += p.persisted; confirmed = p.durableTotal;
      }
      return { ok: true, durableTotal: confirmed, persisted };
    },
    extractWatermark: (txns) => maxValidTs(txns.map((t) => str(t.transactionDate)), deps.now()),
    buildQuery: (from) => { const effectiveStartAt = from ?? initialFrom; return { query: { limit: "200", filter: `transactionDate:[${effectiveStartAt}..]` }, effectiveStartAt }; },
  };
  return runSync(ops);
}
