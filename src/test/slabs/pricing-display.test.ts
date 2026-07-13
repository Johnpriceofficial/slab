import { describe, it, expect } from "vitest";
import { buildPricingModel, type PricingInputs } from "@/lib/slabs/pricing-display";

const base: PricingInputs = {
  final_cents: 4250,
  guide_cents: 4250,
  quick_cents: 3400,
  replacement_cents: 4675,
  valuation_confidence: "verified",
  price_variance_percent: 0,
  grader: "CGC",
  grade: "10",
  grade_label: "PRISTINE",
  product_name: "Charmander #289/S-P",
  product_id: "5427932",
};

describe("buildPricingModel — the Charmander CGC 10 Pristine flagship", () => {
  it("is an Exact Match with the exact-tier basis and the spec note", () => {
    const m = buildPricingModel(base);
    expect(m.match_kind).toBe("exact");
    expect(m.exact_match).toBe(true);
    expect(m.basis_label).toBe("CGC 10 Pristine — Exact PriceCharting Tier");
    expect(m.confidence_label).toBe("Verified");
    expect(m.method_label).toBe("Exact graded-price match");
    expect(m.variance_percent).toBe(0);
    expect(m.note).toContain("Charmander #289/S-P");
    expect(m.note).toContain("PriceCharting ID 5427932");
    expect(m.note).toContain("exact CGC 10 Pristine guide tier of $42.50");
    expect(m.note).toMatch(/not a confirmed last-sold transaction/);
  });

  it("synthesizes the exact-tier row for the grade table when no per-tier map is stored", () => {
    const m = buildPricingModel(base);
    const exact = m.grade_rows.find((r) => r.kind === "exact");
    expect(exact).toBeTruthy();
    expect(exact!.label).toBe("CGC 10 Pristine");
    expect(exact!.cents).toBe(4250);
    expect(exact!.muted).toBe(false);
  });
});

describe("buildPricingModel — grade table classification (never interchangeable / never averaged)", () => {
  it("labels ungraded as raw reference, other graders' 10s as comparison, and highlights the exact tier", () => {
    const m = buildPricingModel({
      ...base,
      available_values_cents: {
        ungraded: 413,
        grade_9_general: 2174,
        cgc_10: 4250, // exact for this CGC 10 slab
        psa_10: 6658,
        bgs_10: 8700,
      },
    });
    const byKey = Object.fromEntries(m.grade_rows.map((r) => [r.key, r]));
    expect(byKey.ungraded.kind).toBe("raw_reference");
    expect(byKey.ungraded.note).toBe("Raw-card reference only");
    expect(byKey.cgc_10.kind).toBe("exact"); // the slab's own tier
    expect(byKey.cgc_10.label).toBe("CGC 10 Pristine");
    expect(byKey.psa_10.note).toBe("Comparison only");
    expect(byKey.bgs_10.note).toBe("Comparison only");
    // Exactly one exact row — never a blended/averaged figure.
    expect(m.grade_rows.filter((r) => r.kind === "exact")).toHaveLength(1);
  });

  it("does NOT mark PSA 10 as exact for a CGC slab (never interchangeable)", () => {
    const m = buildPricingModel({ ...base, available_values_cents: { psa_10: 6658, cgc_10: 4250 } });
    const psa = m.grade_rows.find((r) => r.key === "psa_10");
    expect(psa!.kind).toBe("comparison");
    expect(psa!.muted).toBe(true);
  });
});

describe("buildPricingModel — value-source priority states", () => {
  it("estimated: a comparison tier stands in for a missing exact tier", () => {
    const m = buildPricingModel({ ...base, valuation_confidence: "probable", comparison_tier_label: "CGC 10" });
    expect(m.match_kind).toBe("estimated");
    expect(m.exact_match).toBe(false);
    expect(m.basis_label).toBe("CGC 10 Pristine — Estimated from CGC 10");
    expect(m.method_label).toMatch(/Estimated from CGC 10/);
    expect(m.note).toMatch(/ESTIMATED from CGC 10/);
  });

  it("manual: a final value but no guide tier", () => {
    const m = buildPricingModel({ ...base, guide_cents: null, valuation_confidence: "manual" });
    expect(m.match_kind).toBe("manual");
    expect(m.basis_label).toBe("Manual valuation");
  });

  it("unavailable: no final and no guide → null figures, not $0", () => {
    const m = buildPricingModel({
      ...base,
      final_cents: null,
      guide_cents: null,
      quick_cents: null,
      replacement_cents: null,
      valuation_confidence: null,
    });
    expect(m.match_kind).toBe("unavailable");
    expect(m.unavailable).toBe(true);
    expect(m.confidence_label).toBe("—");
    expect(m.basis_label).toBe("Guide value unavailable");
    expect(m.final_cents).toBeNull();
    expect(m.grade_rows).toHaveLength(0); // nothing to compare
  });
});
