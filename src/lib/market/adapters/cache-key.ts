/**
 * Deterministic cache-key generation. A key is a stable function of the source,
 * the canonical identity hash, and any query params — so the same request
 * always maps to the same cache slot regardless of param ordering.
 */

import type { MarketSource } from "../types";

export function cacheKey(
  source: MarketSource,
  identityHash: string,
  params: Record<string, string | number | boolean> = {},
): string {
  const encoded = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
  return encoded ? `${source}|${identityHash}|${encoded}` : `${source}|${identityHash}`;
}

/**
 * Schema/mapping version for the whole market-intelligence response. Bump this
 * whenever the response shape or the provider→field mapping changes so stale
 * cache entries from an older shape are never served.
 */
export const MARKET_QUERY_VERSION = 2;

/** Whether a cached market response contains any owner-private evidence. */
export type MarketCacheScope = "public" | "owner-private";

export interface MarketCacheDescriptor {
  identityHash: string;
  /** The target grade tier the response was built for. */
  tier: string;
  /** The set of providers whose data is in the response (order-insensitive). */
  providers: string[];
  scope: MarketCacheScope;
  /** REQUIRED when scope is "owner-private"; omit for public responses. */
  ownerId?: string | null;
  /** Defaults to MARKET_QUERY_VERSION. */
  queryVersion?: number;
}

/**
 * A cache key that fully describes the market-intelligence response it guards.
 *
 * Public evidence (PriceCharting aggregates, public eBay active listings) is
 * shared across users BY IDENTITY — two users looking at the same card get the
 * same cached public response. Owner-private evidence (connected-seller
 * completed orders) must NEVER be shared: an owner-private scope is keyed by the
 * owner's user id as well, and this function THROWS if an owner-private response
 * is built without one — so a future private source cannot silently leak across
 * users through cache reuse.
 */
export function marketCacheKey(d: MarketCacheDescriptor): string {
  if (d.scope === "owner-private" && !(d.ownerId ?? "").trim()) {
    throw new Error(
      "marketCacheKey: owner-private scope requires an ownerId — private seller data must never be shared across users via cache reuse.",
    );
  }
  const providers = [...d.providers].map((p) => p.trim()).filter(Boolean).sort();
  const parts = [
    `v=${d.queryVersion ?? MARKET_QUERY_VERSION}`,
    `scope=${d.scope}`,
    `id=${d.identityHash}`,
    `tier=${d.tier}`,
    `providers=${providers.join(",")}`,
  ];
  if (d.scope === "owner-private") parts.push(`owner=${(d.ownerId ?? "").trim()}`);
  return parts.join("|");
}
