/**
 * Liquidity and market-confidence scores. Both are pure and take an explicit
 * `asOf` timestamp — no wall-clock reads — so they are deterministic and testable.
 */

import type { MarketDataPoint, MarketSummary } from "./types";

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Liquidity — how readily this card sells — from verified-sale velocity within a
 * window, with a recency bonus. 0 (illiquid) … 1 (very liquid). A card that sold
 * many times recently scores high; one with a single stale sale scores low.
 */
export function liquidityScore(
  sales: MarketDataPoint[],
  asOf: string,
  windowDays = 90,
): number {
  const verified = sales.filter((p) => p.kind === "sale" && p.match === "exact");
  const inWindow = verified.filter((p) => daysBetween(p.sold_at ?? p.observed_at, asOf) <= windowDays);
  if (inWindow.length === 0) return 0;

  // Velocity: sales per 30 days over the window, saturating at ~8/mo -> 1.0.
  const perMonth = (inWindow.length / windowDays) * 30;
  const velocity = clamp01(perMonth / 8);

  // Recency: the most recent sale within the window, decaying to 0 at windowDays.
  const mostRecent = Math.min(...inWindow.map((p) => daysBetween(p.sold_at ?? p.observed_at, asOf)));
  const recency = clamp01(1 - mostRecent / windowDays);

  return clamp01(0.7 * velocity + 0.3 * recency);
}

/**
 * Market confidence — how much to trust the summarized value — from sample size,
 * how many independent sources contributed, price dispersion, and recency.
 * 0 (thin/noisy) … 1 (strong).
 */
export function marketConfidence(input: {
  summary: MarketSummary;
  sourceCount: number;
  asOf: string;
}): number {
  const { summary, sourceCount } = input;
  if (summary.count === 0 || summary.median_cents === null) return 0;

  // Sample size: saturates around 12 sales.
  const sample = clamp01(summary.count / 12);
  // Source diversity: 1 source is fine, 3+ is strong.
  const diversity = clamp01(sourceCount / 3);
  // Dispersion: tight high↔low spread relative to the median is more trustworthy.
  const spread = summary.highest_cents !== null && summary.lowest_cents !== null
    ? (summary.highest_cents - summary.lowest_cents) / Math.max(1, summary.median_cents)
    : 1;
  const tightness = clamp01(1 - spread / 2); // spread >= 2x median -> 0

  return clamp01(0.5 * sample + 0.2 * diversity + 0.3 * tightness);
}
