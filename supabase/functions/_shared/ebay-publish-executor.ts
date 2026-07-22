// The REAL publish/reconcile orchestration, extracted behind injected operations
// so the exact code path the Edge handler runs is executable in tests with mocked
// dependencies. Every provider read (getOffers → getInventoryItem) and the full
// comparison happen in the shared state engine BEFORE any mutation, so a block,
// validation failure, persistence failure, lease loss, or provider-read failure
// can NEVER be followed by a provider mutation. Every expected single-row write is
// checked (no error + exactly one affected row); a fallback-write failure is
// reported honestly (a safe api-run diagnostic, never a false recovery claim).

import { evaluateLocalIntent, type LocalIntentRecord } from "./ebay-local-intent.ts";
import { type DurableLocal, type EngineDecision, evaluateProviderState } from "./ebay-provider-state-engine.ts";
import { parseImageManifest, parseIntendedState, type ImageManifestV1, type IntendedStateV1 } from "./ebay-intended-state.ts";
import type { OffersDiscovery } from "./ebay-offers.ts";
import type { InventoryItemResult } from "./ebay-inventory-item.ts";

export interface StoredIntent {
  id: string;
  status: string;
  fingerprint: string | null;
  fingerprintVersion: number | null;
  offerId: string | null;
  listingId: string | null;
  intendedState: unknown;
  imageManifest: unknown;
  providerVerified: boolean;
}

export interface PreparingSnapshot {
  intendedState: IntendedStateV1;
  imageManifest: ImageManifestV1;
  fingerprint: string;
  fingerprintVersion: number;
}

export interface MappingRecord { offerId: string; listingId: string | null }

export interface PublishExecutorOps {
  loadIntent: () => Promise<{ ok: true; intent: StoredIntent | null } | { ok: false }>;
  // Upsert the intent to `preparing` WITH the durable snapshot; checked (exactly one row).
  writePreparing: (snap: PreparingSnapshot) => Promise<{ ok: true; intentId: string } | { ok: false }>;
  // Checked single-row status update (no error + exactly one affected row).
  recordStatus: (intentId: string, status: string, lastError: string) => Promise<boolean>;
  // Checked single-row update recording the CREATED offer identity + verification
  // time (status=offer_created, offer_id, provider_verified_at) — the durable proof
  // a retry uses to resume our own offer instead of creating a duplicate.
  recordOfferCreated: (intentId: string, offerId: string) => Promise<boolean>;
  // Checked single-row update stamping status=published, ids, and provider_verified_at.
  setProviderVerified: (intentId: string, offerId: string, listingId: string | null) => Promise<boolean>;
  // Checked single-row mapping upsert.
  upsertMapping: (m: MappingRecord) => Promise<boolean>;
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
  assertLease: () => Promise<boolean>;
  putInventoryItem: () => Promise<{ ok: boolean }>;
  createOffer: () => Promise<{ ok: boolean; offerId: string | null }>;
  publishOffer: (offerId: string) => Promise<{ ok: boolean; listingId: string | null }>;
  recordApiRun: (operation: string, status: string, errorCode: string | null) => Promise<boolean>;
  releaseLease: () => Promise<{ released: boolean }>;
}

export interface PublishContext {
  intended: IntendedStateV1;
  manifest: ImageManifestV1;
  fingerprint: string;
  fingerprintVersion: number;
}

export interface ExecResult {
  status: string;
  httpStatus: number;
  errorCode?: string;
  offerId?: string;
  listingId?: string | null;
  offerIds?: string[];
  imageEvidence?: string;
  reconciled?: boolean;
  context?: string;
  message?: string;
}

// A provider READ failure → 502; a comparison/local block → 409.
const READ_FAILURE = new Set<EngineDecision>(["provider_lookup_failed", "inventory_item_lookup_failed", "invalid_provider_response", "provider_redirect_rejected", "provider_timeout"]);

function toLocalRecord(intent: StoredIntent | null): LocalIntentRecord | null {
  if (!intent) return null;
  return {
    status: intent.status,
    fingerprint: intent.fingerprint,
    fingerprintVersion: intent.fingerprintVersion,
    offerId: intent.offerId,
    listingId: intent.listingId,
    intendedState: intent.intendedState,
    imageManifest: intent.imageManifest,
  };
}

function toDurableLocal(intent: StoredIntent | null): DurableLocal | null {
  if (!intent) return null;
  return {
    status: intent.status,
    fingerprint: intent.fingerprint,
    offerId: intent.offerId,
    listingId: intent.listingId,
    manifest: parseImageManifest(intent.imageManifest),
    providerVerified: intent.providerVerified,
  };
}

/**
 * Execute a publish. Returns a transport-neutral result the handler maps to HTTP.
 * The publish lease is assumed HELD on entry and is released in the finally.
 */
export async function executePublish(ops: PublishExecutorOps, ctx: PublishContext): Promise<ExecResult> {
  try {
    const load = await ops.loadIntent();
    if (load.ok === false) return { status: "error", errorCode: "listing_intent_lookup_failed", httpStatus: 500 };
    const existing = load.intent;

    // 1) Pre-read local-intent gate — never overwrite a live/in-flight intent, and
    // never touch the provider on a block.
    const gate = evaluateLocalIntent(toLocalRecord(existing), { fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion });
    if (!gate.proceed) {
      if (gate.code === "prior_publish_in_progress") return { status: "offer_created_unpersisted", httpStatus: 409, message: "A prior publish created an eBay offer that was not saved locally. Run reconcile before publishing this SKU again." };
      return { status: gate.code, errorCode: gate.code, httpStatus: 409, offerId: gate.offerId ?? undefined, listingId: gate.listingId ?? undefined };
    }

    // 2) Write `preparing` (with the durable snapshot) ONLY when there is no live
    // artifact to clobber; otherwise keep the existing row and let the engine decide.
    let intentId: string;
    if (gate.writePreparing) {
      const prep = await ops.writePreparing({ intendedState: ctx.intended, imageManifest: ctx.manifest, fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion });
      if (prep.ok === false) return { status: "error", errorCode: "listing_intent_persist_failed", httpStatus: 500 };
      intentId = prep.intentId;
    } else {
      intentId = existing!.id;
    }

    // 3) Read-all-then-decide via the shared engine. NO mutation here.
    const res = await evaluateProviderState(
      { discoverOffers: ops.discoverOffers, fetchInventoryItem: ops.fetchInventoryItem },
      { intended: ctx.intended, manifest: ctx.manifest, fingerprint: ctx.fingerprint, local: toDurableLocal(existing) },
    );

    // 4) Provider read failure → block, 502, NO mutation.
    if (res.providerFailure) {
      const code = res.providerErrorCode ?? res.decision;
      if (!(await ops.recordStatus(intentId, "blocked", code))) return { status: "error", errorCode: "intent_persist_failed", context: code, httpStatus: 500 };
      return { status: code, errorCode: code, httpStatus: 502 };
    }

    // 5) Comparison / local blocks → 409, NO mutation.
    if (res.decision === "existing_offer_requires_review") {
      if (!(await ops.recordStatus(intentId, "requires_review", res.decision))) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
      return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, imageEvidence: res.imageEvidence };
    }
    const BLOCK_DECISIONS: EngineDecision[] = ["local_intent_inputs_changed", "local_provider_identity_conflict", "existing_offer_inputs_changed", "existing_listing_inputs_changed", "incompatible_offer_exists", "duplicate_offer_ambiguity", "listing_on_hold", "block"];
    if (BLOCK_DECISIONS.includes(res.decision)) {
      if (!(await ops.recordStatus(intentId, "blocked", res.decision))) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
      return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, offerIds: res.offerIds, imageEvidence: res.imageEvidence };
    }

    // 6) LOCAL-ONLY reconcile of an already-published exact listing (no provider mutation).
    if (res.decision === "reconcile_exact_published" || res.decision === "already_published_exact") {
      const mapped = await ops.upsertMapping({ offerId: res.offerId!, listingId: res.listingId ?? null });
      const verified = await ops.setProviderVerified(intentId, res.offerId!, res.listingId ?? null);
      if (!mapped || !verified) {
        if (!(await ops.recordStatus(intentId, "published_unmapped", "reconcile_local_persist_failed"))) await ops.recordApiRun("publish", "error", "published_unmapped_persist_failed");
        return { status: "published_unmapped", httpStatus: 500, offerId: res.offerId, listingId: res.listingId, message: "eBay already has a live listing for this SKU but the local mapping write failed — run reconcile." };
      }
      return { status: "success", reconciled: true, offerId: res.offerId, listingId: res.listingId, httpStatus: 200 };
    }

    // 7) MUTATION plans — create_new / resume_local_exact / adopt_exact_unpublished.
    // Each provider step is lease-fenced; a lost lease aborts BEFORE any mutation.
    if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409, message: "The publish lease was lost or superseded; aborting before any eBay mutation." };
    const put = await ops.putInventoryItem();
    if (!put.ok) return { status: "error", errorCode: "inventory_put_failed", httpStatus: 502 };
    if (!(await ops.recordStatus(intentId, "inventory_created", "inventory_put"))) return { status: "error", errorCode: "intent_persist_failed", httpStatus: 500 };

    let offerId = res.offerId ?? "";
    if (res.decision === "create_new") {
      if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409 };
      const created = await ops.createOffer();
      offerId = created.ok ? (created.offerId ?? "") : "";
      if (!offerId) { await ops.recordStatus(intentId, "failed", "no_offer_id"); return { status: "error", errorCode: "offer_creation_failed", httpStatus: 502 }; }
      if (!(await ops.recordOfferCreated(intentId, offerId))) {
        await ops.recordStatus(intentId, "offer_created_unpersisted", `offer_id_persist_failed:${offerId}`);
        return { status: "offer_created_unpersisted", offerId, httpStatus: 500, message: "An eBay offer exists but its ID could not be saved locally. Run reconcile; a retry will re-adopt it (no duplicate)." };
      }
    }

    if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409 };
    const published = await ops.publishOffer(offerId);
    if (!published.ok) return { status: "error", errorCode: "publish_failed", httpStatus: 502, offerId };
    const listingId = published.listingId;
    const mapped = await ops.upsertMapping({ offerId, listingId });
    const verified = await ops.setProviderVerified(intentId, offerId, listingId);
    if (!mapped || !verified) {
      if (!(await ops.recordStatus(intentId, "published_unmapped", "local_persist_failed"))) await ops.recordApiRun("publish", "error", "published_unmapped_persist_failed");
      return { status: "published_unmapped", offerId, listingId, httpStatus: 500, message: "The eBay listing is LIVE but local reconciliation failed. The listing was NOT withdrawn — run reconcile to repair the local mapping." };
    }
    return { status: "success", offerId, listingId, httpStatus: 200 };
  } finally {
    const rel = await ops.releaseLease();
    if (!rel.released) await ops.recordApiRun("publish_lease_release", "error", "lease_release_unconfirmed");
  }
}

export interface ReconcileOps {
  loadIntent: () => Promise<{ ok: true; intent: StoredIntent | null } | { ok: false }>;
  recordStatus: (intentId: string, status: string, lastError: string) => Promise<boolean>;
  setProviderVerified: (intentId: string, offerId: string, listingId: string | null) => Promise<boolean>;
  upsertMapping: (m: MappingRecord) => Promise<boolean>;
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
}

/**
 * Execute a reconcile through the SAME comparison engine as publish, using the
 * DURABLE intended-state snapshot (never request-body values) as the source of
 * truth. A missing/invalid snapshot fails closed. A local mapping is written ONLY
 * for an exact already-published match — never merely because getOffers returned
 * one offer. No provider mutation ever occurs.
 */
export async function executeReconcile(ops: ReconcileOps): Promise<ExecResult> {
  const load = await ops.loadIntent();
  if (load.ok === false) return { status: "error", errorCode: "listing_intent_lookup_failed", httpStatus: 500 };
  const intent = load.intent;
  if (!intent) return { status: "error", errorCode: "no_listing_intent", httpStatus: 404, message: "No listing intent exists for this SKU." };

  const intended = parseIntendedState(intent.intendedState);
  const manifest = parseImageManifest(intent.imageManifest);
  if (!intended || !manifest || !intent.fingerprint) {
    return { status: "reconcile_requires_intended_state", httpStatus: 409, message: "No valid durable intended-state snapshot exists for this SKU; reconcile cannot verify provider state against intent." };
  }

  const res = await evaluateProviderState(
    { discoverOffers: ops.discoverOffers, fetchInventoryItem: ops.fetchInventoryItem },
    { intended, manifest, fingerprint: intent.fingerprint, local: toDurableLocal(intent) },
  );

  if (res.providerFailure) {
    const code = res.providerErrorCode ?? res.decision;
    if (!(await ops.recordStatus(intent.id, "offer_discovery_failed", code))) return { status: "error", errorCode: "intent_persist_failed", context: code, httpStatus: 500 };
    return { status: code, errorCode: code, httpStatus: 502, message: "Could not COMPLETELY verify the eBay state for this SKU." };
  }

  if (res.decision === "reconcile_exact_published" || res.decision === "already_published_exact") {
    const mapped = await ops.upsertMapping({ offerId: res.offerId!, listingId: res.listingId ?? null });
    const verified = await ops.setProviderVerified(intent.id, res.offerId!, res.listingId ?? null);
    if (!mapped || !verified) return { status: "error", errorCode: "reconcile_persist_failed", httpStatus: 500 };
    return { status: "success", reconciled: true, offerId: res.offerId, listingId: res.listingId, httpStatus: 200 };
  }

  if (res.decision === "create_new") return { status: "no_live_offer", httpStatus: 404, message: "eBay confirms no offer exists for this SKU; nothing to reconcile." };

  // Any other decision (inputs changed, identity conflict, duplicate, on hold,
  // requires review, incompatible): record and return without writing a mapping.
  const status = res.decision === "existing_offer_requires_review" ? "requires_review" : "blocked";
  if (!(await ops.recordStatus(intent.id, status, res.decision))) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
  return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, offerIds: res.offerIds, imageEvidence: res.imageEvidence };
}
