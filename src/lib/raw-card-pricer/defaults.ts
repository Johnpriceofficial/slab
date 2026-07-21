/**
 * Configurable defaults (spec §23). Every threshold here is a business
 * decision, not a derived constant — the application may override any of
 * these, but MUST display the values actually used (spec §9: "Display every
 * assumption and the fee-schedule date").
 */

export const RAW_CARD_PRICER_DEFAULTS = {
  /** Below this raw value, and if grading is unprofitable, the card is bulk. */
  bulkThresholdDollars: 1.0,
  /** Raw value range that defaults to KEEP RAW when grading thresholds aren't met. */
  keepRawRangeDollars: { min: 1.0, max: 19.99 },
  /** Minimum raw value to even consider grading. */
  minRawValueToGradeDollars: 20,
  /** Minimum liquidity-adjusted incremental profit required to recommend GRADE. */
  minLiquidityAdjustedIncrementalProfitDollars: 40,
  /** Minimum grading ROI (%) required to recommend GRADE. */
  minGradingRoiPercent: 50,
  /** Minimum probability of a profitable outcome required to recommend GRADE. */
  minProbabilityOfProfit: 0.7,
  /** Minimum pricing confidence to recommend GRADE (40 is the floor to price at all). */
  minPricingConfidenceToGrade: 70,
  minPricingConfidenceToPriceAtAll: 40,
  /** Minimum condition confidence required to recommend GRADE. */
  minConditionConfidenceToGrade: 70,
  /** Minimum liquidity factor required to recommend GRADE. */
  minLiquidityFactorToGrade: 0.85,
  /** Conservative (P10) downside floor, in dollars (negative = an acceptable loss). */
  conservativeDownsideFloorDollars: -25,
  /** Raw value at/above which the premium exception (bypass ROI/profit gates) may apply. */
  premiumExceptionThresholdDollars: 250,
  /** Expected graded value at/above which MANUAL REVIEW REQUIRED is forced regardless of other gates. */
  highValueManualReviewThresholdDollars: 1000,
  /** Default marketplace selling cost when no channel is specified. */
  defaultSellingFeeRate: 0.12,
  defaultFixedSellingCostsDollars: 5,
  /** Display-only multipliers — NEVER used in grading math (spec §10, §16, §22). */
  quickSaleMultiplier: 0.8,
  replacementValueMultiplier: 1.1,
  /** Annual holding-cost rate used in the opportunity-cost term of total grading cost. */
  holdingCostRatePerYear: 0.12,
  /** Default submission size used to prorate shipping/insurance/membership costs. */
  defaultSubmissionSize: 20,
  minImageResolutionShortEdgePx: 1000,
  centeringMeasurementUncertaintyPoints: 3,
  /** Grader tie-break band: the greater of a flat dollar amount or a percentage of profit. */
  graderTieBreakBandDollars: 10,
  graderTieBreakBandPercent: 0.1,
  repriceIntervalDaysLiquid: 30,
  repriceIntervalDaysLowLiquidity: 60,
  currency: "USD",
} as const;

/** Marketplace selling-fee schedule (spec §10). Rates are fractions, not percentages. */
export const MARKETPLACE_FEE_SCHEDULE = {
  ebay: { rate: 0.1325, fixedDollars: 0 },
  whatnot: { rate: 0.08 + 0.029, fixedDollars: 0.3 },
  tcgplayer: { rate: 0.13, fixedDollars: 0 },
  other: { rate: RAW_CARD_PRICER_DEFAULTS.defaultSellingFeeRate, fixedDollars: RAW_CARD_PRICER_DEFAULTS.defaultFixedSellingCostsDollars },
} as const;

export type MarketplaceChannel = keyof typeof MARKETPLACE_FEE_SCHEDULE;

/** Liquidity tier -> adjustment factor (spec §16), keyed by exact-match sales in the last 90 days. */
export const LIQUIDITY_FACTORS: Record<import("./types").LiquidityTier, number> = {
  very_high: 1.0, // 10+ sales
  high: 0.97, // 5-9 sales
  moderate: 0.92, // 2-4 sales
  low: 0.85, // 1 sale
  very_low: 0.75, // 0 sales
};

/** Classify a 90-day exact-match sales count into a liquidity tier (spec §16). */
export function liquidityTierFromSalesCount(salesLast90Days: number): import("./types").LiquidityTier {
  if (!Number.isFinite(salesLast90Days) || salesLast90Days < 0) {
    throw new Error(`liquidityTierFromSalesCount: expected a non-negative count, got ${salesLast90Days}`);
  }
  if (salesLast90Days >= 10) return "very_high";
  if (salesLast90Days >= 5) return "high";
  if (salesLast90Days >= 2) return "moderate";
  if (salesLast90Days >= 1) return "low";
  return "very_low";
}

/** Look up the liquidity factor directly from a 90-day sales count (spec §16). */
export function liquidityFactorFromSalesCount(salesLast90Days: number): number {
  return LIQUIDITY_FACTORS[liquidityTierFromSalesCount(salesLast90Days)];
}
