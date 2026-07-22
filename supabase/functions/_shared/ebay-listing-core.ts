// Pure, cross-runtime helpers for the eBay listing-publish path: image-path
// ordering/validation and a deterministic listing fingerprint. No Deno/npm/DOM
// imports, so they are unit-tested from src/test/ebay without a live connection.
// The Edge function does the I/O (signed-URL generation, eBay + DB calls); these
// decide WHAT to send and WHETHER inputs are publishable.

const nonEmpty = (p: unknown): p is string => typeof p === "string" && p.trim().length > 0;

/** Ordered image paths for a listing: front first, then back; empties dropped. */
export function orderedImagePaths(front: unknown, back: unknown): string[] {
  return [front, back].filter(nonEmpty).map((p) => p.trim());
}

/** eBay requires at least a front image; this is the pre-publish gate. */
export function hasFrontImage(front: unknown): boolean {
  return nonEmpty(front);
}

export interface ListingFingerprintFields {
  sku: string;
  title: string;
  description: string;
  price_value: number;
  currency: string;
  category_id: string;
  merchant_location_key: string;
  fulfillment_policy_id: string;
  payment_policy_id: string;
  return_policy_id: string;
  condition: string;
  condition_description?: string;
  quantity?: number;
  front_image_path?: string | null;
  back_image_path?: string | null;
  aspects?: Record<string, unknown>;
}

export const LISTING_FINGERPRINT_VERSION = 2;

// Stable, key-sorted canonicalization so aspect key order never changes the hash.
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * A deterministic, VERSIONED fingerprint of the EXACT listing inputs — including
 * aspects (canonicalized), quantity, condition description, and the actual image
 * paths — so any change (e.g. swapping the front image while keeping one image)
 * produces a different fingerprint. Stored on the intent to distinguish
 * "same listing, resume/reconcile" from "inputs changed". Pure + order-stable.
 */
export function listingFingerprint(f: ListingFingerprintFields): string {
  const canonical = {
    sku: f.sku ?? "",
    title: f.title ?? "",
    description: f.description ?? "",
    price: f.price_value ?? 0,
    currency: f.currency ?? "",
    category: f.category_id ?? "",
    location: f.merchant_location_key ?? "",
    fulfillment: f.fulfillment_policy_id ?? "",
    payment: f.payment_policy_id ?? "",
    return: f.return_policy_id ?? "",
    condition: f.condition ?? "",
    condition_description: f.condition_description ?? "",
    quantity: f.quantity ?? 1,
    front_image: f.front_image_path ?? "",
    back_image: f.back_image_path ?? "",
    aspects: canonicalize(f.aspects ?? {}),
  };
  return `v${LISTING_FINGERPRINT_VERSION}|${JSON.stringify(canonical)}`;
}

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
