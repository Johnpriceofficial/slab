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
