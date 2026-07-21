/**
 * Types for the Raw Card Pricer, Centering Analyzer, Grader, and Submission
 * Decision Engine (v2 spec). All money is integer pennies (see
 * `@/lib/pricecharting/money`) — never binary floats — matching the rest of
 * this codebase's financial-arithmetic convention.
 */
import type { Pennies } from "@/lib/pricecharting/money";

/** The six terminal outcomes the engine may return (spec §0 / §18). */
export type RawCardDecision =
  | "TRASH_BULK"
  | "KEEP_RAW"
  | "SELL_RAW"
  | "GRADE"
  | "MANUAL_REVIEW_REQUIRED"
  | "ADDITIONAL_PHOTOS_REQUIRED";

/** Supported grading companies (spec §6/§8). */
export type GraderCompany = "PSA" | "CGC" | "BGS" | "SGC";

/**
 * A grade probability distribution for one grading company. Keys are
 * grader-defined grade labels (e.g. "10", "9", "Rejected"); values are
 * probabilities in [0, 1]. A well-formed distribution sums to 1 (spec §6:
 * "All probabilities, including rejection, must total 100%").
 */
export type GradeProbability = Record<string, number>;

/** Market value in pennies for a grade, or `null` if unpriced (never fabricated — spec §2). */
export type PriceByGrade = Record<string, Pennies | null>;

/** Liquidity tier derived from exact-match sales count in the last 90 days (spec §16). */
export type LiquidityTier = "very_high" | "high" | "moderate" | "low" | "very_low";

/** Inputs to the total-grading-cost formula (spec §9). */
export interface TotalGradingCostInput {
  gradingFeePennies: Pennies;
  outboundShippingAllocationPennies: Pennies;
  insuranceAllocationPennies: Pennies;
  returnShippingAllocationPennies: Pennies;
  membershipAllocationPennies: Pennies;
  preparationCostPennies: Pennies;
  estimatedUpchargePennies: Pennies;
  /** Raw card value used to compute opportunity cost (spec §9). */
  rawCardValuePennies: Pennies;
  /** Annual holding-cost rate as a fraction, e.g. 0.12 for 12%/year (spec §23 default). */
  holdingCostRate: number;
  /** Expected turnaround time in months, used to prorate the annual holding-cost rate. */
  expectedTurnaroundMonths: number;
}

/** Inputs to the net-sale-value formula (spec §10). */
export interface NetSaleValueInput {
  expectedSalePricePennies: Pennies;
  /** Marketplace selling-fee rate as a fraction, e.g. 0.12 for 12% (spec §23 default). */
  sellingFeeRate: number;
  /** Fixed per-sale costs: shipping, insurance, taxes, etc. (spec §10). */
  fixedSellingCostsPennies: Pennies;
}

/** Inputs to the final grading-eligibility gate (spec §18 Decision 4 thresholds). */
export interface GradingThresholdInput {
  rawValuePennies: Pennies;
  liquidityAdjustedIncrementalProfitPennies: Pennies;
  gradingRoiPercent: number;
  probabilityOfProfit: number;
  pricingConfidence: number;
  conditionConfidence: number;
  /** P10 (conservative) outcome, profit in pennies — may be negative. */
  conservativeOutcomePennies: Pennies;
  liquidityFactor: number;
  breakEvenGradeAchievable: boolean;
  frontAndBackImagesAvailable: boolean;
  /** spec §18 premium exception: raw value >= $250 may bypass ROI/profit gates. */
  premiumExceptionJustified?: boolean;
}

/** Precedence-order inputs feeding the top-level decision (spec §0 + §18). */
export interface RawCardDecisionInput {
  imagesInsufficientForAnalysis: boolean;
  suspectedCounterfeitOrAlteration: boolean;
  identificationConfidence: number; // 0-100
  pricingConfidence: number; // 0-100
  /** Expected value if graded, at the most likely (P50) outcome, in pennies. */
  expectedGradedValuePennies: Pennies | null;
  rawValuePennies: Pennies;
  /** Whether grading is expected to be profitable at all (used only for the TRASH/BULK gate). */
  gradingProfitable: boolean;
  /** Whether every Decision-4 threshold (spec §18) is met. */
  gradingThresholdsMet: boolean;
}

export interface RawCardDecisionResult {
  decision: RawCardDecision;
  reason: string;
}
