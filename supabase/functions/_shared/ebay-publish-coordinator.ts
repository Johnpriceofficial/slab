// The mutation-SAFE publish decision engine. It performs every provider READ
// (getOffers discovery → getInventoryItem) and the COMPLETE state comparison, then
// returns a mutation PLAN — WITHOUT performing any mutation. The real handler
// executes only the returned plan, so a discovery/lookup/comparison failure can
// never occur after a provider mutation. Pure + fully unit-testable via injected
// ops. Both publish and reconcile share this engine.

import { resolveExistingOffers, type IntendedOffer, type ListingIntentState } from "./ebay-listing-core.ts";
import type { OffersDiscovery } from "./ebay-offers.ts";
import type { InventoryItemResult, NormalizedInventoryItem } from "./ebay-inventory-item.ts";

export interface IntendedListing extends IntendedOffer {
  title: string;
  description: string;
  condition: string;
  conditionDescription: string;
  conditionDescriptors: string[];
  aspects: Record<string, unknown>;
  imageCount: number;
  fingerprint: string;
}

export interface PublishOps {
  discoverOffers: (sku: string) => Promise<OffersDiscovery>;
  fetchInventoryItem: (sku: string) => Promise<InventoryItemResult>;
}

export type PublishPlan =
  | { action: "block"; errorCode: string; offerId?: string; listingId?: string }
  | { action: "reconcile_local_only"; offerId: string; listingId: string }
  | { action: "put_create_publish" }
  | { action: "put_resume_publish"; offerId: string };

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return String(v ?? "");
};

export type ImageEvidence = "verified" | "mismatch" | "unverifiable";

/** Compare the provider inventory item against intent. Image identity for an
 *  externally existing item cannot be proven from signed URLs, so it is at best
 *  "unverifiable" (mismatch only when the image COUNT differs). */
export function compareInventoryItem(item: NormalizedInventoryItem, i: IntendedListing): { match: boolean; imageEvidence: ImageEvidence } {
  const match = item.condition.trim() === i.condition.trim()
    && item.conditionDescription.trim() === i.conditionDescription.trim()
    && item.title.trim() === i.title.trim()
    && item.description.trim() === i.description.trim()
    && item.quantity === i.availableQuantity // a missing (null) provider quantity is NOT an exact match
    && canon(item.aspects) === canon(i.aspects)
    && canon(item.conditionDescriptors) === canon([...i.conditionDescriptors].sort());
  const imageEvidence: ImageEvidence = item.imageCount !== i.imageCount ? "mismatch" : "unverifiable";
  return { match, imageEvidence };
}

/**
 * Decide the publish plan. Reads happen here; NO mutation. A block plan carries a
 * stable errorCode. Only put_create_publish / put_resume_publish authorize any
 * provider mutation, and only after complete verification.
 */
export async function planPublish(ops: PublishOps, intended: IntendedListing, _existingIntent: ListingIntentState | null): Promise<PublishPlan> {
  const disc = await ops.discoverOffers(intended.sku);
  if (disc.ok === false) return { action: "block", errorCode: disc.errorCode };

  const offerDec = resolveExistingOffers(disc.offers, intended);
  if (offerDec.action === "duplicate_offer_ambiguity") return { action: "block", errorCode: "duplicate_offer_ambiguity" };
  // An offer exists for the SKU but is incompatible (wrong marketplace/format):
  // never create a second offer alongside it — require operator review.
  if (offerDec.action === "incompatible_offer_exists") return { action: "block", errorCode: "incompatible_offer_exists" };
  if (offerDec.action === "listing_on_hold") return { action: "block", errorCode: "listing_on_hold", offerId: offerDec.offerId };
  if (offerDec.action === "existing_offer_inputs_changed") return { action: "block", errorCode: "existing_offer_inputs_changed", offerId: offerDec.offerId };
  if (offerDec.action === "existing_listing_inputs_changed") return { action: "block", errorCode: "existing_listing_inputs_changed", offerId: offerDec.offerId, listingId: offerDec.listingId };

  // PROVEN zero offers for the SKU after complete valid discovery → create our own.
  if (offerDec.action === "create") return { action: "put_create_publish" };

  // adopt / reconcile_published → the inventory item MUST also be verified.
  const inv = await ops.fetchInventoryItem(intended.sku);
  if (inv.ok === false) return { action: "block", errorCode: inv.errorCode };
  if (inv.present === false) return { action: "block", errorCode: "inventory_item_lookup_failed" }; // an offer implies an item
  const cmp = compareInventoryItem(inv.item, intended);

  if (offerDec.action === "reconcile_published") {
    // Already live: only repair the LOCAL mapping (no provider mutation), and only
    // when the item content matches AND the image evidence is not a mismatch.
    if (!cmp.match || cmp.imageEvidence === "mismatch") return { action: "block", errorCode: "existing_listing_inputs_changed", offerId: offerDec.offerId, listingId: offerDec.listingId };
    if (cmp.imageEvidence !== "verified") return { action: "block", errorCode: "existing_offer_requires_review", offerId: offerDec.offerId, listingId: offerDec.listingId };
    return { action: "reconcile_local_only", offerId: offerDec.offerId, listingId: offerDec.listingId };
  }

  // adopt an UNPUBLISHED offer, which we would then PUBLISH — require an exact
  // content match AND provable image identity (unprovable for an external offer).
  if (!cmp.match) return { action: "block", errorCode: "existing_offer_inputs_changed", offerId: offerDec.offerId };
  if (cmp.imageEvidence === "mismatch") return { action: "block", errorCode: "existing_offer_inputs_changed", offerId: offerDec.offerId };
  if (cmp.imageEvidence !== "verified") return { action: "block", errorCode: "existing_offer_requires_review", offerId: offerDec.offerId };
  return { action: "put_resume_publish", offerId: offerDec.offerId };
}
