// THE single, shared, mutation-SAFE decision engine used by BOTH publish and
// reconcile. It performs every provider READ (getOffers discovery →
// getInventoryItem) and the COMPLETE comparison — durable local intent vs every
// provider offer vs the provider inventory item vs the stable local image
// manifest + local/provider identity — then returns a DECISION. It never mutates.
//
// HONEST image evidence: the current eBay Inventory API returns OPAQUE image URLs,
// NOT content hashes, so we can NEVER cryptographically prove the provider holds
// the same image BYTES. `verified` is therefore reserved for a future stable
// content-hash/reference method and is not produced from image count, matching
// local IDs, or a submitted-at timestamp. Our OWN listing is acted on by
// provider-reference match (the provider offer/listing id we recorded); any
// external/legacy listing whose image identity we cannot establish resolves to
// `existing_offer_requires_review`.

import { resolveExistingOffers, type IntendedOffer } from "./ebay-listing-core.ts";
import type { OffersDiscovery } from "./ebay-offers.ts";
import type { InventoryItemResult, NormalizedInventoryItem } from "./ebay-inventory-item.ts";
import type { ImageManifestV1, IntendedStateV1 } from "./ebay-intended-state.ts";

export type ImageEvidence = "verified" | "mismatch" | "unverifiable";
export type VerificationMethod =
  | "submitted_only"            // we submitted these images for this new listing (no provider-side proof)
  | "provider_reference_match"  // the provider offer/listing id matches the one we recorded (our own listing)
  | "provider_content_hash_match" // provider returned a content hash equal to ours (future; unavailable today)
  | "manual_review"
  | "unverifiable";             // no stable provider-side evidence

export type EngineDecision =
  | "create_new" | "resume_local_exact" | "adopt_exact_unpublished"
  | "reconcile_exact_published" | "already_published_exact"
  | "local_intent_inputs_changed" | "local_provider_identity_conflict"
  | "existing_offer_inputs_changed" | "existing_listing_inputs_changed"
  | "incompatible_offer_exists" | "duplicate_offer_ambiguity"
  | "listing_on_hold" | "existing_offer_requires_review"
  | "provider_lookup_failed" | "inventory_item_lookup_failed"
  | "invalid_provider_response" | "provider_redirect_rejected" | "provider_timeout"
  | "invalid_intended_state" | "block";

export interface EngineResult {
  decision: EngineDecision;
  providerFailure: boolean;
  providerErrorCode?: string;
  offerId?: string;
  listingId?: string;
  offerIds?: string[];
  imageEvidence?: ImageEvidence;
  verificationMethod?: VerificationMethod;
}

export interface DurableLocal {
  status: string;
  fingerprint: string | null;
  offerId: string | null;
  listingId: string | null;
  manifest: ImageManifestV1 | null;
  imagesSubmittedAt: string | null;      // when we submitted these images for the offer (was provider_verified_at)
  verificationMethod: VerificationMethod | null;
}

export interface EngineContext {
  intended: IntendedStateV1;
  manifest: ImageManifestV1;
  fingerprint: string;
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

export function compareInventoryContent(item: NormalizedInventoryItem, i: IntendedStateV1): boolean {
  return item.condition.trim() === i.condition.trim()
    && item.conditionDescription.trim() === i.conditionDescription.trim()
    && item.title.trim() === i.title.trim()
    && item.description.trim() === i.description.trim()
    && item.quantity === i.availableQuantity            // null provider quantity is NOT a match
    && eqAspects(item.aspects, i.aspects)
    && eqStrArr([...item.conditionDescriptors].sort(), [...i.conditionDescriptors].sort());
}

function sameManifest(a: ImageManifestV1, b: ImageManifestV1): boolean {
  if (a.count !== b.count || a.images.length !== b.images.length) return false;
  return a.images.every((img, idx) => img.role === b.images[idx].role && img.path === b.images[idx].path && img.sha256 === b.images[idx].sha256);
}

/**
 * HONEST image evidence. `verified` is NEVER produced from image count, matching
 * local offer/listing ids, or a submitted-at timestamp — the current eBay API
 * exposes no stable image identity. Signed/opaque provider URLs are never used.
 *   - provider count ≠ our manifest count, or our local manifest/fingerprint
 *     changed → `mismatch`;
 *   - our recorded provider offer/listing identity matches AND our manifest is
 *     unchanged → `unverifiable` with method `provider_reference_match` (it is OUR
 *     listing; we still cannot prove the provider's current image bytes);
 *   - otherwise → `unverifiable` with method `unverifiable` (external/legacy).
 */
export function evaluateImageEvidence(
  ctx: EngineContext,
  providerImageCount: number,
  providerOfferId: string,
  providerListingId: string | null,
): { evidence: ImageEvidence; method: VerificationMethod } {
  const local = ctx.local;
  if (!local || !local.fingerprint || !local.manifest || !local.offerId) return { evidence: "unverifiable", method: "unverifiable" };
  if (providerImageCount !== ctx.manifest.count) return { evidence: "mismatch", method: "unverifiable" };
  if (!sameManifest(local.manifest, ctx.manifest)) return { evidence: "mismatch", method: "unverifiable" };
  const identityMatches = local.offerId === providerOfferId && (providerListingId ? local.listingId === providerListingId : true);
  if (!identityMatches) return { evidence: "unverifiable", method: "unverifiable" };
  if (local.fingerprint !== ctx.fingerprint) return { evidence: "mismatch", method: "unverifiable" };
  // Our listing, our unchanged images — but no provider content proof exists.
  return { evidence: "unverifiable", method: "provider_reference_match" };
}

// Only a provider-reference/content match on OUR OWN recorded listing authorizes
// an automated reconcile/resume. `verified` (content-hash) is reserved for future
// stable provider evidence; today it is never produced.
const isOurListing = (m: VerificationMethod): boolean => m === "provider_reference_match" || m === "provider_content_hash_match";

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

  if (offerDec.action === "create") {
    if (ctx.local && (ctx.local.offerId || ctx.local.listingId)) return { decision: "local_provider_identity_conflict", providerFailure: false, offerId: ctx.local.offerId ?? undefined, listingId: ctx.local.listingId ?? undefined };
    return { decision: "create_new", providerFailure: false, verificationMethod: "submitted_only" };
  }

  // adopt / reconcile_published → the inventory item MUST also be verified.
  const inv = await ops.fetchInventoryItem(intended.sku);
  if (inv.ok === false) return readFailure(inv.errorCode);
  if (inv.present === false) return { decision: "inventory_item_lookup_failed", providerFailure: true, providerErrorCode: "inventory_item_missing_for_offer" };

  const providerOfferId = offerDec.offerId;
  const providerListingId = offerDec.action === "reconcile_published" ? offerDec.listingId : null;

  // A recorded local identity that disagrees with the provider's is a conflict.
  if (ctx.local?.offerId && ctx.local.offerId !== providerOfferId) return { decision: "local_provider_identity_conflict", providerFailure: false, offerId: ctx.local.offerId };
  if (ctx.local?.listingId && providerListingId && ctx.local.listingId !== providerListingId) return { decision: "local_provider_identity_conflict", providerFailure: false, offerId: providerOfferId, listingId: ctx.local.listingId };

  const contentMatch = compareInventoryContent(inv.item, intended);
  const img = evaluateImageEvidence(ctx, inv.item.imageCount, providerOfferId, providerListingId);

  if (offerDec.action === "reconcile_published") {
    if (!contentMatch || img.evidence === "mismatch") return { decision: "existing_listing_inputs_changed", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img.evidence, verificationMethod: img.method };
    if (!isOurListing(img.method)) return { decision: "existing_offer_requires_review", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img.evidence, verificationMethod: img.method };
    if (ctx.local?.status === "published" && ctx.local.offerId === providerOfferId && ctx.local.listingId === offerDec.listingId) {
      return { decision: "already_published_exact", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img.evidence, verificationMethod: img.method };
    }
    return { decision: "reconcile_exact_published", providerFailure: false, offerId: providerOfferId, listingId: offerDec.listingId, imageEvidence: img.evidence, verificationMethod: img.method };
  }

  // adopt an UNPUBLISHED offer → publish it. Only OUR OWN recorded offer may be
  // resumed; an external offer we cannot identify requires review.
  if (!contentMatch || img.evidence === "mismatch") return { decision: "existing_offer_inputs_changed", providerFailure: false, offerId: providerOfferId, imageEvidence: img.evidence, verificationMethod: img.method };
  if (!isOurListing(img.method)) return { decision: "existing_offer_requires_review", providerFailure: false, offerId: providerOfferId, imageEvidence: img.evidence, verificationMethod: img.method };
  return { decision: "resume_local_exact", providerFailure: false, offerId: providerOfferId, imageEvidence: img.evidence, verificationMethod: img.method };
}
