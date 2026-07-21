import { describe, it, expect } from "vitest";
import { priceChartingCardTiers } from "@/lib/pricecharting/grade-mapping";
import { mapGradeToTier } from "@/lib/market/grade-tier";

// Every supported PriceCharting CARD price field, in cents.
const FULL = {
  "loose-price": 2000,
  "cib-price": 3000,
  "new-price": 4000,
  "graded-price": 5000,
  "box-only-price": 6000,
  "manual-only-price": 30000,
  "bgs-10-price": 28000,
  "condition-17-price": 26000,
  "condition-18-price": 24000,
};

describe("priceChartingCardTiers — the ONE authoritative field→tier map", () => {
  it("maps every supported field to the right tier and label", () => {
    const tiers = priceChartingCardTiers(FULL);
    const byLabel = Object.fromEntries(tiers.map((t) => [t.grade_label, t]));

    expect(tiers).toHaveLength(9); // all nine card fields, not just three
    expect(byLabel["Ungraded"].price_cents).toBe(2000);
    expect(byLabel["Grade 7–7.5"].price_cents).toBe(3000);
    expect(byLabel["Grade 8–8.5"].price_cents).toBe(4000);
    expect(byLabel["Grade 9 (general)"].price_cents).toBe(5000);
    expect(byLabel["Grade 9.5 (general)"].price_cents).toBe(6000);
    expect(byLabel["PSA 10"].price_cents).toBe(30000);
    expect(byLabel["BGS 10"].price_cents).toBe(28000);
    expect(byLabel["CGC 10"].price_cents).toBe(26000);
    expect(byLabel["SGC 10"].price_cents).toBe(24000);
  });

  it("leaves missing fields null — never 0, never substituted", () => {
    const tiers = priceChartingCardTiers({ "loose-price": 2000 }); // only ungraded present
    const byLabel = Object.fromEntries(tiers.map((t) => [t.grade_label, t]));
    expect(byLabel["Ungraded"].price_cents).toBe(2000);
    expect(byLabel["PSA 10"].price_cents).toBeNull();
    expect(byLabel["Grade 9 (general)"].price_cents).toBeNull();
    // Still returns all nine rows so the null tiers are explicit, not hidden.
    expect(tiers).toHaveLength(9);
  });

  it("does NOT mislabel a generic tier as a grader-specific value", () => {
    const tiers = priceChartingCardTiers(FULL);
    const graded9 = tiers.find((t) => t.grade_label === "Grade 9 (general)")!;
    // graded-price is a GENERAL grade 9 — no grader is attached, and the label
    // must not claim PSA/CGC/BGS/SGC.
    expect(graded9.grader).toBeNull();
    expect(graded9.grade_label).not.toMatch(/PSA|CGC|BGS|SGC/);
    // The grade-10 fields ARE company-specific per PriceCharting's field docs.
    expect(tiers.find((t) => t.grade_label === "PSA 10")!.grader).toBe("PSA");
    expect(tiers.find((t) => t.grade_label === "CGC 10")!.grader).toBe("CGC");
  });

  it("keeps the four grade-10 fields DISTINCT even though they share tier grade_10", () => {
    const tiers = priceChartingCardTiers(FULL);
    const tens = tiers.filter((t) => mapGradeToTier(t.grader, t.grade, t.grade_label) === "grade_10");
    // All four map to the same canonical tier...
    expect(tens.map((t) => t.grade_label).sort()).toEqual(["BGS 10", "CGC 10", "PSA 10", "SGC 10"]);
    // ...but carry four distinct prices, never collapsed to one "Grade 10".
    expect(new Set(tens.map((t) => t.price_cents)).size).toBe(4);
  });
});
