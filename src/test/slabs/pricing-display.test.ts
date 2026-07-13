import { describe, it, expect } from "vitest";
import { buildPricingModel, type PricingInputs } from "@/lib/slabs/pricing-display";

// A plain CGC 10 slab whose value came from the exact CGC 10 tier.
const exactBase: PricingInputs = {
  final_cents: 2174,
  guide_cents: 2174,
  quick_cents: 1739,
  replacement_cents: 2391,
  valuation_confidence: "verified",
  price_variance_percent: 0,
  grader: "CGC",
  grade: "10",
  grade_label: null,
  product_name: "Rayquaza VMAX #047",
  product_id: "3472875",
};

// The Charmander CGC 10 Pristine slab whose value came from the ORDINARY CGC 10
// tier — the connected API has no distinct Pristine field.
const pristineBase: PricingInputs = {
  final_cents: 4250,
  guide_cents: 4250,
  quick_cents: 3400,
  replacement_cents: 4675,
  valuation_confidence: "high",
  price_variance_percent: 0,
  grader: "CGC",
  grade: "10",
  grade_label: "PRISTINE",
  product_name: "Charmander #289/S-P",
  product_id: "5427932",
};

describe("buildPricingModel — exact tier (plain CGC 10)", () => {
  it("is an Exact Match with the exact-tier basis and the spec note", () => {
    const m = buildPricingModel(exactBase);
    expect(m.match_kind).toBe("exact");
    expect(m.exact_match).toBe(true);
    expect(m.basis_label).toBe("CGC 10 — Exact PriceCharting Tier");
    expect(m.confidence_label).toBe("Verified");
    expect(m.method_label).toBe("Exact graded-price match");
    expect(m.note).toContain("Rayquaza VMAX #047");
    expect(m.note).toContain("exact CGC 10 guide tier of $21.74");
    expect(m.note).toMatch(/not a confirmed last-sold transaction/);
  });

  it("synthesizes the exact-tier row for the grade table when no per-tier map is stored", () => {
    const m = buildPricingModel(exactBase);
    const exact = m.grade_rows.find((r) => r.kind === "exact");
    expect(exact).toBeTruthy();
    expect(exact!.label).toBe("CGC 10");
    expect(exact!.cents).toBe(2174);
    expect(exact!.muted).toBe(false);
  });
});

describe("buildPricingModel — CGC 10 Pristine valued off ordinary CGC 10 is COMPATIBLE, never exact/Verified", () => {
  it("is a Compatible match, not an Exact Match, with a designation warning", () => {
    const m = buildPricingModel(pristineBase);
    expect(m.match_kind).toBe("compatible");
    expect(m.exact_match).toBe(false);
    expect(m.basis_label).toMatch(/CGC 10 Pristine — Compatible CGC 10 value/);
    expect(m.method_label).toMatch(/Compatible tier — CGC 10/);
    expect(m.note).toContain("Charmander #289/S-P");
    expect(m.note).toMatch(/does not distinguish/i);
    expect(m.note).toMatch(/not an exact/i);
    expect(m.note).toMatch(/not a confirmed last-sold transaction/);
  });

  it("never displays Verified for a compatible basis — downgrades a stale verified confidence", () => {
    const m = buildPricingModel({ ...pristineBase, valuation_confidence: "verified" });
    expect(m.match_kind).toBe("compatible");
    expect(m.confidence_label).not.toBe("Verified");
  });

  it("highlights the ordinary CGC 10 tier as the compatible basis (never labelled Pristine)", () => {
    const m = buildPricingModel(pristineBase);
    const basis = m.grade_rows.find((r) => r.kind === "compatible");
    expect(basis).toBeTruthy();
    expect(basis!.cents).toBe(4250);
    expect(basis!.muted).toBe(false);
    expect(basis!.note).toMatch(/designation not distinguished/i);
    expect(m.grade_rows.some((r) => r.kind === "exact")).toBe(false);
  });

  it("promotes to Exact ONLY when the source genuinely supplies the Pristine tier (designation_exact)", () => {
    const m = buildPricingModel({ ...pristineBase, designation_exact: true });
    expect(m.match_kind).toBe("exact");
    expect(m.basis_label).toBe("CGC 10 Pristine — Exact PriceCharting Tier");
  });
});

describe("buildPricingModel — grade table classification (never interchangeable / never averaged)", () => {
  it("labels ungraded as raw reference, other graders' 10s as comparison, and highlights the exact tier", () => {
    const m = buildPricingModel({
      ...exactBase,
      available_values_cents: {
        ungraded: 413,
        grade_9_general: 2174,
        cgc_10: 2174, // exact for this plain CGC 10 slab
        psa_10: 6658,
        bgs_10: 8700,
      },
    });
    const byKey = Object.fromEntries(m.grade_rows.map((r) => [r.key, r]));
    expect(byKey.ungraded.kind).toBe("raw_reference");
    expect(byKey.ungraded.note).toBe("Raw-card reference only");
    expect(byKey.cgc_10.kind).toBe("exact"); // the slab's own tier
    expect(byKey.cgc_10.label).toBe("CGC 10");
    expect(byKey.psa_10.note).toBe("Comparison only");
    expect(byKey.bgs_10.note).toBe("Comparison only");
    // Exactly one exact row — never a blended/averaged figure.
    expect(m.grade_rows.filter((r) => r.kind === "exact")).toHaveLength(1);
  });

  it("does NOT mark PSA 10 as exact for a CGC slab (never interchangeable)", () => {
    const m = buildPricingModel({ ...exactBase, available_values_cents: { psa_10: 6658, cgc_10: 2174 } });
    const psa = m.grade_rows.find((r) => r.key === "psa_10");
    expect(psa!.kind).toBe("comparison");
    expect(psa!.muted).toBe(true);
  });
});

describe("buildPricingModel — value-source priority states", () => {
  it("estimated: a comparison tier stands in for a missing exact tier", () => {
    const m = buildPricingModel({ ...exactBase, valuation_confidence: "probable", comparison_tier_label: "CGC 9.5" });
    expect(m.match_kind).toBe("estimated");
    expect(m.exact_match).toBe(false);
    expect(m.basis_label).toBe("CGC 10 — Estimated from CGC 9.5");
    expect(m.method_label).toMatch(/Estimated from CGC 9.5/);
    expect(m.note).toMatch(/ESTIMATED from CGC 9.5/);
  });

  it("manual: a final value but no guide tier", () => {
    const m = buildPricingModel({ ...exactBase, guide_cents: null, valuation_confidence: "manual" });
    expect(m.match_kind).toBe("manual");
    expect(m.basis_label).toBe("Manual valuation");
  });

  it("unavailable: no final and no guide → null figures, not $0", () => {
    const m = buildPricingModel({
      ...exactBase,
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
