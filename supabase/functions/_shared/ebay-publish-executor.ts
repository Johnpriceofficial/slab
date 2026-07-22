// The REAL publish/reconcile orchestration, extracted behind injected operations
// so the exact code path the Edge handler runs is executable in tests with mocked
// dependencies. Every provider read (getOffers → getInventoryItem) and the full
// comparison happen in the shared state engine BEFORE any mutation, so a block,
// snapshot-verification failure, validation failure, persistence failure, lease
// loss, or provider-read failure can NEVER be followed by a provider mutation.
//
// A stored durable snapshot is CRYPTOGRAPHICALLY VERIFIED (recomputed fingerprint)
// before it is trusted. Every expected single-row write is checked; a fallback /
// recovery write is reported HONESTLY (a distinct *_recovery_unpersisted status
// and a safe api-run diagnostic — never a false claim that a durable recovery
// state was recorded). Final local persistence is ATOMIC (one transactional RPC).

import { evaluateLocalIntent, type LocalIntentRecord } from "./ebay-local-intent.ts";
import { type DurableLocal, type EngineDecision, evaluateProviderState, type ProviderImageEvidence, type VerificationMethod } from "./ebay-provider-state-engine.ts";
import { type ImageManifestV1, type IntendedStateV1, LISTING_FINGERPRINT_VERSION, verifyDurableIntendedSnapshot } from "./ebay-intended-state.ts";
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
  imagesSubmittedAt: string | null;
  verificationMethod: VerificationMethod | null;
  providerImageEvidence: ProviderImageEvidence | null;
  updatedAt: string | null;                 // row version for optimistic-concurrency fencing
}

// Statuses that indicate a live or in-flight listing whose durable snapshot MUST
// verify before we act; anything not here and artifact-free is a replaceable row.
const LIVE_INFLIGHT_STATUSES = new Set(["preparing", "inventory_created", "offer_created", "offer_created_unpersisted", "published", "published_unmapped"]);

export interface PreparingSnapshot {
  intendedState: IntendedStateV1;
  imageManifest: ImageManifestV1;
  fingerprint: string;
  fingerprintVersion: number;
}

export type PersistenceResult =
  | { ok: true }
  | { ok: false; errorCode: "intent_update_failed" | "intent_row_count_mismatch" | "mapping_upsert_failed" | "mapping_row_count_mismatch" | "api_run_persist_failed" | "reconcile_rpc_failed" };

export interface ReconcileLocalArgs {
  intentId: string;
  offerId: string;
  listingId: string | null;
  listingStatus: string;
  askingPriceCents: number;
  fingerprint: string;
  fingerprintVersion: number;
  // Optimistic-concurrency fence (reconcile only): the expected CURRENT intent
  // state read at load time. A concurrent publish that changed any of these makes
  // the reconcile stale → the RPC rejects without writing. null skips the check
  // (the publish path holds the single-flight lease, so it needs no version fence).
  expectedStatus?: string | null;
  expectedOfferId?: string | null;
  expectedListingId?: string | null;
  expectedUpdatedAt?: string | null;
}

export interface PublishExecutorOps {
  loadIntent: () => Promise<{ ok: true; intent: StoredIntent | null } | { ok: false }>;
  writePreparing: (snap: PreparingSnapshot) => Promise<{ ok: true; intentId: string } | { ok: false }>;
  recordStatus: (intentId: string, status: string, lastError: string) => Promise<PersistenceResult>;
  recordOfferCreated: (intentId: string, offerId: string) => Promise<PersistenceResult>;
  // ATOMIC mapping + intent write via the transactional RPC.
  reconcileLocal: (args: ReconcileLocalArgs) => Promise<PersistenceResult>;
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
  assertLease: () => Promise<boolean>;
  putInventoryItem: () => Promise<{ ok: boolean }>;
  createOffer: () => Promise<{ ok: boolean; offerId: string | null }>;
  publishOffer: (offerId: string) => Promise<{ ok: boolean; listingId: string | null }>;
  recordApiRun: (operation: string, status: string, errorCode: string | null) => Promise<PersistenceResult>;
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
  verificationMethod?: string;
  reconciled?: boolean;
  context?: string;
  message?: string;
  diagnosticUnpersisted?: boolean;
}

function toLocalRecord(intent: StoredIntent | null): LocalIntentRecord | null {
  if (!intent) return null;
  return { status: intent.status, fingerprint: intent.fingerprint, fingerprintVersion: intent.fingerprintVersion, offerId: intent.offerId, listingId: intent.listingId };
}

const asCents = (price: string): number => Math.round(Number(price) * 100);

export async function executePublish(ops: PublishExecutorOps, ctx: PublishContext): Promise<ExecResult> {
  try {
    const load = await ops.loadIntent();
    if (load.ok === false) return { status: "error", errorCode: "listing_intent_lookup_failed", httpStatus: 500 };
    const existing = load.intent;

    // 1) CRYPTOGRAPHICALLY verify any stored snapshot BEFORE trusting it. A forged /
    // altered / stale snapshot blocks with NO provider read and NO preparing write.
    // A LIVE or IN-FLIGHT intent (or one carrying an offer/listing artifact) MUST
    // present a VALID snapshot — a missing/invalid snapshot on such a row fails
    // closed (never authorizes create_new). Only a terminal, artifact-free legacy
    // row with no snapshot may be replaced.
    let verifiedManifest: ImageManifestV1 | null = null;
    if (existing) {
      const isLiveish = LIVE_INFLIGHT_STATUSES.has(existing.status) || !!existing.offerId || !!existing.listingId;
      const hasSnapshot = existing.intendedState != null || existing.imageManifest != null;
      if (hasSnapshot || isLiveish) {
        const v = await verifyDurableIntendedSnapshot({ intendedState: existing.intendedState, imageManifest: existing.imageManifest, fingerprint: existing.fingerprint, fingerprintVersion: existing.fingerprintVersion });
        if (v.outcome !== "valid") {
          const code = isLiveish ? "existing_intent_missing_verified_snapshot" : v.outcome;
          return { status: code, errorCode: v.outcome, httpStatus: 409, message: "The existing listing intent has no valid verified snapshot; refusing to act on unverified durable state." };
        }
        verifiedManifest = v.manifest;
      }
      // else: terminal, artifact-free, snapshot-free legacy row → replaceable.
    }

    // 2) Pre-read local-intent gate.
    const gate = evaluateLocalIntent(toLocalRecord(existing), { fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion });
    if (!gate.proceed) {
      if (gate.code === "prior_publish_in_progress") return { status: "offer_created_unpersisted", httpStatus: 409, message: "A prior publish created an eBay offer that was not saved locally. Run reconcile before publishing this SKU again." };
      return { status: gate.code, errorCode: gate.code, httpStatus: 409, offerId: gate.offerId ?? undefined, listingId: gate.listingId ?? undefined };
    }

    // 3) Write `preparing` (with the durable snapshot) ONLY when there is no live
    // artifact to clobber.
    let intentId: string;
    if (gate.writePreparing) {
      const prep = await ops.writePreparing({ intendedState: ctx.intended, imageManifest: ctx.manifest, fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion });
      if (prep.ok === false) return { status: "error", errorCode: "listing_intent_persist_failed", httpStatus: 500 };
      intentId = prep.intentId;
    } else {
      intentId = existing!.id;
    }

    // 4) Read-all-then-decide via the shared engine. Durable local state comes ONLY
    // from the VERIFIED snapshot.
    const local: DurableLocal | null = existing
      ? { status: existing.status, fingerprint: verifiedManifest ? ctx.fingerprint : existing.fingerprint, offerId: existing.offerId, listingId: existing.listingId, manifest: verifiedManifest, imagesSubmittedAt: existing.imagesSubmittedAt, verificationMethod: existing.verificationMethod, providerImageEvidence: existing.providerImageEvidence }
      : null;
    const res = await evaluateProviderState({ discoverOffers: ops.discoverOffers, fetchInventoryItem: ops.fetchInventoryItem }, { intended: ctx.intended, manifest: ctx.manifest, fingerprint: ctx.fingerprint, local });

    // 5) Provider read failure → 502, NO mutation.
    if (res.providerFailure) {
      const code = res.providerErrorCode ?? res.decision;
      const r = await ops.recordStatus(intentId, "blocked", code);
      if (!r.ok) return { status: "error", errorCode: "intent_persist_failed", context: code, httpStatus: 500 };
      return { status: code, errorCode: code, httpStatus: 502 };
    }

    // 6) Comparison / local blocks → 409, NO mutation.
    if (res.decision === "existing_offer_requires_review") {
      const r = await ops.recordStatus(intentId, "requires_review", res.decision);
      if (!r.ok) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
      return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, imageEvidence: res.imageEvidence, verificationMethod: res.verificationMethod };
    }
    const BLOCK_DECISIONS: EngineDecision[] = ["local_intent_inputs_changed", "local_provider_identity_conflict", "existing_offer_inputs_changed", "existing_listing_inputs_changed", "incompatible_offer_exists", "duplicate_offer_ambiguity", "listing_on_hold", "block"];
    if (BLOCK_DECISIONS.includes(res.decision)) {
      const r = await ops.recordStatus(intentId, "blocked", res.decision);
      if (!r.ok) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
      return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, offerIds: res.offerIds, imageEvidence: res.imageEvidence, verificationMethod: res.verificationMethod };
    }

    // 7) LOCAL-ONLY atomic reconcile of an already-published exact listing.
    if (res.decision === "reconcile_exact_published" || res.decision === "already_published_exact") {
      return await finishLocal(ops, { intentId, offerId: res.offerId!, listingId: res.listingId ?? null, askingPriceCents: asCents(ctx.intended.price), fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion, reconciled: true });
    }

    // 8) MUTATION plans — create_new / resume_local_exact. Lease-fenced per step.
    if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409, message: "The publish lease was lost or superseded; aborting before any eBay mutation." };
    const put = await ops.putInventoryItem();
    if (!put.ok) return { status: "error", errorCode: "inventory_put_failed", httpStatus: 502 };
    const invStatus = await ops.recordStatus(intentId, "inventory_created", "inventory_put");
    if (!invStatus.ok) return { status: "error", errorCode: "intent_persist_failed", httpStatus: 500 };

    let offerId = res.offerId ?? "";
    if (res.decision === "create_new") {
      if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409 };
      const created = await ops.createOffer();
      offerId = created.ok ? (created.offerId ?? "") : "";
      if (!offerId) {
        const r = await ops.recordStatus(intentId, "failed", "no_offer_id");
        return r.ok
          ? { status: "error", errorCode: "offer_creation_failed", httpStatus: 502 }
          : { status: "error", errorCode: "recovery_persist_failed", httpStatus: 500, message: "Offer creation failed AND the failure could not be durably recorded." };
      }
      const oc = await ops.recordOfferCreated(intentId, offerId);
      if (!oc.ok) {
        const r = await ops.recordStatus(intentId, "offer_created_unpersisted", `offer_id_persist_failed:${offerId}`);
        return r.ok
          ? { status: "offer_created_unpersisted", offerId, httpStatus: 500, message: "An eBay offer exists but its ID could not be saved. Run reconcile; a retry re-adopts it (no duplicate)." }
          : { status: "offer_created_recovery_unpersisted", offerId, httpStatus: 500, message: "An eBay offer exists but NEITHER its ID NOR the recovery marker could be saved. Run reconcile before retrying." };
      }
    }

    if (!(await ops.assertLease())) return { status: "publish_lease_lost", httpStatus: 409 };
    const published = await ops.publishOffer(offerId);
    if (!published.ok) return { status: "error", errorCode: "publish_failed", httpStatus: 502, offerId };
    return await finishLocal(ops, { intentId, offerId, listingId: published.listingId, askingPriceCents: asCents(ctx.intended.price), fingerprint: ctx.fingerprint, fingerprintVersion: ctx.fingerprintVersion, reconciled: false });
  } finally {
    const rel = await ops.releaseLease();
    if (!rel.released) {
      const diag = await ops.recordApiRun("publish_lease_release", "error", "lease_release_unconfirmed");
      // Post-operation diagnostic; the main result already returned. Do not claim it
      // persisted if it did not — a safe, non-sensitive log is the honest fallback.
      if (!diag.ok) console.warn("[ebay] publish_lease_release diagnostic could not be persisted");
    }
  }
}

// Atomic final local persistence (mapping + intent) via the transactional RPC.
// On failure, record an HONEST recovery status; if THAT also fails, surface it and
// emit a safe api-run diagnostic — never a false durable-recovery claim.
async function finishLocal(ops: PublishExecutorOps, args: { intentId: string; offerId: string; listingId: string | null; askingPriceCents: number; fingerprint: string; fingerprintVersion: number; reconciled: boolean }): Promise<ExecResult> {
  const r = await ops.reconcileLocal({ intentId: args.intentId, offerId: args.offerId, listingId: args.listingId, listingStatus: "published", askingPriceCents: args.askingPriceCents, fingerprint: args.fingerprint, fingerprintVersion: args.fingerprintVersion });
  if (r.ok) return { status: "success", reconciled: args.reconciled || undefined, offerId: args.offerId, listingId: args.listingId, httpStatus: 200 };
  const marker = await ops.recordStatus(args.intentId, "published_unmapped", "local_persist_failed");
  if (marker.ok) {
    return { status: "published_unmapped", offerId: args.offerId, listingId: args.listingId, httpStatus: 500, message: "The listing state is LIVE but the local mapping/intent write failed — run reconcile. The listing was NOT withdrawn." };
  }
  const diag = await ops.recordApiRun("publish", "error", "published_unmapped_persist_failed");
  return { status: "published_recovery_unpersisted", offerId: args.offerId, listingId: args.listingId, httpStatus: 500, diagnosticUnpersisted: !diag.ok, message: "The listing is LIVE but NEITHER the mapping NOR the recovery marker could be saved — run reconcile immediately." };
}

export interface ReconcileOps {
  loadIntent: () => Promise<{ ok: true; intent: StoredIntent | null } | { ok: false }>;
  recordStatus: (intentId: string, status: string, lastError: string) => Promise<PersistenceResult>;
  reconcileLocal: (args: ReconcileLocalArgs) => Promise<PersistenceResult>;
  recordApiRun: (operation: string, status: string, errorCode: string | null) => Promise<PersistenceResult>;
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
}

/**
 * Reconcile through the SAME engine as publish, using the CRYPTOGRAPHICALLY
 * VERIFIED durable snapshot (never request-body values) as the source of truth. A
 * missing/invalid/forged snapshot fails closed BEFORE any provider read. A local
 * mapping is written ONLY for an exact already-published match, atomically.
 */
export async function executeReconcile(ops: ReconcileOps): Promise<ExecResult> {
  const load = await ops.loadIntent();
  if (load.ok === false) return { status: "error", errorCode: "listing_intent_lookup_failed", httpStatus: 500 };
  const intent = load.intent;
  if (!intent) return { status: "error", errorCode: "no_listing_intent", httpStatus: 404, message: "No listing intent exists for this SKU." };

  const v = await verifyDurableIntendedSnapshot({ intendedState: intent.intendedState, imageManifest: intent.imageManifest, fingerprint: intent.fingerprint, fingerprintVersion: intent.fingerprintVersion });
  if (v.outcome !== "valid") {
    return { status: "reconcile_requires_intended_state", errorCode: v.outcome, httpStatus: 409, message: "No VALID durable intended-state snapshot exists for this SKU; reconcile cannot verify provider state against intent." };
  }

  const local: DurableLocal = { status: intent.status, fingerprint: v.fingerprint, offerId: intent.offerId, listingId: intent.listingId, manifest: v.manifest, imagesSubmittedAt: intent.imagesSubmittedAt, verificationMethod: intent.verificationMethod, providerImageEvidence: intent.providerImageEvidence };
  const res = await evaluateProviderState({ discoverOffers: ops.discoverOffers, fetchInventoryItem: ops.fetchInventoryItem }, { intended: v.intended, manifest: v.manifest, fingerprint: v.fingerprint, local });

  if (res.providerFailure) {
    const code = res.providerErrorCode ?? res.decision;
    const r = await ops.recordStatus(intent.id, "offer_discovery_failed", code);
    if (!r.ok) return { status: "error", errorCode: "intent_persist_failed", context: code, httpStatus: 500 };
    return { status: code, errorCode: code, httpStatus: 502, message: "Could not COMPLETELY verify the eBay state for this SKU." };
  }

  if (res.decision === "reconcile_exact_published" || res.decision === "already_published_exact") {
    // Reconcile does NOT hold the publish lease, so it fences optimistically: the
    // RPC verifies the intent still matches the state we READ (status/offer/listing
    // + updated_at). A racing publish that advanced the row makes this reconcile
    // stale → the RPC rejects without changing the intent or mapping.
    const r = await ops.reconcileLocal({ intentId: intent.id, offerId: res.offerId!, listingId: res.listingId ?? null, listingStatus: "published", askingPriceCents: Math.round(Number(v.intended.price) * 100), fingerprint: v.fingerprint, fingerprintVersion: LISTING_FINGERPRINT_VERSION, expectedStatus: intent.status, expectedOfferId: intent.offerId, expectedListingId: intent.listingId, expectedUpdatedAt: intent.updatedAt });
    if (r.ok) return { status: "success", reconciled: true, offerId: res.offerId, listingId: res.listingId, httpStatus: 200 };
    const marker = await ops.recordStatus(intent.id, "published_unmapped", "reconcile_local_persist_failed");
    if (marker.ok) return { status: "published_unmapped", offerId: res.offerId, listingId: res.listingId, httpStatus: 500, message: "eBay has a live listing for this SKU but the atomic local write failed — retry reconcile." };
    const diag = await ops.recordApiRun("reconcile", "error", "published_unmapped_persist_failed");
    return { status: "published_recovery_unpersisted", offerId: res.offerId, listingId: res.listingId, httpStatus: 500, diagnosticUnpersisted: !diag.ok, message: "eBay has a live listing but NEITHER the mapping NOR the recovery marker could be saved." };
  }

  if (res.decision === "create_new") return { status: "no_live_offer", httpStatus: 404, message: "eBay confirms no offer exists for this SKU; nothing to reconcile." };

  const status = res.decision === "existing_offer_requires_review" ? "requires_review" : "blocked";
  const r = await ops.recordStatus(intent.id, status, res.decision);
  if (!r.ok) return { status: "error", errorCode: "intent_persist_failed", context: res.decision, httpStatus: 500 };
  return { status: res.decision, errorCode: res.decision, httpStatus: 409, offerId: res.offerId, listingId: res.listingId, offerIds: res.offerIds, imageEvidence: res.imageEvidence, verificationMethod: res.verificationMethod };
}
