import { describe, it, expect } from "vitest";
import { decideRawCardAction, passesGradingThresholds, breakGraderTie } from "@/lib/raw-card-pricer/decision";
import type { GradingThresholdInput, RawCardDecisionInput } from "@/lib/raw-card-pricer/types";

const baseDecisionInput: RawCardDecisionInput = {
  imagesInsufficientForAnalysis: false,
  suspectedCounterfeitOrAlteration: false,
  identificationConfidence: 95,
  pricingConfidence: 80,
  expectedGradedValuePennies: 10000,
  rawValuePennies: 5000,
  gradingProfitable: true,
  gradingThresholdsMet: false,
};

describe("decideRawCardAction — spec §0 precedence order", () => {
  it("images insufficient wins over everything else", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, imagesInsufficientForAnalysis: true, suspectedCounterfeitOrAlteration: true });
    expect(result.decision).toBe("ADDITIONAL_PHOTOS_REQUIRED");
  });

  it("suspected counterfeit wins over identification/pricing confidence", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, suspectedCounterfeitOrAlteration: true, identificationConfidence: 20 });
    expect(result.decision).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.reason).toMatch(/counterfeit/i);
  });

  it("identification confidence below 90 forces manual review", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, identificationConfidence: 89 });
    expect(result.decision).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("pricing confidence below 40 forces manual review even with good identification", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, pricingConfidence: 39 });
    expect(result.decision).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("expected graded value above $1000 forces manual review, even if grading thresholds are met", () => {
    const result = decideRawCardAction({
      ...baseDecisionInput,
      expectedGradedValuePennies: 100001,
      gradingThresholdsMet: true,
    });
    expect(result.decision).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("raw value below $1 and grading unprofitable -> TRASH_BULK", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, rawValuePennies: 50, gradingProfitable: false, expectedGradedValuePennies: null });
    expect(result.decision).toBe("TRASH_BULK");
  });

  it("raw value below $1 but grading IS profitable does not trigger TRASH_BULK", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, rawValuePennies: 50, gradingProfitable: true, gradingThresholdsMet: true, expectedGradedValuePennies: 200 });
    expect(result.decision).toBe("GRADE");
  });

  it("all grading thresholds met -> GRADE", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, gradingThresholdsMet: true });
    expect(result.decision).toBe("GRADE");
  });

  it("raw value >= $20 but grading thresholds not met -> SELL_RAW", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, rawValuePennies: 2500, gradingThresholdsMet: false });
    expect(result.decision).toBe("SELL_RAW");
  });

  it("raw value $1.00-$19.99 with grading thresholds not met -> KEEP_RAW", () => {
    const result = decideRawCardAction({ ...baseDecisionInput, rawValuePennies: 1000, gradingThresholdsMet: false });
    expect(result.decision).toBe("KEEP_RAW");
  });
});

function goodGradingInput(overrides: Partial<GradingThresholdInput> = {}): GradingThresholdInput {
  return {
    rawValuePennies: 5000, // $50
    liquidityAdjustedIncrementalProfitPennies: 6000, // $60
    gradingRoiPercent: 80,
    probabilityOfProfit: 0.8,
    pricingConfidence: 80,
    conditionConfidence: 80,
    conservativeOutcomePennies: 0,
    liquidityFactor: 0.95,
    breakEvenGradeAchievable: true,
    frontAndBackImagesAvailable: true,
    ...overrides,
  };
}

describe("passesGradingThresholds — spec §18 Decision 4", () => {
  it("passes when every threshold clears", () => {
    expect(passesGradingThresholds(goodGradingInput())).toBe(true);
  });

  it("fails when raw value is below the $20 floor", () => {
    expect(passesGradingThresholds(goodGradingInput({ rawValuePennies: 1500 }))).toBe(false);
  });

  it("fails when liquidity-adjusted profit is below $40", () => {
    expect(passesGradingThresholds(goodGradingInput({ liquidityAdjustedIncrementalProfitPennies: 3000 }))).toBe(false);
  });

  it("fails when grading ROI is below 50%", () => {
    expect(passesGradingThresholds(goodGradingInput({ gradingRoiPercent: 40 }))).toBe(false);
  });

  it("fails when probability of profit is below 70%", () => {
    expect(passesGradingThresholds(goodGradingInput({ probabilityOfProfit: 0.6 }))).toBe(false);
  });

  it("fails when the conservative (P10) downside is worse than -$25", () => {
    expect(passesGradingThresholds(goodGradingInput({ conservativeOutcomePennies: -3000 }))).toBe(false);
  });

  it("fails when only one side of the card is photographed", () => {
    expect(passesGradingThresholds(goodGradingInput({ frontAndBackImagesAvailable: false }))).toBe(false);
  });

  it("fails when no break-even grade is achievable", () => {
    expect(passesGradingThresholds(goodGradingInput({ breakEvenGradeAchievable: false }))).toBe(false);
  });

  it("premium exception bypasses ROI/profit gates for raw value >= $250 when explicitly justified", () => {
    const input = goodGradingInput({
      rawValuePennies: 30000, // $300
      gradingRoiPercent: 10, // would otherwise fail
      probabilityOfProfit: 0.3, // would otherwise fail
      liquidityAdjustedIncrementalProfitPennies: 500, // would otherwise fail
      premiumExceptionJustified: true,
    });
    expect(passesGradingThresholds(input)).toBe(true);
  });

  it("does NOT bypass the core gates (e.g. condition confidence) even under the premium exception", () => {
    const input = goodGradingInput({
      rawValuePennies: 30000,
      conditionConfidence: 30,
      premiumExceptionJustified: true,
    });
    expect(passesGradingThresholds(input)).toBe(false);
  });

  it("does not apply the premium exception below the $250 threshold", () => {
    const input = goodGradingInput({
      rawValuePennies: 20000, // $200, below $250
      gradingRoiPercent: 10,
      premiumExceptionJustified: true,
    });
    expect(passesGradingThresholds(input)).toBe(false);
  });
});

describe("breakGraderTie — spec §8", () => {
  const psa = { company: "PSA", liquidityAdjustedIncrementalProfitPennies: 10000, probabilityOfProfit: 0.8, turnaroundDays: 20, liquidityFactor: 0.97, totalGradingCostPennies: 2000 };
  const cgc = { company: "CGC", liquidityAdjustedIncrementalProfitPennies: 9800, probabilityOfProfit: 0.85, turnaroundDays: 15, liquidityFactor: 0.92, totalGradingCostPennies: 1800 };
  const bgs = { company: "BGS", liquidityAdjustedIncrementalProfitPennies: 3000, probabilityOfProfit: 0.5, turnaroundDays: 45, liquidityFactor: 0.85, totalGradingCostPennies: 2500 };

  it("picks the clear winner when profits are outside the tie band", () => {
    expect(breakGraderTie([psa, bgs])?.company).toBe("PSA");
  });

  it("breaks a tie by higher probability of profit when within the tie band", () => {
    // psa=10000, cgc=9800 -> within $10/10% band -> tie-break by probability of profit -> cgc (0.85 > 0.8)
    expect(breakGraderTie([psa, cgc])?.company).toBe("CGC");
  });

  it("returns the single candidate when only one is given", () => {
    expect(breakGraderTie([psa])?.company).toBe("PSA");
  });

  it("returns null for an empty candidate list", () => {
    expect(breakGraderTie([])).toBeNull();
  });

  it("falls through every tie-break criterion to null when still fully tied", () => {
    const a = { ...psa, company: "A" };
    const b = { ...psa, company: "B" };
    expect(breakGraderTie([a, b])).toBeNull();
  });
});
