/**
 * PriceCharting PUBLIC PRODUCT-PAGE adapter — shared types.
 *
 * A SEPARATE evidence source from the PriceCharting API. It reads the public
 * `/game/<console>/<slug>` product page (server-side only) to recover graded
 * tiers and reference artwork the API omits. It is NEVER labeled as the API, is
 * NEVER a completed-sale, and NEVER uses the slab certification number.
 *
 * Parsing/normalization/verification here are PURE and fixture-tested. The
 * network fetch is injected. The whole source is gated behind a feature flag.
 */

/** Bump when the extraction strategy changes — part of the cache key. */
export const PARSER_VERSION = 1;
/** Bump when the source semantics/shape change — part of the cache key. */
export const SOURCE_VERSION = "pricecharting_public_page.v1";

/** The distinct source label. NEVER "PRICECHARTING_API". */
export const PUBLIC_PAGE_SOURCE = "PRICECHARTING_PUBLIC_PAGE" as const;

/** Identity agreement between the fetched page and the linked product. */
export type PageIdentityStatus = "VERIFIED" | "PARTIAL" | "REJECTED";

/** Every terminal state the adapter can return (typed, never a raw error). */
export type PageAdapterState =
  | "success"
  | "no_exact_tier"
  | "product_mismatch"
  | "parser_outdated"
  | "provider_blocked"
  | "rate_limited"
  | "network_error"
  | "invalid_html"
  | "image_unavailable"
  | "disabled"; // feature flag is off — no fetch was performed

/** One normalized grade tier read from the page. */
export interface PageTierValue {
  /** Canonical tier key (shared vocabulary: raw, cgc_10, cgc_10_pristine, …). */
  tier: string;
  /** The label as displayed on the page, e.g. "CGC 10 Pristine". */
  displayed_label: string;
  /** The price text as displayed, e.g. "$45.39" or "-". Kept for audit. */
  displayed_price_text: string;
  /** Integer cents, or null when the page shows no value ("-"). Never 0-as-null. */
  value_cents: number | null;
}

/** Reference artwork extracted from the confirmed product page. */
export interface PageArtwork {
  image_url: string;
  image_source: string;
  image_confidence: number;
  /** Always true — this is PriceCharting reference artwork, never the slab photo. */
  is_reference_artwork: true;
}

/** Identity fields read from the page, for verification + provenance. */
export interface PageIdentity {
  product_id: string | null;
  title: string | null;
  card_number: string | null;
  set_or_console: string | null;
  language: string | null;
  canonical_url: string | null;
}

/**
 * The full normalized snapshot returned to callers — the CANONICAL market
 * reference for a card, shared by every specimen of that card regardless of
 * certification number. Contains NO raw HTML.
 */
export interface ProductPageSnapshot {
  source: typeof PUBLIC_PAGE_SOURCE;
  /** The market-page provider this snapshot came from (generic across providers). */
  provider_id: "pricecharting";
  state: PageAdapterState;
  product_id: string | null;
  canonical_url: string | null;
  retrieved_at: string;
  /** Provider-shown "last updated" text, when present (null for PriceCharting). */
  last_updated_text: string | null;
  parser_version: number;
  source_version: string;
  identity_status: PageIdentityStatus | null;
  identity: PageIdentity;
  tiers: PageTierValue[];
  artwork: PageArtwork | null;
  /** Safe, user-facing message. NEVER raw HTML, headers, tokens, or stack traces. */
  message: string;
}
