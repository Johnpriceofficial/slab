/**
 * Generic market-page provider interface. The PriceCharting public-page adapter
 * is the FIRST implementation; the same shape (identity-driven canonical URL →
 * fetch → parse → verify → normalized snapshot) is intended to back additional
 * providers (Card Ladder, Alt, Goldin, PWCC) behind one common contract, each
 * verified against the canonical card identity and carrying its own provenance.
 *
 * A provider is NEVER driven by a certification number, grader, submission id,
 * owner, or inventory record — only by the canonical card identity + the catalog
 * product it resolves to.
 */

import type { RawPageExtract } from "./parse";
import type { PageIdentityStatus } from "./types";

export type MarketPageProviderId = "pricecharting" | "card_ladder" | "alt" | "goldin" | "pwcc";

/** Canonical card identity used to drive search + cache — no specimen fields. */
export interface CanonicalCardKey {
  category_or_manufacturer?: string | null; // e.g. "pokemon"
  language?: string | null;
  set?: string | null;
  card_number?: string | null;
  card_name?: string | null;
  variation?: string | null;
}

/** Minimal contract every market-page provider implements. */
export interface MarketPageProvider {
  readonly id: MarketPageProviderId;
  /** Trusted host allowlist for this provider's product pages. */
  readonly hostAllowlist: ReadonlySet<string>;
  /** Validate/normalize a candidate product-page URL for this provider. */
  safeProductUrl(raw: string): URL | null;
  /** Parse provider HTML into the shared raw extract shape. */
  parse(html: string): RawPageExtract;
  /** Decide identity agreement between the page and the linked canonical product. */
  verify(extract: RawPageExtract, expected: { product_id: string; card_number?: string | null; language?: string | null; canonical_url?: string | null }): { status: PageIdentityStatus; reasons: string[] };
}
