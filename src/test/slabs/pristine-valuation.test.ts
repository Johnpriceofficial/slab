import { describe, it, expect } from "vitest";
import { deriveValuationProvenance } from "@/lib/slabs/valuation-provenance";
import { deriveValuation } from "@/lib/slabs/valuation-derive";

describe("valuation reject-invariant — a graded slab is never priced as raw", () => {
  it("(6) a graded slab that fell through to loose-price resolves to tier_unavailable, not a raw price", () => {
    const prov = deriveValuationProvenance({
      value_cents: 500, // the ungraded $5 loose-price
      grader_present: true,
      field_used: "loose-price",
    });
    expect(prov).toBe("tier_unavailable");
  });

  it("(7) an ungraded source tier can never be labeled grader-compatible", () => {
    const prov = deriveValuationProvenance({
      value_cents: 500,
      grader_present: true,
      selected_tier_key: "ungraded",
      designation_exact: false,
    });
    expect(prov).not.toBe("pricecharting_compatible_tier");
    expect(prov).toBe("tier_unavailable");
  });

  it("classifies a real exact designation tier as exact, and a real ordinary tier as compatible", () => {
    expect(
      deriveValuationProvenance({ value_cents: 4539, grader_present: true, field_used: "condition-19-price", designation_exact: true }),
    ).toBe("pricecharting_exact_tier");
    expect(
      deriveValuationProvenance({ value_cents: 2100, grader_present: true, field_used: "condition-17-price", designation_exact: false }),
    ).toBe("pricecharting_compatible_tier");
  });

  it("still returns the ungraded value for a genuinely RAW card (no grader)", () => {
    expect(deriveValuationProvenance({ value_cents: 500, grader_present: false, field_used: "loose-price" })).not.toBe("tier_unavailable");
  });
});

describe("derived values + confidence for the exact CGC Pristine tier", () => {
  it("(10) 4539 cents → final 4539, quick-sale 3631, replacement 4993", () => {
    const d = deriveValuation({
      guide_cents: 4539,
      confidence_score: 95,
      provenance: "pricecharting_exact_tier",
      field_meaning: "CGC 10 Pristine",
      identity_confirmed: true,
    });
    expect(d.suggested_final_cents).toBe(4539);
    expect(d.quick_sale_cents).toBe(3631); // round(4539 * 0.8)
    expect(d.replacement_cents).toBe(4993); // round(4539 * 1.1)
  });

  it("(11) an exact PriceCharting tier with confirmed identity yields High confidence", () => {
    const d = deriveValuation({
      guide_cents: 4539,
      confidence_score: 95,
      provenance: "pricecharting_exact_tier",
      field_meaning: "CGC 10 Pristine",
      identity_confirmed: true,
    });
    expect(d.confidence).toBe("high");
    expect(d.method).toMatch(/exact PriceCharting tier \(CGC 10 Pristine\)/i);
  });

  it("tier_unavailable provenance leaves values blank rather than pricing as raw", () => {
    const d = deriveValuation({ guide_cents: null, confidence_score: 95, provenance: "tier_unavailable" });
    expect(d.suggested_final_cents).toBeNull();
    expect(d.availability).toBe("tier_unavailable");
  });
});
