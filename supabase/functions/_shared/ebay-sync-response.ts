// The single, pure order/finance sync HTTP response mapper. Both the order_sync
// and finances_sync routes serialize their SyncResult through this function, so a
// committed-but-cleanup-uncertain run is reported HONESTLY to the caller:
//  - recovery_unpersisted: a failure/audit write could not be persisted;
//  - release_unconfirmed:  the sync committed but the lease could not be released.
// Kept dependency-free (Web-standard only) so it is fully unit-testable.

import type { SyncResult } from "./ebay-sync-orchestrator.ts";

export function syncBody(r: SyncResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const b: Record<string, unknown> = { status: r.status };
  if (r.errorCode) b.error_code = r.errorCode;
  if (r.pagesFetched !== undefined) b.pages_fetched = r.pagesFetched;
  if (r.recordsFetched !== undefined) b.records_fetched = r.recordsFetched;
  if (r.recordsPersisted !== undefined) b.records_persisted = r.recordsPersisted;
  if (r.durableTotal !== undefined) b.durable_total = r.durableTotal;
  if (r.durableSecondary !== undefined && r.durableSecondary !== null) b.durable_secondary = r.durableSecondary;
  if (r.deduplicated !== undefined) b.deduplicated = r.deduplicated;
  if (r.highWatermarkAt !== undefined) b.high_watermark_at = r.highWatermarkAt;
  if (r.recoveryUnpersisted) b.recovery_unpersisted = true;
  // The sync may have committed atomically while lease cleanup could NOT be
  // confirmed — surface that uncertainty to the caller instead of a clean success.
  if (r.releaseUnconfirmed) b.release_unconfirmed = true;
  return { ...b, ...extra };
}
