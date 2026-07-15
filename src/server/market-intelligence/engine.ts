/**
 * Market-intelligence ORCHESTRATOR (pure).
 *
 * Takes the canonical identity, the specimen's target grade tier, and the
 * results from each source adapter, and assembles the read-only market object:
 * verified sales, active listings, generic grade tiers, summary, liquidity,
 * confidence, and provenance. It CLASSIFIES here (the adapters never do), and it
 * keeps asking prices structurally out of realized value.
 *
 * Pure and deterministic — `asOf` is supplied. Bundled for the Edge Function,
 * which supplies the (impure) adapter results from live providers.
 */

import type { CardIdentity } from "@/lib/identity/identity";
import {
  classifyCandidates,
  separateMarket,
  summarizeSales,
  liquidityScore,
  marketConfidence,
  mapGradeToTier,
  GRADE_TIER_LABELS,
  type GradeTier,
  type MarketDataPoint,
  type MarketSummary,
} from "@/lib/market";
import type { AdapterResult } from "@/lib/market/adapters";
import type { SourceProvenance } from "@/lib/market/provenance";
import type { MarketSource } from "@/lib/market/types";
import { assessIdentityCompleteness, type IdentityCompleteness } from "@/lib/identity/completeness";

export interface GradeTierValue {
  tier: GradeTier;
  label: string;
  value_cents: number;
  source: "pricecharting";
}

/**
 * Per-provider state, so a customer can tell "no matching sales exist" apart
 * from "eBay is not configured", "provider failed", or "rate-limited" — instead
 * of an empty panel that reads like zero market activity.
 */
export type SourceStatus =
  | "success"
  | "no_results"
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "provider_error"
  | "network_error";

export interface SourceState {
  source: MarketSource;
  status: SourceStatus;
  query: string;
  retrieved_at: string;
  candidate_count: number;
  exact_count: number;
  /** Whether retrying could succeed (rate limits / transient network/provider). */
  retryable: boolean;
  /** A safe, user-facing message. NEVER a raw provider error or a URL/token. */
  message: string;
}

/** Human label for a source in user-facing messages. */
const SOURCE_LABELS: Record<string, string> = {
  pricecharting: "PriceCharting",
  ebay_active: "eBay active listings",
  ebay_sold: "Connected-seller sales",
  population: "Population data",
  manual: "Operator comps",
};

function sourceLabel(source: MarketSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Map an adapter error code to the user-facing source status. */
function statusFromErrorCode(code: string): SourceStatus {
  switch (code) {
    case "not_configured": return "not_configured";
    case "unauthorized": return "unauthorized";
    case "rate_limited": return "rate_limited";
    case "network_error": return "network_error";
    case "not_found": return "no_results"; // 404 = no data, not a failure
    default: return "provider_error"; // provider_error, parse_error, anything else
  }
}

/**
 * A SAFE, fixed message per status. Deliberately ignores any raw provider error
 * text — a network error message can embed the request URL (and thus a token),
 * so we never echo it. No secrets, no internal URLs, no buyer PII ever reach here.
 */
function safeMessage(source: MarketSource, status: SourceStatus, count: number): string {
  const label = sourceLabel(source);
  switch (status) {
    case "success": return `${count} result${count === 1 ? "" : "s"} from ${label}.`;
    case "no_results": return `No matching results from ${label}.`;
    case "not_configured": return `${label} is not configured.`;
    case "unauthorized": return `${label} authorization failed.`;
    case "rate_limited": return `${label} is rate-limited; try again shortly.`;
    case "network_error": return `Could not reach ${label}.`;
    case "provider_error": return `${label} request failed.`;
  }
}

/** Derive the user-facing per-source state from an adapter result. */
export function deriveSourceState(result: AdapterResult, exactCount: number): SourceState {
  const p = result.provenance;
  if (result.error) {
    const status = statusFromErrorCode(result.error.code);
    return {
      source: result.source,
      status,
      query: p.query,
      retrieved_at: p.retrieved_at,
      candidate_count: 0,
      exact_count: 0,
      retryable: result.error.retryable,
      message: safeMessage(result.source, status, 0),
    };
  }
  const count = result.candidates.length;
  const status: SourceStatus = count === 0 ? "no_results" : "success";
  return {
    source: result.source,
    status,
    query: p.query,
    retrieved_at: p.retrieved_at,
    candidate_count: count,
    exact_count: exactCount,
    retryable: false,
    message: safeMessage(result.source, status, count),
  };
}

export interface MarketIntelligence {
  identity_hash: string;
  /** The specimen's own tier (raw for ungraded cards). */
  grade_tier: GradeTier;
  verified_sales: MarketDataPoint[];
  active_listings: MarketDataPoint[];
  /** Generic PriceCharting tier values (never converted to a grader value). */
  grade_tiers: GradeTierValue[];
  summary: MarketSummary;
  last_sold_cents: number | null;
  median_sold_cents: number | null;
  low_sold_cents: number | null;
  high_sold_cents: number | null;
  /** The lowest active asking price — supply context, NOT a sold figure. */
  lowest_active_cents: number | null;
  liquidity: number;
  confidence: number;
  provenance: SourceProvenance[];
  /** Per-provider state, so failure/degraded is distinguishable from "no sales". */
  sources: SourceState[];
  /** How completely the card is identified — reported, never used to block data. */
  identity_completeness: IdentityCompleteness;
  generated_at: string;
}

/** Assemble the full market-intelligence object from classified adapter results. */
export function buildMarketIntelligence(
  identity: CardIdentity,
  targetTier: GradeTier,
  results: AdapterResult[],
  asOf: string,
): MarketIntelligence {
  const allPoints: MarketDataPoint[] = [];
  const provenance: SourceProvenance[] = [];
  const gradeTiers: GradeTierValue[] = [];
  const sources: SourceState[] = [];

  for (const result of results) {
    if (result.source === "pricecharting") {
      // PriceCharting is an AGGREGATE tier reference, not individual sales — it
      // populates the grade-tier table only and never the verified-sale median.
      for (const c of result.candidates) {
        const tier = mapGradeToTier(c.grader, c.grade, c.grade_label);
        if (typeof c.price_cents === "number" && c.price_cents > 0) {
          // Keep the source's own tier label (e.g. "PSA 10" / "BGS 10" / "CGC 10")
          // so the four distinct grade-10 fields are NOT collapsed into a single
          // generic "Grade 10" row. Never invent a grader the source didn't give.
          gradeTiers.push({ tier, label: c.grade_label ?? GRADE_TIER_LABELS[tier], value_cents: c.price_cents, source: "pricecharting" });
        }
      }
      provenance.push({ ...result.provenance, exact_count: result.candidates.length });
      sources.push(deriveSourceState(result, result.candidates.length));
      continue;
    }
    // eBay (active + sold) and manual comps are individual data points.
    const points = classifyCandidates(identity, targetTier, result.candidates, asOf);
    allPoints.push(...points);
    const exact = points.filter((p) => p.match === "exact").length;
    provenance.push({ ...result.provenance, exact_count: exact });
    sources.push(deriveSourceState(result, exact));
  }

  // Completeness is REPORTED only — a raw card missing helpful fields still
  // returns whatever market data the sources produced; it is never suppressed.
  const identityCompleteness = assessIdentityCompleteness(
    identity as unknown as Record<string, unknown>,
    targetTier === "raw" ? "raw" : "certified",
  );

  const { sales, active } = separateMarket(allPoints);
  const summary = summarizeSales(sales);
  const lowestActive = active.length > 0 ? Math.min(...active.map((p) => p.price_cents)) : null;
  const sourcesWithSales = new Set(sales.map((p) => p.source)).size;

  return {
    identity_hash: identity.hash,
    grade_tier: targetTier,
    verified_sales: sales,
    active_listings: active,
    grade_tiers: gradeTiers,
    summary,
    last_sold_cents: summary.last_sale_cents,
    median_sold_cents: summary.median_cents,
    low_sold_cents: summary.lowest_cents,
    high_sold_cents: summary.highest_cents,
    lowest_active_cents: lowestActive,
    liquidity: liquidityScore(sales, asOf),
    confidence: marketConfidence({ summary, sourceCount: sourcesWithSales, asOf }),
    provenance,
    sources,
    identity_completeness: identityCompleteness,
    generated_at: asOf,
  };
}

// Re-exports the Edge Function bundle needs (identity rebuild + adapters + queries).
export { buildIdentity, type CardIdentity } from "@/lib/identity/identity";
export { priceChartingQuery, ebayExactQuery, ebayCompatibleQuery } from "@/lib/market/query";
export { mapPriceCharting, mapEbayActive, mapEbaySold, mapManualComps } from "@/lib/market/adapters";
export { cacheKey, marketCacheKey, MARKET_QUERY_VERSION } from "@/lib/market/adapters";
export type { MarketCacheDescriptor, MarketCacheScope } from "@/lib/market/adapters";
export { mapGradeToTier } from "@/lib/market";
export { priceChartingCardTiers } from "@/lib/pricecharting/grade-mapping";
export type { PriceChartingCardTier } from "@/lib/pricecharting/grade-mapping";
export { assessIdentityCompleteness } from "@/lib/identity/completeness";
export type { IdentityCompleteness } from "@/lib/identity/completeness";
export { specimenKeyResult } from "@/lib/identity/identity";
export type { AdapterResult } from "@/lib/market/adapters";
export type { GradeTier } from "@/lib/market";
