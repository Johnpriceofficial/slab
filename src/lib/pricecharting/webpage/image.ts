/**
 * Reference-artwork extraction. Only the product image on the trusted
 * PriceCharting storage host is accepted; grader logos, set logos, tracking
 * pixels, ads, and marketplace/seller images are rejected. The artwork is
 * REFERENCE only — never proof of the slab's certification, never the user's
 * uploaded photo.
 */

import type { PageArtwork } from "./types";
import type { RawPageExtract } from "./parse";

/** Trusted image origin(s): the PriceCharting product-image bucket, HTTPS only. */
function isTrustedProductImage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname.toLowerCase() !== "storage.googleapis.com") return false;
  // Path must be under the PriceCharting product-image bucket.
  if (!u.pathname.startsWith("/images.pricecharting.com/")) return false;
  // Reject obvious non-artwork assets even if somehow on the bucket.
  if (/\b(logo|sprite|pixel|avatar|ad[_-]|banner)\b/i.test(u.pathname)) return false;
  // Must look like an image file.
  if (!/\.(jpe?g|png|webp)(\?|$)/i.test(u.pathname)) return false;
  return true;
}

export function extractArtwork(extract: RawPageExtract): PageArtwork | null {
  const url = extract.image_url;
  if (!url || !isTrustedProductImage(url)) return null;
  return {
    image_url: url,
    image_source: "pricecharting_public_page_product_image",
    image_confidence: 0.9,
    is_reference_artwork: true,
  };
}
