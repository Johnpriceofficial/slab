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

export interface GradeTierValue {
  tier: GradeTier;
  label: string;
  value_cents: number;
  source: "pricecharting";
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

  for (const result of results) {
    if (result.source === "pricecharting") {
      // PriceCharting is an AGGREGATE tier reference, not individual sales — it
      // populates the grade-tier table only and never the verified-sale median.
      for (const c of result.candidates) {
        const tier = mapGradeToTier(c.grader, c.grade, c.grade_label);
        if (typeof c.price_cents === "number" && c.price_cents > 0) {
          gradeTiers.push({ tier, label: GRADE_TIER_LABELS[tier], value_cents: c.price_cents, source: "pricecharting" });
        }
      }
      provenance.push({ ...result.provenance, exact_count: result.candidates.length });
      continue;
    }
    // eBay (active + sold) and manual comps are individual data points.
    const points = classifyCandidates(identity, targetTier, result.candidates, asOf);
    allPoints.push(...points);
    const exact = points.filter((p) => p.match === "exact").length;
    provenance.push({ ...result.provenance, exact_count: exact });
  }

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
    generated_at: asOf,
  };
}

// Re-exports the Edge Function bundle needs (identity rebuild + adapters + queries).
export { buildIdentity, type CardIdentity } from "@/lib/identity/identity";
export { priceChartingQuery, ebayExactQuery, ebayCompatibleQuery } from "@/lib/market/query";
export { mapPriceCharting, mapEbayActive, mapEbaySold, mapManualComps } from "@/lib/market/adapters";
export { cacheKey } from "@/lib/market/adapters";
export { mapGradeToTier } from "@/lib/market";
export type { AdapterResult } from "@/lib/market/adapters";
export type { GradeTier } from "@/lib/market";
