/**
 * Per-source rate limiting — a deterministic minimum-interval gate. Given the
 * last request time and a minimum spacing, it computes how long to wait before
 * the next request. Pure: `now` is supplied, never read from the clock.
 */

import type { MarketSource } from "../types";

/** Conservative default spacing per source (ms between requests). */
export const DEFAULT_MIN_INTERVAL_MS: Record<MarketSource, number> = {
  pricecharting: 1000,
  ebay_active: 500,
  ebay_sold: 500,
  population: 1000,
  manual: 0,
};

export interface RateLimitState {
  last_request_at: string | null;
  min_interval_ms: number;
}

/** Milliseconds to wait before the next request is permitted (0 = go now). */
export function throttleDelayMs(state: RateLimitState, now: string): number {
  if (!state.last_request_at || state.min_interval_ms <= 0) return 0;
  const elapsed = new Date(now).getTime() - new Date(state.last_request_at).getTime();
  return Math.max(0, state.min_interval_ms - elapsed);
}

/** True when a request may be made right now without violating the spacing. */
export function isAllowed(state: RateLimitState, now: string): boolean {
  return throttleDelayMs(state, now) === 0;
}

/** Advance the state after a request is made at `now`. */
export function recordRequest(state: RateLimitState, now: string): RateLimitState {
  return { ...state, last_request_at: now };
}
