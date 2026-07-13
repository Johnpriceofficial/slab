import { describe, it, expect } from "vitest";
import {
  deriveValuation,
  mapMatchConfidenceToValuationConfidence,
  QUICK_SALE_PERCENTAGE,
  REPLACEMENT_VALUE_PERCENTAGE,
} from "@/lib/slabs/valuation-derive";

describe("mapMatchConfidenceToValuationConfidence", () => {
  it("maps the score bands to the canonical enum (a pure identity match tops out at 'high', never 'verified')", () => {
    expect(mapMatchConfidenceToValuationConfidence(96, false)).toBe("high"); // legacy 'exact' → 'high'
    expect(mapMatchConfidenceToValuationConfidence(88, false)).toBe("high");
    expect(mapMatchConfidenceToValuationConfidence(72, false)).toBe("moderate"); // legacy 'probable' → 'moderate'
    expect(mapMatchConfidenceToValuationConfidence(40, false)).toBe("low");
  });

  it("caps an interpolated estimate at 'moderate' no matter how high the identity score", () => {
    expect(mapMatchConfidenceToValuationConfidence(99, true)).toBe("moderate");
    expect(mapMatchConfidenceToValuationConfidence(88, true)).toBe("moderate");
    // Below the estimate cap it is unaffected.
    expect(mapMatchConfidenceToValuationConfidence(40, true)).toBe("low");
  });

  it("uses Low for an unscored connected-source match, never Manual", () => {
    expect(mapMatchConfidenceToValuationConfidence(null, false)).toBe("low");
    expect(mapMatchConfidenceToValuationConfidence(NaN, false)).toBe("low");
  });
});

describe("deriveValuation", () => {
  it("derives quick-sale and replacement from the DOCUMENTED percentages of the guide", () => {
    const d = deriveValuation({ guide_cents: 10000, confidence_score: 96, field_meaning: "CGC 10", provenance: "pricecharting_exact_tier" });
    expect(d.guide_cents).toBe(10000);
    expect(d.quick_sale_cents).toBe(Math.round(10000 * QUICK_SALE_PERCENTAGE)); // 8000
    expect(d.replacement_cents).toBe(Math.round(10000 * REPLACEMENT_VALUE_PERCENTAGE)); // 11000
    expect(d.suggested_final_cents).toBe(10000); // final == guide → 0% variance
  });

  it("matches the worked Charmander example (guide $42.50 → quick $34.00, replacement $46.75)", () => {
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 96, field_meaning: "CGC 10", provenance: "pricecharting_exact_tier" });
    expect(d.quick_sale_cents).toBe(3400); // $42.50 × 80%
    expect(d.replacement_cents).toBe(4675); // $42.50 × 110%
    expect(d.suggested_final_cents).toBe(4250);
  });

  it("requires exact tier + confirmed identity + visual confirmation for Verified", () => {
    const d = deriveValuation({
      guide_cents: 4250,
      confidence_score: 65,
      field_meaning: "CGC 10 Pristine",
      provenance: "pricecharting_exact_tier",
      identity_confirmed: true,
      visual_confirmed: true,
    });
    expect(d.confidence).toBe("verified");
    expect(d.suggested_final_cents).toBe(4250); // Final = guide → 0% variance
    expect(d.quick_sale_cents).toBe(3400);
    expect(d.replacement_cents).toBe(4675);
    expect(d.method).toMatch(/exact PriceCharting tier \(CGC 10 Pristine\)/);
    expect(d.is_estimate).toBe(false);
  });

  it("does not upgrade an INTERPOLATED value to Verified even if a tier label is passed", () => {
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 96, is_estimate: true, field_meaning: "CGC 10", provenance: "pricecharting_estimate", identity_confirmed: true });
    expect(d.confidence).toBe("moderate"); // estimate cap wins; not 'verified'
    expect(d.method).toMatch(/documented PriceCharting estimate/);
  });

  it("NEVER labels an auto-derived valuation 'manual'", () => {
    const d = deriveValuation({ guide_cents: 5000, confidence_score: 90, field_meaning: "PSA 10", provenance: "pricecharting_exact_tier", identity_confirmed: true });
    expect(d.confidence).not.toBe("manual");
    expect(d.confidence).toBe("high");
    expect(d.method).toMatch(/Auto-derived from the exact PriceCharting tier \(PSA 10\)/);
    expect(d.method).toMatch(/Quick-Sale = 80% of guide/);
    expect(d.method).toMatch(/Replacement = 110% of guide/);
  });

  it("labels an interpolated estimate as such and caps confidence at 'moderate'", () => {
    const d = deriveValuation({ guide_cents: 8000, confidence_score: 99, is_estimate: true, field_meaning: "grade 9.9", provenance: "pricecharting_estimate", identity_confirmed: true });
    expect(d.is_estimate).toBe(true);
    expect(d.confidence).toBe("moderate");
    expect(d.method).toMatch(/documented PriceCharting estimate/);
  });

  it("records tier unavailability with null confidence and blank derived figures", () => {
    const d = deriveValuation({ guide_cents: null, confidence_score: 95, provenance: "tier_unavailable" });
    expect(d.guide_cents).toBeNull();
    expect(d.quick_sale_cents).toBeNull();
    expect(d.replacement_cents).toBeNull();
    expect(d.suggested_final_cents).toBeNull();
    expect(d.confidence).toBeNull();
    expect(d.provenance).toBe("tier_unavailable");
    expect(d.method).toMatch(/tier unavailable/i);
  });

  it("rounds fractional cents deterministically", () => {
    const d = deriveValuation({ guide_cents: 999, confidence_score: 80, provenance: "manual_guide" });
    expect(d.quick_sale_cents).toBe(Math.round(999 * 0.8)); // 799
    expect(d.replacement_cents).toBe(Math.round(999 * 1.1)); // 1099
  });

  it("labels an operator-entered guide Manual even when a product was previously linked", () => {
    const d = deriveValuation({ guide_cents: 4250, confidence_score: 99, provenance: "manual_guide" });
    expect(d.confidence).toBe("manual");
    expect(d.provenance).toBe("manual_guide");
    expect(d.method).toMatch(/Operator-entered guide/);
  });
});
