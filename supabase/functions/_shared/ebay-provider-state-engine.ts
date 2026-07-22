// THE single, shared, mutation-SAFE decision engine used by BOTH publish and
// reconcile. It performs every provider READ (getOffers discovery →
// getInventoryItem) and the COMPLETE comparison — durable local intent vs every
// provider offer vs the provider inventory item vs the stable local image
// manifest + local/provider identity — then returns a DECISION. It never mutates.
// Only `create_new`, `resume_local_exact`, `adopt_exact_unpublished` authorize a
// provider mutation; `reconcile_exact_published` / `already_published_exact`
// authorize a LOCAL-ONLY mapping write; every other decision is a block.
//
// Pure (reads via injected ops) + fully unit-testable with mocked ops.

import { resolveExistingOffers, type IntendedOffer } from "./ebay-listing-core.ts";
import type { OffersDiscovery } from "./ebay-offers.ts";
import type { InventoryItemResult, NormalizedInventoryItem } from "./ebay-inventory-item.ts";
import type { ImageManifestV1, IntendedStateV1 } from "./ebay-intended-state.ts";

export type ImageEvidence = "verified" | "mismatch" | "unverifiable";

export type EngineDecision =
  // action-authorizing
  | "create_new" | "resume_local_exact" | "adopt_exact_unpublished"
  | "reconcile_exact_published" | "already_published_exact"
  // blocks (local/comparison)
  | "local_intent_inputs_changed" | "local_provider_identity_conflict"
  | "existing_offer_inputs_changed" | "existing_listing_inputs_changed"
  | "incompatible_offer_exists" | "duplicate_offer_ambiguity"
  | "listing_on_hold" | "existing_offer_requires_review"
  // blocks (provider read failure)
  | "provider_lookup_failed" | "inventory_item_lookup_failed"
  | "invalid_provider_response" | "provider_redirect_rejected" | "provider_timeout"
  | "invalid_intended_state" | "block";

export interface EngineResult {
  decision: EngineDecision;
  providerFailure: boolean;          // a provider READ failed → executor returns 502 and NEVER mutates
  providerErrorCode?: string;        // the exact discovery/lookup code (may be finer than `decision`)
  offerId?: string;
  listingId?: string;
  offerIds?: string[];
  imageEvidence?: ImageEvidence;
}

export interface DurableLocal {
  status: string;
  fingerprint: string | null;
  offerId: string | null;
  listingId: string | null;
  manifest: ImageManifestV1 | null;
  providerVerified: boolean;         // provider_verified_at is set → a persisted record ties images to this provider item
}

export interface EngineContext {
  intended: IntendedStateV1;
  manifest: ImageManifestV1;
  fingerprint: string;               // current canonical SHA-256 fingerprint
  local: DurableLocal | null;
}

export interface EngineReadOps {
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
}

const READ_FAILURE_VOCAB = new Set<EngineDecision>(["provider_lookup_failed", "inventory_item_lookup_failed", "invalid_provider_response", "provider_redirect_rejected", "provider_timeout"]);

function readFailure(code: string): EngineResult {
  const decision = (READ_FAILURE_VOCAB.has(code as EngineDecision) ? code : "provider_lookup_failed") as EngineDecision;
  return { decision, providerFailure: true, providerErrorCode: code };
}

function intendedOfferOf(i: IntendedStateV1): IntendedOffer {
  return {
    sku: i.sku, marketplaceId: i.marketplaceId, categoryId: i.categoryId,
    merchantLocationKey: i.merchantLocationKey, fulfillmentPolicyId: i.fulfillmentPolicyId,
    paymentPolicyId: i.paymentPolicyId, returnPolicyId: i.returnPolicyId,
    price: Number(i.price), currency: i.currency, availableQuantity: i.availableQuantity,
    listingDescription: i.listingDescription,
  };
}

const eqStrArr = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, idx) => v === b[idx]);
function eqAspects(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (!eqStrArr(ka, kb)) return false;
  return ka.every((k) => eqStrArr([...a[k]].sort(), [...b[k]].sort()));
}

/** Does the provider inventory item's CONTENT exactly match the intended state?
 *  A missing (null) provider quantity is NOT an exact match. */
export function compareInventoryContent(item: NormalizedInventoryItem, i: IntendedStateV1): boolean {
  return item.condition.trim() === i.condition.trim()
    && item.conditionDescription.trim() === i.conditionDescription.trim()
    && item.title.trim() === i.title.trim()
    && item.description.trim() === i.description.trim()
    && item.quantity === i.availableQuantity
    && eqAspects(item.aspects, i.aspects)
    && eqStrArr([...item.conditionDescriptors].sort(), [...i.conditionDescriptors].sort());
}

function sameManifest(a: ImageManifestV1, b: ImageManifestV1): boolean {
  if (a.count !== b.count || a.images.length !== b.images.length) return false;
  return a.images.every((img, idx) => img.role === b.images[idx].role && img.path === b.images[idx].path && img.sha256 === b.images[idx].sha256);
}

/**
 * Stable image evidence. Images are NEVER compared via temporary signed URLs or by
 * provider image count alone. A provider offer/item is `verified` ONLY when the
 * durable local record links: the exact current fingerprint, the exact image
 * manifest (unchanged roles/paths/SHA-256 hashes), the exact provider offer/listing
 * identity, and a persisted provider-verification record. Otherwise:
 *   - a changed hash / role-path pairing / count  → `mismatch`
 *   - missing durable evidence / external offer    → `unverifiable`
 */
export function evaluateImageEvidence(
  ctx: EngineContext,
  providerImageCount: number,
  providerOfferId: string,
  providerListingId: string | null,
): ImageEvidence {
  const local = ctx.local;
  // No durable evidence tying our images to a provider artifact → cannot verify.
  if (!local || !local.fingerprint || !local.manifest || !local.offerId) return "unverifiable";
  // Provider item's image count must match what we intend.
  if (providerImageCount !== ctx.manifest.count) return "mismatch";
  // The durable manifest must equal the current manifest (roles, paths, hashes).
  if (!sameManifest(local.manifest, ctx.manifest)) return "mismatch";
  // Provider identity must match our durable record, and a persisted verification
  // record must exist — otherwise the images cannot be proven to be ours.
  const identityMatches = local.offerId === providerOfferId && (providerListingId ? local.listingId === providerListingId : true);
  if (!identityMatches || !local.providerVerified) return "unverifiable";
  // Nothing about the listing inputs or images changed since we recorded it.
  if (local.fingerprint !== ctx.fingerprint) return "mismatch";
  return "verified";
}

/**
 * Evaluate the complete provider + local state and return a single decision.
 * Reads getOffers first; fetches the inventory item ONLY when an offer already
 * exists (create/empty needs no second read). NO mutation ever happens here.
 */
export async function evaluateProviderState(ops: EngineReadOps, ctx: EngineContext): Promise<EngineResult> {
  const intended = ctx.intended;
  const disc = await ops.discoverOffers(intended.sku);
  if (disc.ok === false) return readFailure(disc.errorCode);

  const offerDec = resolveExistingOffers(disc.offers, intendedOfferOf(intended));

  if (offerDec.action === "duplicate_offer_ambiguity") return { decision: "duplicate_offer_ambiguity", providerFailure: false, offerIds: offerDec.offerIds };
  if (offerDec.action === "incompatible_offer_exists") return { decision: "incompatible_offer_exists", providerFailure: false, offerIds: offerDec.offerIds };
  if (offerDec.action === "listing_on_hold") return { decision: "listing_on_hold", providerFailure: false, offerId: offerDec.offerId };
  if (offerDec.action === "existing_offer_inputs_changed") return { decision: "existing_offer_inputs_changed", providerFailure: false, offerId: offerDec.offerId };
  if (offerDec.action === "existing_listing_inputs_changed") return { decision: "existing_listing_inputs_changed", providerFailure: false, offerId: offerDec.offerId, listingId: offerDec.listingId };

  // PROVEN zero offers for the SKU. If we locally recorded a provider artifact,
  // the provider disagrees → identity conflict (never silently create a duplicate
  // or discard the recorded artifact).
  if (offerDec.action === "create") {
    if (ctx.local && (ctx.local.offerId || ctx.local.listingId)) return { decision: "local_provider_identity_conflict", providerFailure: false, offerId: ctx.local.offerId ?? undefined, listingId: ctx.local.listingId ?? undefined };
    return { decision: "create_new", providerFailure: false };
  }

  // adopt / reconcile_published → the inventory item MUST also be verified.
  const inv = await ops.fetchInventoryItem(intended.sku);
  if (inv.ok === false) return readFailure(inv.errorCode);
  if (inv.present === false) return { decision: "inventory_item_lookup_failed", providerFailure: true, providerErrorCode: "inventory_item_missing_for_offer" };

  const contentMatch = compareInventoryContent(inv.item, intended);
  const providerOfferId = offerDec.offerId;
  const providerListingId = offerDec.action === "reconcile_published" ? offerDec.listingId : null;
  const img = evaluateImageEvidence(ctx, inv.item.imageCount, providerOfferId, providerListingId);

  if (offerDec.action === "reconcile_published") {
    if (!contentMatch || img === "mismatch") return { decision: "existing_listing_inputs_changed", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img };
    if (img !== "verified") return { decision: "existing_offer_requires_review", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img };
    // Verified + identity proven. Local mapping repair only (no provider mutation).
    if (ctx.local?.status === "published" && ctx.local.offerId === providerOfferId && ctx.local.listingId === offerDec.listingId) {
      return { decision: "already_published_exact", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img };
    }
    return { decision: "reconcile_exact_published", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img };
  }

  // adopt: a compatible UNPUBLISHED offer whose content matches. Publishing it
  // requires provable image identity — unprovable for an external offer.
  if (!contentMatch || img === "mismatch") return { decision: "existing_offer_inputs_changed", providerFailure: false, offerId: providerOfferId, imageEvidence: img };
  if (img !== "verified") return { decision: "existing_offer_requires_review", providerFailure: false, offerId: providerOfferId, imageEvidence: img };
  // Verified: if this is our own recorded offer → resume; else adopt.
  if (ctx.local?.offerId && ctx.local.offerId !== providerOfferId) return { decision: "local_provider_identity_conflict", providerFailure: false, offerId: ctx.local.offerId };
  const decision: EngineDecision = ctx.local?.offerId === providerOfferId ? "resume_local_exact" : "adopt_exact_unpublished";
  return { decision, providerFailure: false, offerId: providerOfferId, imageEvidence: img };
}
