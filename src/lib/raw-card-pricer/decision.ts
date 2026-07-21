/**
 * Final decision precedence engine (spec §0 + §18). Pure and deterministic:
 * given the confidence scores, thresholds, and flags the rest of this
 * package computes, returns exactly one of the six terminal decisions.
 *
 * Evaluation order matters — the spec is explicit that "when multiple rules
 * fire, the highest-priority outcome wins" (§0), so this function checks
 * gates in the documented order and returns on the first match.
 */
import { RAW_CARD_PRICER_DEFAULTS } from "./defaults";
import type { GradingThresholdInput, RawCardDecisionInput, RawCardDecisionResult } from "./types";

const HIGH_VALUE_MANUAL_REVIEW_PENNIES = RAW_CARD_PRICER_DEFAULTS.highValueManualReviewThresholdDollars * 100;
const BULK_THRESHOLD_PENNIES = RAW_CARD_PRICER_DEFAULTS.bulkThresholdDollars * 100;
const MIN_RAW_VALUE_TO_GRADE_PENNIES = RAW_CARD_PRICER_DEFAULTS.minRawValueToGradeDollars * 100;

/**
 * Section 18 Decision 4 gate: every threshold must pass (or the premium
 * exception must be explicitly justified) for GRADE to be eligible.
 */
export function passesGradingThresholds(input: GradingThresholdInput): boolean {
  const d = RAW_CARD_PRICER_DEFAULTS;
  const meetsCoreGates =
    input.rawValuePennies >= MIN_RAW_VALUE_TO_GRADE_PENNIES &&
    input.pricingConfidence >= d.minPricingConfidenceToGrade &&
    input.conditionConfidence >= d.minConditionConfidenceToGrade &&
    input.conservativeOutcomePennies >= d.conservativeDownsideFloorDollars * 100 &&
    input.liquidityFactor >= d.minLiquidityFactorToGrade &&
    input.breakEvenGradeAchievable &&
    input.frontAndBackImagesAvailable;

  if (!meetsCoreGates) return false;

  const meetsProfitGates =
    input.liquidityAdjustedIncrementalProfitPennies >= d.minLiquidityAdjustedIncrementalProfitDollars * 100 &&
    input.gradingRoiPercent >= d.minGradingRoiPercent &&
    input.probabilityOfProfit >= d.minProbabilityOfProfit;

  if (meetsProfitGates) return true;

  // Premium exception (spec §18): raw value >= $250 may bypass the
  // ROI/profit gates when the caller has explicitly justified it (e.g.
  // authentication/protection/liquidity benefit). The $1,000 high-value
  // manual-review rule (spec §0) still takes precedence over this at the
  // top-level decision function below, regardless of this gate's result.
  if (input.rawValuePennies >= d.premiumExceptionThresholdDollars * 100 && input.premiumExceptionJustified) {
    return true;
  }

  return false;
}

/**
 * Top-level decision precedence (spec §0, evaluated in order; §18 for the
 * per-decision trigger conditions). Returns the first rule that fires.
 */
export function decideRawCardAction(input: RawCardDecisionInput): RawCardDecisionResult {
  if (input.imagesInsufficientForAnalysis) {
    return { decision: "ADDITIONAL_PHOTOS_REQUIRED", reason: "Images fail the minimum photo-quality standard for any analysis." };
  }

  if (input.suspectedCounterfeitOrAlteration) {
    return {
      decision: "MANUAL_REVIEW_REQUIRED",
      reason: "Suspected counterfeit or alteration — never routed to a normal grading recommendation.",
    };
  }

  if (input.identificationConfidence < 90) {
    return {
      decision: "MANUAL_REVIEW_REQUIRED",
      reason: `Identification confidence ${input.identificationConfidence} is below the required 90.`,
    };
  }

  if (input.pricingConfidence < 40) {
    return {
      decision: "MANUAL_REVIEW_REQUIRED",
      reason: `Pricing confidence ${input.pricingConfidence} is below the minimum 40 required to issue any valuation.`,
    };
  }

  if (input.expectedGradedValuePennies !== null && input.expectedGradedValuePennies > HIGH_VALUE_MANUAL_REVIEW_PENNIES) {
    return {
      decision: "MANUAL_REVIEW_REQUIRED",
      reason: `Expected graded value exceeds the $${RAW_CARD_PRICER_DEFAULTS.highValueManualReviewThresholdDollars} high-value manual-review threshold.`,
    };
  }

  if (input.rawValuePennies < BULK_THRESHOLD_PENNIES && !input.gradingProfitable) {
    return {
      decision: "TRASH_BULK",
      reason: `Raw value below the $${RAW_CARD_PRICER_DEFAULTS.bulkThresholdDollars} bulk threshold and grading is not profitable.`,
    };
  }

  if (input.gradingThresholdsMet) {
    return { decision: "GRADE", reason: "All Section 18 grading thresholds passed." };
  }

  if (input.rawValuePennies >= MIN_RAW_VALUE_TO_GRADE_PENNIES) {
    return {
      decision: "SELL_RAW",
      reason: `Raw value >= $${RAW_CARD_PRICER_DEFAULTS.minRawValueToGradeDollars} but grading thresholds were not met.`,
    };
  }

  return {
    decision: "KEEP_RAW",
    reason: `Raw value between $${RAW_CARD_PRICER_DEFAULTS.bulkThresholdDollars} and $${RAW_CARD_PRICER_DEFAULTS.minRawValueToGradeDollars - 0.01} with grading thresholds not met.`,
  };
}

/**
 * Grader tie-break rule (spec §8): if two companies' expected incremental
 * profits are within $10 or 10% (whichever is greater), prefer in order:
 * (1) higher probability of profit, (2) faster turnaround, (3) higher
 * liquidity, (4) lower total cost. If still tied, the caller should return
 * MANUAL_REVIEW_REQUIRED ("grading-company outcomes too close") — this
 * function returns `null` in that case rather than guessing.
 */
export interface GraderCandidate {
  company: string;
  liquidityAdjustedIncrementalProfitPennies: number;
  probabilityOfProfit: number;
  turnaroundDays: number;
  liquidityFactor: number;
  totalGradingCostPennies: number;
}

export function breakGraderTie(candidates: GraderCandidate[]): GraderCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort(
    (a, b) => b.liquidityAdjustedIncrementalProfitPennies - a.liquidityAdjustedIncrementalProfitPennies,
  );
  const best = sorted[0];
  const tieBandPennies = Math.max(
    RAW_CARD_PRICER_DEFAULTS.graderTieBreakBandDollars * 100,
    Math.abs(best.liquidityAdjustedIncrementalProfitPennies) * RAW_CARD_PRICER_DEFAULTS.graderTieBreakBandPercent,
  );
  const tied = sorted.filter(
    (c) => best.liquidityAdjustedIncrementalProfitPennies - c.liquidityAdjustedIncrementalProfitPennies <= tieBandPennies,
  );

  if (tied.length === 1) return tied[0];

  const byProfitProbability = maxBy(tied, (c) => c.probabilityOfProfit);
  if (byProfitProbability.length === 1) return byProfitProbability[0];

  const byTurnaround = minBy(byProfitProbability, (c) => c.turnaroundDays);
  if (byTurnaround.length === 1) return byTurnaround[0];

  const byLiquidity = maxBy(byTurnaround, (c) => c.liquidityFactor);
  if (byLiquidity.length === 1) return byLiquidity[0];

  const byCost = minBy(byLiquidity, (c) => c.totalGradingCostPennies);
  if (byCost.length === 1) return byCost[0];

  // Still tied after every tie-break criterion — spec §8: "return MANUAL
  // REVIEW REQUIRED". Signal that to the caller rather than picking arbitrarily.
  return null;
}

function maxBy<T>(items: T[], key: (item: T) => number): T[] {
  const max = Math.max(...items.map(key));
  return items.filter((item) => key(item) === max);
}

function minBy<T>(items: T[], key: (item: T) => number): T[] {
  const min = Math.min(...items.map(key));
  return items.filter((item) => key(item) === min);
}
