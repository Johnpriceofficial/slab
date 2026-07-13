import { describe, it, expect } from "vitest";
import {
  deriveValuation,
  mapMatchConfidenceToValuationConfidence,
  QUICK_SALE_PERCENTAGE,
  REPLACEMENT_VALUE_PERCENTAGE,
} from "@/lib/slabs/valuation-derive";

describe("mapMatchConfidenceToValuationConfidence", () => {
  it("maps the score bands to the valuation-confidence enum (never 'manual' for a real score)", () => {
    expect(mapMatchConfidenceToValuationConfidence(96, false)).toBe("exact");
    expect(mapMatchConfidenceToValuationConfidence(88, false)).toBe("high");
    expect(mapMatchConfidenceToValuationConfidence(72, false)).toBe("probable");
    expect(mapMatchConfidenceToValuationConfidence(40, false)).toBe("low");
  });

  it("caps an interpolated estimate at 'probable' no matter how high the identity score", () => {
    expect(mapMatchConfidenceToValuationConfidence(99, true)).toBe("probable");
    expect(mapMatchConfidenceToValuationConfidence(88, true)).toBe("probable");
    // Below the estimate cap it is unaffected.
    expect(mapMatchConfidenceToValuationConfidence(40, true)).toBe("low");
  });

  it("only returns 'manual' when there is genuinely no score", () => {
    expect(mapMatchConfidenceToValuationConfidence(null, false)).toBe("manual");
    expect(mapMatchConfidenceToValuationConfidence(NaN, false)).toBe("manual");
  });
});

describe("deriveValuation", () => {
  it("derives quick-sale and replacement from the DOCUMENTED percentages of the guide", () => {
    const d = deriveValuation({ guide_cents: 10000, confidence_score: 96, field_meaning: "CGC 10" });
    expect(d.guide_cents).toBe(10000);
    expect(d.quick_sale_cents).toBe(Math.round(10000 * QUICK_SALE_PERCENTAGE)); // 8000
    expect(d.replacement_cents).toBe(Math.round(10000 * REPLACEMENT_VALUE_PERCENTAGE)); // 11000
    expect(d.suggested_final_cents).toBe(10000); // final == guide → 0% variance
  });

  it("matches the worked Charmander example (guide $42.50 → quick $34.00, replacement $46.75)", () => {
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 96, field_meaning: "CGC 10" });
    expect(d.quick_sale_cents).toBe(3400); // $42.50 × 80%
    expect(d.replacement_cents).toBe(4675); // $42.50 × 110%
    expect(d.suggested_final_cents).toBe(4250);
  });

  it("treats an exact-tier guide as a Verified exact graded-price match", () => {
    // The Charmander flagship: operator enters the CGC 10 Pristine guide tier.
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 65, exact_tier_label: "CGC 10 Pristine" });
    expect(d.confidence).toBe("verified"); // NOT the 65-score 'low'
    expect(d.suggested_final_cents).toBe(4250); // Final = guide → 0% variance
    expect(d.quick_sale_cents).toBe(3400);
    expect(d.replacement_cents).toBe(4675);
    expect(d.method).toMatch(/Exact graded-price match — CGC 10 Pristine/);
    expect(d.is_estimate).toBe(false);
  });

  it("does not upgrade an INTERPOLATED value to Verified even if a tier label is passed", () => {
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 96, is_estimate: true, exact_tier_label: "CGC 10" });
    expect(d.confidence).toBe("probable"); // estimate cap wins; not 'verified'
    expect(d.method).toMatch(/interpolated grade estimate/);
  });

  it("NEVER labels an auto-derived valuation 'manual'", () => {
    const d = deriveValuation({ guide_cents: 5000, confidence_score: 90, field_meaning: "PSA 10" });
    expect(d.confidence).not.toBe("manual");
    expect(d.confidence).toBe("high");
    expect(d.method).toMatch(/Auto-derived from the confirmed PriceCharting value \(PSA 10\)/);
    expect(d.method).toMatch(/Quick-Sale = 80% of guide/);
    expect(d.method).toMatch(/Replacement = 110% of guide/);
  });

  it("labels an interpolated estimate as such and caps confidence at 'probable'", () => {
    const d = deriveValuation({ guide_cents: 8000, confidence_score: 99, is_estimate: true, field_meaning: "grade 9.9" });
    expect(d.is_estimate).toBe(true);
    expect(d.confidence).toBe("probable");
    expect(d.method).toMatch(/interpolated grade estimate/);
  });

  it("falls back to 'manual' with null figures when there is no guide value", () => {
    const d = deriveValuation({ guide_cents: null, confidence_score: 95 });
    expect(d.guide_cents).toBeNull();
    expect(d.quick_sale_cents).toBeNull();
    expect(d.replacement_cents).toBeNull();
    expect(d.suggested_final_cents).toBeNull();
    expect(d.confidence).toBe("manual");
    expect(d.method).toMatch(/enter the valuation manually/i);
  });

  it("rounds fractional cents deterministically", () => {
    const d = deriveValuation({ guide_cents: 999, confidence_score: 80 });
    expect(d.quick_sale_cents).toBe(Math.round(999 * 0.8)); // 799
    expect(d.replacement_cents).toBe(Math.round(999 * 1.1)); // 1099
  });
});
