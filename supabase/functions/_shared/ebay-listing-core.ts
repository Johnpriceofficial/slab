// Pure, cross-runtime helpers for the eBay listing-publish path: image-path
// ordering/validation and a deterministic listing fingerprint. No Deno/npm/DOM
// imports, so they are unit-tested from src/test/ebay without a live connection.
// The Edge function does the I/O (signed-URL generation, eBay + DB calls); these
// decide WHAT to send and WHETHER inputs are publishable.

const nonEmpty = (p: unknown): p is string => typeof p === "string" && p.trim().length > 0;

// THE canonical marketplace SKU, derived server-side from the slab's immutable
// inventory number: "GCV" + 6-digit zero-pad (e.g. 47 → GCV000047). Must stay
// identical to the frontend src/lib/slabs/marketplace-sku.ts (a test asserts it).
export function canonicalSkuFromInventoryNumber(inventoryNumber: number): string {
  return `GCV${String(inventoryNumber).padStart(6, "0")}`;
}

/** Ordered image paths for a listing: front first, then back; empties dropped. */
export function orderedImagePaths(front: unknown, back: unknown): string[] {
  return [front, back].filter(nonEmpty).map((p) => p.trim());
}

/** eBay requires at least a front image; this is the pre-publish gate. */
export function hasFrontImage(front: unknown): boolean {
  return nonEmpty(front);
}

// The listing fingerprint was replaced by the canonical SHA-256 fingerprint over
// the durable intended state + image manifest — see ebay-intended-state.ts
// (canonicalListingFingerprint, LISTING_FINGERPRINT_VERSION = 3). The old weak
// `v2|JSON.stringify` serialization is gone.

export interface ListingIntentState {
  status: string;
  offer_id: string | null;
  listing_id: string | null;
  fingerprint: string | null;
}

export type PublishAction =
  | { action: "proceed" }                          // no existing intent, or none with an offer → create fresh
  | { action: "resume"; offerId: string }          // same inputs + existing offer → reuse it (no dup)
  | { action: "reconciled_existing" }              // already published with the same inputs
  | { action: "listing_inputs_changed" }           // published, or in-flight offer, but inputs changed
  | { action: "offer_created_unpersisted" };       // a prior offer's id was never saved → must reconcile first

/**
 * Fingerprint-enforced decision for a publish attempt. Ensures a live listing is
 * never silently re-published/changed, a stale offer is never silently reused,
 * and an unpersisted offer blocks retries until reconciled. Pure + fully tested.
 */
// The offer ids eBay already has for a SKU (getOffers response). Pure extractor.
export function extractOfferIds(offersResponse: unknown): string[] {
  const offers = (offersResponse as { offers?: unknown } | null)?.offers;
  if (!Array.isArray(offers)) return [];
  return offers
    .map((o) => String((o as { offerId?: unknown })?.offerId ?? "").trim())
    .filter(Boolean);
}

export interface OfferSummary {
  offerId: string;
  sku: string;
  marketplaceId: string;
  format: string;
  listingId: string | null;
  categoryId: string;
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  price: string;        // normalized to 2dp
  currency: string;
  availableQuantity: number | null;
  listingDescription: string;
  listingOnHold: boolean;
}

const normPrice = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "";
};

// Parse getOffers into typed summaries carrying every field needed to judge
// whether an existing offer MATCHES the intended listing (not just compatibility).
export function extractOfferSummaries(offersResponse: unknown): OfferSummary[] {
  const offers = (offersResponse as { offers?: unknown } | null)?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.map((o) => {
    const r = (o ?? {}) as Record<string, unknown>;
    const listing = r.listing && typeof r.listing === "object" ? r.listing as Record<string, unknown> : {};
    const policies = r.listingPolicies && typeof r.listingPolicies === "object" ? r.listingPolicies as Record<string, unknown> : {};
    const pricing = r.pricingSummary && typeof r.pricingSummary === "object" ? r.pricingSummary as Record<string, unknown> : {};
    const price = pricing.price && typeof pricing.price === "object" ? pricing.price as Record<string, unknown> : {};
    return {
      offerId: String(r.offerId ?? "").trim(),
      sku: String(r.sku ?? "").trim(),
      marketplaceId: String(r.marketplaceId ?? "").trim(),
      format: String(r.format ?? "").trim(),
      listingId: listing.listingId != null ? String(listing.listingId) : null,
      categoryId: String(r.categoryId ?? "").trim(),
      merchantLocationKey: String(r.merchantLocationKey ?? "").trim(),
      fulfillmentPolicyId: String(policies.fulfillmentPolicyId ?? "").trim(),
      paymentPolicyId: String(policies.paymentPolicyId ?? "").trim(),
      returnPolicyId: String(policies.returnPolicyId ?? "").trim(),
      price: normPrice(price.value),
      currency: String(price.currency ?? "").trim(),
      availableQuantity: Number.isFinite(Number(r.availableQuantity)) ? Number(r.availableQuantity) : null,
      listingDescription: String(r.listingDescription ?? ""),
      listingOnHold: listing.listingOnHold === true,
    };
  }).filter((o) => o.offerId);
}

export interface IntendedOffer {
  sku: string;
  marketplaceId: string;
  categoryId: string;
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  price: number;
  currency: string;
  availableQuantity: number;
  listingDescription: string;
}

export type OfferResolution =
  | { action: "create" }                                            // PROVEN zero offers for the SKU
  | { action: "incompatible_offer_exists"; offerIds: string[] }     // offer(s) exist for the SKU but none compatible
  | { action: "adopt"; offerId: string }                            // one compatible+matching, unpublished
  | { action: "existing_offer_inputs_changed"; offerId: string }    // compatible unpublished, inputs differ
  | { action: "reconcile_published"; offerId: string; listingId: string } // compatible+matching, published
  | { action: "existing_listing_inputs_changed"; offerId: string; listingId: string } // published, inputs differ
  | { action: "listing_on_hold"; offerId: string }                  // compatible but on hold
  | { action: "duplicate_offer_ambiguity"; offerIds: string[] };    // >1 compatible

// Do the existing offer's settings MATCH what we intend to publish? Includes the
// offer's listing description (an outdated description is NOT an exact match).
function offerMatchesIntent(o: OfferSummary, i: IntendedOffer): boolean {
  return o.categoryId === i.categoryId
    && o.merchantLocationKey === i.merchantLocationKey
    && o.fulfillmentPolicyId === i.fulfillmentPolicyId
    && o.paymentPolicyId === i.paymentPolicyId
    && o.returnPolicyId === i.returnPolicyId
    && o.price === i.price.toFixed(2)
    && o.currency === i.currency
    && o.availableQuantity === i.availableQuantity
    && o.listingDescription.trim() === i.listingDescription.trim();
}

/**
 * Decide what to do with the offers eBay already has. Compatibility (same SKU +
 * marketplace + FIXED_PRICE) gates adoption; then a full content comparison
 * prevents publishing/adopting a STALE offer whose settings differ from intent.
 * An offer that exists for the SKU but is INCOMPATIBLE (wrong marketplace/format)
 * BLOCKS creation — a new offer must never be created alongside it. Pure.
 */
export function resolveExistingOffers(offers: OfferSummary[], intended: IntendedOffer): OfferResolution {
  const forSku = offers.filter((o) => o.sku === intended.sku);
  const compatible = forSku.filter((o) => o.marketplaceId === intended.marketplaceId && o.format === "FIXED_PRICE");
  if (compatible.length === 0) {
    return forSku.length > 0 ? { action: "incompatible_offer_exists", offerIds: forSku.map((o) => o.offerId) } : { action: "create" };
  }
  if (compatible.length > 1) return { action: "duplicate_offer_ambiguity", offerIds: compatible.map((o) => o.offerId) };
  const one = compatible[0];
  if (one.listingOnHold) return { action: "listing_on_hold", offerId: one.offerId };
  const matches = offerMatchesIntent(one, intended);
  if (one.listingId) {
    return matches ? { action: "reconcile_published", offerId: one.offerId, listingId: one.listingId } : { action: "existing_listing_inputs_changed", offerId: one.offerId, listingId: one.listingId };
  }
  return matches ? { action: "adopt", offerId: one.offerId } : { action: "existing_offer_inputs_changed", offerId: one.offerId };
}

export interface OfferLookup { ok: boolean; offerIds: string[] }
export type OfferCreationDecision =
  | { action: "provider_lookup_failed" }                     // lookup errored → do NOT create
  | { action: "adopt"; offerId: string }                     // exactly one exists → reuse it
  | { action: "duplicate_offer_ambiguity"; offerIds: string[] } // multiple → refuse
  | { action: "create" };                                    // proven none → safe to create

/**
 * Provider-side offer idempotency: decide whether to create a new eBay offer for
 * a SKU based on what eBay ALREADY has. A new offer is created ONLY after a
 * successful lookup proves none exists — so a retry never duplicates an offer,
 * even if every prior local write (offer_id persistence + recovery) failed. Pure.
 */
export function resolveOfferCreation(lookup: OfferLookup): OfferCreationDecision {
  if (!lookup.ok) return { action: "provider_lookup_failed" };
  if (lookup.offerIds.length === 1) return { action: "adopt", offerId: lookup.offerIds[0] };
  if (lookup.offerIds.length > 1) return { action: "duplicate_offer_ambiguity", offerIds: lookup.offerIds };
  return { action: "create" };
}

export function resolvePublishAction(existing: ListingIntentState | null, fingerprint: string): PublishAction {
  if (!existing) return { action: "proceed" };
  const sameInputs = existing.fingerprint === fingerprint;
  if (existing.status === "offer_created_unpersisted") return { action: "offer_created_unpersisted" };
  if (existing.status === "published" && existing.listing_id) {
    return sameInputs ? { action: "reconciled_existing" } : { action: "listing_inputs_changed" };
  }
  if (existing.offer_id) {
    return sameInputs ? { action: "resume", offerId: existing.offer_id } : { action: "listing_inputs_changed" };
  }
  return { action: "proceed" };
}
