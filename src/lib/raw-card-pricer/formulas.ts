/**
 * Core financial and probability formulas from the Raw Card Pricer spec
 * (§7, §9-17, §19). All money is integer pennies (`Pennies`) — see
 * `@/lib/pricecharting/money`. Every formula here is pure and side-effect
 * free so it can be unit-tested against the spec's own worked examples.
 */
import { sumPennies } from "@/lib/pricecharting/money";
import type { GradeProbability, NetSaleValueInput, PriceByGrade, TotalGradingCostInput } from "./types";
import type { Pennies } from "@/lib/pricecharting/money";

/**
 * Drop grades with no market data from a probability distribution and
 * renormalize the rest to sum to 1 (spec §2: "renormalize the remaining
 * probabilities to 100%... never interpolate or fabricate a missing grade
 * value"). Returns the renormalized distribution plus whether more than
 * half the original probability mass was dropped (spec §2: caps pricing
 * confidence at 39 when true).
 */
export function dropUnpricedGradesAndRenormalize(
  distribution: GradeProbability,
  prices: PriceByGrade,
): { distribution: GradeProbability; droppedProbabilityMass: number; majorityMassUnpriced: boolean } {
  let keptMass = 0;
  let droppedMass = 0;
  for (const [grade, probability] of Object.entries(distribution)) {
    if (prices[grade] === null || prices[grade] === undefined) {
      droppedMass += probability;
    } else {
      keptMass += probability;
    }
  }
  if (keptMass <= 0) {
    return { distribution: {}, droppedProbabilityMass: droppedMass, majorityMassUnpriced: true };
  }
  const renormalized: GradeProbability = {};
  for (const [grade, probability] of Object.entries(distribution)) {
    if (prices[grade] !== null && prices[grade] !== undefined) {
      renormalized[grade] = probability / keptMass;
    }
  }
  return {
    distribution: renormalized,
    droppedProbabilityMass: droppedMass,
    majorityMassUnpriced: droppedMass > 0.5,
  };
}

/**
 * Condition Score = (Centering x 0.25) + (Surface x 0.35) + (Corners x 0.20)
 * + (Edges x 0.20) (spec §7). All four inputs are on the 1-10 scale.
 */
export function conditionScore(input: { centering: number; surface: number; corners: number; edges: number }): number {
  return input.centering * 0.25 + input.surface * 0.35 + input.corners * 0.2 + input.edges * 0.2;
}

/**
 * Expected Graded Sale Price = Sum(P(grade) x Market Value at that grade)
 * (spec §11). Callers should pass an already-renormalized distribution
 * (see `dropUnpricedGradesAndRenormalize`) so every priced grade sums to 1.
 */
export function expectedGradedSalePrice(distribution: GradeProbability, prices: PriceByGrade): Pennies {
  let expectedPennies = 0;
  for (const [grade, probability] of Object.entries(distribution)) {
    const price = prices[grade];
    if (price === null || price === undefined) continue;
    expectedPennies += probability * price;
  }
  return Math.round(expectedPennies);
}

/**
 * Raw Net Sale Value = Raw Market Value x (1 - selling fee rate) - fixed
 * selling costs (spec §10). This is the single canonical raw-value baseline
 * used by every profit/break-even/ROI formula — never the quick-sale (x0.80)
 * display value (spec §10, §22).
 */
export function netSaleValue(input: NetSaleValueInput): Pennies {
  const netOfFeeRate = input.expectedSalePricePennies * (1 - input.sellingFeeRate);
  return Math.round(netOfFeeRate - input.fixedSellingCostsPennies);
}

/**
 * Total Grading Cost = Grading Fee + Outbound Shipping Allocation + Insurance
 * Allocation + Return Shipping Allocation + Membership Allocation +
 * Preparation Cost + Estimated Upcharge + Opportunity Cost (spec §9).
 * Opportunity Cost = Raw Card Value x Holding-Cost Rate x
 * (Expected Turnaround Months / 12).
 */
export function totalGradingCost(input: TotalGradingCostInput): Pennies {
  const opportunityCostPennies = Math.round(
    input.rawCardValuePennies * input.holdingCostRate * (input.expectedTurnaroundMonths / 12),
  );
  return sumPennies([
    input.gradingFeePennies,
    input.outboundShippingAllocationPennies,
    input.insuranceAllocationPennies,
    input.returnShippingAllocationPennies,
    input.membershipAllocationPennies,
    input.preparationCostPennies,
    input.estimatedUpchargePennies,
    opportunityCostPennies,
  ]);
}

/**
 * Expected Net Profit = Expected Graded Net Sale Value - Raw Net Sale Value -
 * Total Grading Cost (spec §12). This is the primary grading-decision metric
 * — incremental profit over selling raw.
 */
export function expectedNetProfit(input: {
  expectedGradedNetSaleValuePennies: Pennies;
  rawNetSaleValuePennies: Pennies;
  totalGradingCostPennies: Pennies;
}): Pennies {
  return input.expectedGradedNetSaleValuePennies - input.rawNetSaleValuePennies - input.totalGradingCostPennies;
}

/** Grading ROI (%) = Expected Net Profit / Total Grading Cost x 100 (spec §13). */
export function gradingRoiPercent(expectedNetProfitPennies: Pennies, totalGradingCostPennies: Pennies): number {
  if (totalGradingCostPennies <= 0) {
    throw new Error(`gradingRoiPercent: totalGradingCostPennies must be > 0, got ${totalGradingCostPennies}`);
  }
  return (expectedNetProfitPennies / totalGradingCostPennies) * 100;
}

/**
 * Total Investment ROI (%) = Expected Net Profit / (Raw Card Value + Total
 * Grading Cost) x 100 (spec §13). Informational only — the binding threshold
 * (spec §18) uses Grading ROI, not this figure.
 */
export function totalInvestmentRoiPercent(input: {
  expectedNetProfitPennies: Pennies;
  rawCardValuePennies: Pennies;
  totalGradingCostPennies: Pennies;
}): number {
  const denominator = input.rawCardValuePennies + input.totalGradingCostPennies;
  if (denominator <= 0) {
    throw new Error(`totalInvestmentRoiPercent: denominator must be > 0, got ${denominator}`);
  }
  return (input.expectedNetProfitPennies / denominator) * 100;
}

/**
 * Break-Even Grade = the lowest grade (worst outcome) for which
 * (Graded Net Sale Value at that grade) - Total Grading Cost > Raw Net Sale
 * Value (spec §14). `gradesWorstToBest` must list grade labels ordered from
 * worst to best; `netSaleValueByGrade` gives the net sale value at each
 * grade. Returns `null` ("NONE - do not grade") if no grade satisfies it.
 */
export function breakEvenGrade(input: {
  gradesWorstToBest: string[];
  netSaleValueByGrade: Record<string, Pennies>;
  totalGradingCostPennies: Pennies;
  rawNetSaleValuePennies: Pennies;
}): string | null {
  for (const grade of input.gradesWorstToBest) {
    const gradedNetSaleValue = input.netSaleValueByGrade[grade];
    if (gradedNetSaleValue === undefined) continue;
    if (gradedNetSaleValue - input.totalGradingCostPennies > input.rawNetSaleValuePennies) {
      return grade;
    }
  }
  return null;
}

/**
 * Loss Probability = sum of probability of every outcome whose net result is
 * worse than selling raw (spec §15). `outcomes` should include the Rejected
 * / No Grade outcome (net = -Total Grading Cost) and any unpriced-grade mass
 * as their own entries — this function does not add them implicitly.
 */
export function lossProbability(outcomes: Array<{ probability: number; netResultPennies: Pennies }>, rawNetSaleValuePennies: Pennies): number {
  return outcomes.reduce((sum, o) => (o.netResultPennies < rawNetSaleValuePennies ? sum + o.probability : sum), 0);
}

/**
 * Liquidity-Adjusted Incremental Profit = Expected Net Profit x Liquidity
 * Factor (spec §16). Used for both the GRADE-vs-RAW decision and grader
 * selection. Never combine with the quick-sale multiplier (spec §16, §22).
 */
export function liquidityAdjustedIncrementalProfit(expectedNetProfitPennies: Pennies, liquidityFactor: number): Pennies {
  return Math.round(expectedNetProfitPennies * liquidityFactor);
}

/**
 * Company Decision Score (spec §19), 0-100 (floor 0, cap 100):
 * min(profit/$100, 1) x 40 + min(ROI/100%, 1) x 20 + P(profit) x 20
 * + liquidityFactor x 10 + pricingConfidence/100 x 10 - P(rejected) x 50
 */
export function companyDecisionScore(input: {
  liquidityAdjustedIncrementalProfitPennies: Pennies;
  gradingRoiPercent: number;
  probabilityOfProfit: number;
  liquidityFactor: number;
  pricingConfidence: number;
  rejectionProbability: number;
}): number {
  const profitTerm = Math.min(input.liquidityAdjustedIncrementalProfitPennies / 10000, 1) * 40; // $100 = 10000 pennies
  const roiTerm = Math.min(input.gradingRoiPercent / 100, 1) * 20;
  const profitProbTerm = input.probabilityOfProfit * 20;
  const liquidityTerm = input.liquidityFactor * 10;
  const confidenceTerm = (input.pricingConfidence / 100) * 10;
  const rejectionPenalty = input.rejectionProbability * 50;
  const raw = profitTerm + roiTerm + profitProbTerm + liquidityTerm + confidenceTerm - rejectionPenalty;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Risk-Adjusted Grading Score (spec §17), 0-100, informational only — the
 * Section 18 thresholds are the binding gate, not this score.
 */
export function riskAdjustedGradingScore(input: {
  expectedIncrementalProfitPennies: Pennies;
  gradingRoiPercent: number;
  probabilityOfProfit: number;
  liquidityFactor: number;
  pricingConfidence: number;
  conditionConfidence: number;
}): number {
  const profitTerm = Math.min(input.expectedIncrementalProfitPennies / 10000, 1) * 30; // $100 = 10000 pennies
  const roiTerm = Math.min(input.gradingRoiPercent / 100, 1) * 20;
  const profitProbTerm = input.probabilityOfProfit * 20;
  const liquidityTerm = input.liquidityFactor * 10;
  const pricingTerm = (input.pricingConfidence / 100) * 10;
  const conditionTerm = (input.conditionConfidence / 100) * 10;
  return Math.max(0, Math.min(100, profitTerm + roiTerm + profitProbTerm + liquidityTerm + pricingTerm + conditionTerm));
}

/**
 * Estimated Upcharge = Sum over grades [ P(grade) x max(0, tier fee at
 * graded value - submitted tier fee) ] (spec §8, probability-weighted).
 */
export function estimatedUpcharge(
  distribution: GradeProbability,
  tierFeeAtGradedValuePennies: Record<string, Pennies>,
  submittedTierFeePennies: Pennies,
): Pennies {
  let total = 0;
  for (const [grade, probability] of Object.entries(distribution)) {
    const tierFee = tierFeeAtGradedValuePennies[grade];
    if (tierFee === undefined) continue;
    total += probability * Math.max(0, tierFee - submittedTierFeePennies);
  }
  return Math.round(total);
}
