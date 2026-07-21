import { describe, it, expect } from "vitest";
import {
  dropUnpricedGradesAndRenormalize,
  conditionScore,
  expectedGradedSalePrice,
  netSaleValue,
  totalGradingCost,
  expectedNetProfit,
  gradingRoiPercent,
  totalInvestmentRoiPercent,
  breakEvenGrade,
  lossProbability,
  liquidityAdjustedIncrementalProfit,
  companyDecisionScore,
  riskAdjustedGradingScore,
  estimatedUpcharge,
} from "@/lib/raw-card-pricer/formulas";

describe("conditionScore — spec §7 weighted model", () => {
  it("weights centering 25%, surface 35%, corners 20%, edges 20%", () => {
    // (10*0.25)+(10*0.35)+(10*0.20)+(10*0.20) = 10
    expect(conditionScore({ centering: 10, surface: 10, corners: 10, edges: 10 })).toBeCloseTo(10);
    // (8*0.25)+(6*0.35)+(9*0.20)+(7*0.20) = 2 + 2.1 + 1.8 + 1.4 = 7.3
    expect(conditionScore({ centering: 8, surface: 6, corners: 9, edges: 7 })).toBeCloseTo(7.3);
  });
});

describe("expectedGradedSalePrice — spec §11 worked example", () => {
  it("matches the spec's PSA example exactly: 0.2*300 + 0.6*120 + 0.2*70 = $146", () => {
    const distribution = { "10": 0.2, "9": 0.6, "8": 0.2 };
    const prices = { "10": 30000, "9": 12000, "8": 7000 }; // pennies
    expect(expectedGradedSalePrice(distribution, prices)).toBe(14600); // $146.00
  });

  it("skips grades absent from the price map", () => {
    const distribution = { "10": 0.5, "9": 0.5 };
    const prices = { "10": 10000 };
    // Only the "10" term contributes; caller is responsible for renormalizing first.
    expect(expectedGradedSalePrice(distribution, prices)).toBe(5000);
  });
});

describe("dropUnpricedGradesAndRenormalize — spec §2", () => {
  it("renormalizes remaining probabilities to sum to 1 after dropping unpriced grades", () => {
    const distribution = { "10": 0.2, "9": 0.6, "8": 0.2 };
    const prices = { "10": 30000, "9": 12000, "8": null };
    const result = dropUnpricedGradesAndRenormalize(distribution, prices);
    expect(result.distribution["8"]).toBeUndefined();
    expect(result.distribution["10"]).toBeCloseTo(0.25); // 0.2 / 0.8
    expect(result.distribution["9"]).toBeCloseTo(0.75); // 0.6 / 0.8
    expect(result.droppedProbabilityMass).toBeCloseTo(0.2);
    expect(result.majorityMassUnpriced).toBe(false);
  });

  it("flags majorityMassUnpriced when more than half the probability mass is dropped", () => {
    const distribution = { "10": 0.6, "9": 0.4 };
    const prices = { "10": null, "9": 5000 };
    const result = dropUnpricedGradesAndRenormalize(distribution, prices);
    expect(result.majorityMassUnpriced).toBe(true);
    expect(result.distribution["9"]).toBeCloseTo(1);
  });

  it("never fabricates a price for an entirely-unpriced distribution", () => {
    const result = dropUnpricedGradesAndRenormalize({ "10": 1 }, { "10": null });
    expect(result.distribution).toEqual({});
    expect(result.majorityMassUnpriced).toBe(true);
  });
});

describe("netSaleValue — spec §10", () => {
  it("applies the selling fee rate and subtracts fixed costs", () => {
    // $100 sale, 12% fee, $5 fixed -> 10000*0.88 - 500 = 8800 - 500 = 8300
    expect(netSaleValue({ expectedSalePricePennies: 10000, sellingFeeRate: 0.12, fixedSellingCostsPennies: 500 })).toBe(8300);
  });
});

describe("totalGradingCost — spec §9", () => {
  it("sums every allocation plus the opportunity-cost term", () => {
    const cost = totalGradingCost({
      gradingFeePennies: 1700,
      outboundShippingAllocationPennies: 100,
      insuranceAllocationPennies: 50,
      returnShippingAllocationPennies: 100,
      membershipAllocationPennies: 200,
      preparationCostPennies: 100,
      estimatedUpchargePennies: 0,
      rawCardValuePennies: 10000, // $100
      holdingCostRate: 0.12,
      expectedTurnaroundMonths: 2,
    });
    // opportunity cost = 10000 * 0.12 * (2/12) = 200
    expect(cost).toBe(1700 + 100 + 50 + 100 + 200 + 100 + 0 + 200);
  });
});

describe("expectedNetProfit / gradingRoiPercent / totalInvestmentRoiPercent — spec §12-13", () => {
  it("computes incremental profit over raw and both ROI figures", () => {
    const profit = expectedNetProfit({
      expectedGradedNetSaleValuePennies: 14000,
      rawNetSaleValuePennies: 8000,
      totalGradingCostPennies: 2000,
    });
    expect(profit).toBe(4000); // $40 incremental profit
    expect(gradingRoiPercent(profit, 2000)).toBeCloseTo(200); // 4000/2000*100
    expect(
      totalInvestmentRoiPercent({ expectedNetProfitPennies: profit, rawCardValuePennies: 10000, totalGradingCostPennies: 2000 }),
    ).toBeCloseTo((4000 / 12000) * 100);
  });

  it("throws rather than dividing by zero total grading cost", () => {
    expect(() => gradingRoiPercent(1000, 0)).toThrow();
  });
});

describe("breakEvenGrade — spec §14", () => {
  it("finds the lowest grade where graded net minus cost beats raw net", () => {
    const grade = breakEvenGrade({
      gradesWorstToBest: ["8", "9", "10"],
      netSaleValueByGrade: { "8": 6000, "9": 10000, "10": 25000 },
      totalGradingCostPennies: 2000,
      rawNetSaleValuePennies: 7000,
    });
    // 8: 6000-2000=4000 (not > 7000); 9: 10000-2000=8000 (> 7000) -> break-even is "9"
    expect(grade).toBe("9");
  });

  it("returns null (\"NONE — do not grade\") when no grade clears raw net", () => {
    const grade = breakEvenGrade({
      gradesWorstToBest: ["8", "9"],
      netSaleValueByGrade: { "8": 3000, "9": 5000 },
      totalGradingCostPennies: 2000,
      rawNetSaleValuePennies: 6000,
    });
    expect(grade).toBeNull();
  });
});

describe("lossProbability — spec §15", () => {
  it("sums probability of every outcome worse than raw, including rejection", () => {
    const outcomes = [
      { probability: 0.2, netResultPennies: 20000 }, // profit
      { probability: 0.5, netResultPennies: 5000 }, // loss vs raw
      { probability: 0.3, netResultPennies: -2000 }, // rejected: net = -total cost
    ];
    expect(lossProbability(outcomes, 8000)).toBeCloseTo(0.8);
  });
});

describe("liquidityAdjustedIncrementalProfit — spec §16", () => {
  it("multiplies expected net profit by the liquidity factor", () => {
    expect(liquidityAdjustedIncrementalProfit(10000, 0.92)).toBe(9200);
  });
});

describe("companyDecisionScore — spec §19", () => {
  it("computes the weighted score and floors/caps at 0-100", () => {
    const score = companyDecisionScore({
      liquidityAdjustedIncrementalProfitPennies: 10000, // $100 -> profit term maxes at 40
      gradingRoiPercent: 100, // caps roi term at 20
      probabilityOfProfit: 1, // 20
      liquidityFactor: 1, // 10
      pricingConfidence: 100, // 10
      rejectionProbability: 0,
    });
    expect(score).toBeCloseTo(100);
  });

  it("heavily penalizes rejection probability", () => {
    const score = companyDecisionScore({
      liquidityAdjustedIncrementalProfitPennies: 10000,
      gradingRoiPercent: 100,
      probabilityOfProfit: 1,
      liquidityFactor: 1,
      pricingConfidence: 100,
      rejectionProbability: 0.5,
    });
    expect(score).toBeCloseTo(75); // 100 - 0.5*50
  });

  it("never goes below 0 even with a large rejection probability", () => {
    const score = companyDecisionScore({
      liquidityAdjustedIncrementalProfitPennies: 0,
      gradingRoiPercent: 0,
      probabilityOfProfit: 0,
      liquidityFactor: 0,
      pricingConfidence: 0,
      rejectionProbability: 1,
    });
    expect(score).toBe(0);
  });
});

describe("riskAdjustedGradingScore — spec §17", () => {
  it("stays within 0-100 and rewards strong inputs", () => {
    const score = riskAdjustedGradingScore({
      expectedIncrementalProfitPennies: 10000,
      gradingRoiPercent: 100,
      probabilityOfProfit: 1,
      liquidityFactor: 1,
      pricingConfidence: 100,
      conditionConfidence: 100,
    });
    expect(score).toBeCloseTo(100);
  });
});

describe("estimatedUpcharge — spec §8", () => {
  it("is probability-weighted and never negative per grade", () => {
    const distribution = { "10": 0.3, "9": 0.7 };
    const tierFees = { "10": 15000, "9": 5000 }; // graded-value tier fee
    const upcharge = estimatedUpcharge(distribution, tierFees, 7500); // submitted at $75 tier
    // "10": max(0, 15000-7500)=7500 * 0.3 = 2250; "9": max(0, 5000-7500)=0 * 0.7 = 0
    expect(upcharge).toBe(2250);
  });
});
