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
  image_count: number;
}

/**
 * A deterministic fingerprint of the exact listing inputs. Stored on the listing
 * intent so a repeat publish can tell "same listing, resume/reconcile" from
 * "inputs changed". Order-stable and side-effect free.
 */
export function listingFingerprint(f: ListingFingerprintFields): string {
  return [
    f.sku, f.title, f.description, f.price_value, f.currency, f.category_id,
    f.merchant_location_key, f.fulfillment_policy_id, f.payment_policy_id,
    f.return_policy_id, f.condition, f.image_count,
  ].map((v) => String(v ?? "")).join("|");
}
