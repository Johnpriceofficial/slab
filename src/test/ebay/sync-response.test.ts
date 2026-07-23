import { describe, it, expect } from "vitest";
import { syncBody } from "../../../supabase/functions/_shared/ebay-sync-response";
import type { SyncResult } from "../../../supabase/functions/_shared/ebay-sync-orchestrator";

// syncBody is the SINGLE response mapper both the order_sync and finances_sync
// routes serialize through. These tests exercise it with the EXACT `extra` payloads
// each route passes, proving cleanup uncertainty (release_unconfirmed) reaches the
// HTTP response body for BOTH resources — not merely the pure orchestrator result.

const committed = (over: Partial<SyncResult> = {}): SyncResult => ({
  status: "success", httpStatus: 200, runId: "RUN-1", pagesFetched: 1, recordsFetched: 3,
  recordsPersisted: 3, durableTotal: 3, durableSecondary: 5, deduplicated: 0,
  highWatermarkAt: "2026-07-20T00:00:00Z", ...over,
});

// The literal `extra` objects the two routes build (mirrors ebay.ts order_sync / finances_sync).
const orderExtra = (r: SyncResult) => ({ mode: "synced", processed_orders: r.recordsFetched ?? 0, processed_lines: r.recordsPersisted ?? 0, confirmed_order_total: r.durableTotal ?? 0, confirmed_line_total: r.durableSecondary ?? 0, proposed_sales: [], proposed_sale_count: 0, orders_synced: r.durableTotal ?? 0, source_label: "Seller’s Completed Sale", message: "x" });
const financeExtra = (r: SyncResult) => ({ financial_transactions_synced: r.recordsPersisted ?? 0, financial_transactions_total: r.durableTotal ?? null, note: "x" });

describe("syncBody — honest cleanup serialization for both sync routes", () => {
  it("committed sync + confirmed release → status success, NO release_unconfirmed field", () => {
    const r = committed();
    for (const b of [syncBody(r, orderExtra(r)), syncBody(r, financeExtra(r))]) {
      expect(b.status).toBe("success");
      expect("release_unconfirmed" in b).toBe(false);
      expect("recovery_unpersisted" in b).toBe(false);
    }
  });

  it("committed sync + FAILED release → order_sync response carries status success + release_unconfirmed", () => {
    const r = committed({ releaseUnconfirmed: true });
    const b = syncBody(r, orderExtra(r));
    expect(b).toMatchObject({ status: "success", release_unconfirmed: true });
    expect(b.confirmed_order_total).toBe(3); // route-specific payload preserved alongside the warning
  });

  it("committed sync + FAILED release → finances_sync response carries status success + release_unconfirmed", () => {
    const r = committed({ releaseUnconfirmed: true });
    const b = syncBody(r, financeExtra(r));
    expect(b).toMatchObject({ status: "success", release_unconfirmed: true });
    expect(b.financial_transactions_synced).toBe(3);
  });

  it("failed release AND failed diagnostic → both release_unconfirmed and recovery_unpersisted serialized (both routes)", () => {
    const r = committed({ releaseUnconfirmed: true, recoveryUnpersisted: true });
    for (const b of [syncBody(r, orderExtra(r)), syncBody(r, financeExtra(r))]) {
      expect(b.release_unconfirmed).toBe(true);
      expect(b.recovery_unpersisted).toBe(true);
    }
  });

  it("an unexpected internal error is serialized as a stable code, never a raw payload", () => {
    const r: SyncResult = { status: "sync_internal_error", errorCode: "sync_internal_error", httpStatus: 500, runId: "RUN-1", highWatermarkAt: "2026-07-05T00:00:00Z", recoveryUnpersisted: true };
    const b = syncBody(r);
    expect(b).toMatchObject({ status: "sync_internal_error", error_code: "sync_internal_error", recovery_unpersisted: true });
  });
});
