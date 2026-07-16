/**
 * Cache descriptor for public-page snapshots. Keyed so that EQUIVALENT specimens
 * share ONE market snapshot (never fetched once per slab), and so a parser/source
 * change invalidates old entries. The certification number is NEVER part of the
 * key — two slabs of the same card share the same page snapshot.
 */

import { PARSER_VERSION, SOURCE_VERSION } from "./types";

export const CACHE_TTL_SUCCESS_MS = 24 * 60 * 60 * 1000; // 24h for a good snapshot
export const CACHE_TTL_ARTWORK_MS = 24 * 60 * 60 * 1000; // artwork URL — 24h+
export const CACHE_TTL_NEGATIVE_MS = 5 * 60 * 1000; // blocked / rate-limited / parse-fail — short

export interface PageCacheDescriptor {
  product_id: string;
  canonical_url: string;
  parser_version?: number;
  source_version?: string;
}

/**
 * Deterministic cache key. Includes product id, canonical url, parser version and
 * source version — and DELIBERATELY nothing specimen-specific. A certification
 * number passed here would be ignored, but callers must never pass one.
 */
export function pageCacheKey(d: PageCacheDescriptor): string {
  const parser = d.parser_version ?? PARSER_VERSION;
  const source = d.source_version ?? SOURCE_VERSION;
  return [`v=${parser}`, `src=${source}`, `id=${d.product_id}`, `url=${d.canonical_url}`].join("|");
}

/** Whether a cached entry is still fresh for the given TTL. */
export function isCacheFresh(storedAtMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - storedAtMs < ttlMs;
}
