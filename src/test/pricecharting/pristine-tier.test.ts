import { describe, it, expect } from "vitest";
import { getValueForRequestedGrade } from "@/lib/pricecharting/grade-mapping";
import { buildPriceTiers } from "@/lib/slabs/pricing-tiers";
import type { Product } from "@/lib/pricecharting/types";

// A product carrying the real Rayquaza VMAX tier set, INCLUDING the previously
// dropped condition-19-price (CGC 10 Pristine). No product id or value is
// hardcoded into the mapping — the fixture supplies them.
function product(prices: Record<string, number>): Product {
  return {
    pricecharting_id: "P",
    name: "Rayquaza VMAX #47",
    console_or_category: "Pokemon Japanese Blue Sky Stream",
    release_date: null,
    upc: null,
    asin: null,
    epid: null,
    genre: null,
    raw_prices: prices,
  };
}

const FULL = {
  "loose-price": 500, // Ungraded $5.00
  "graded-price": 3908, // Grade 9
  "box-only-price": 4300, // Grade 9.5
  "condition-17-price": 2100, // CGC 10 (ordinary) $21.00
  "condition-19-price": 4539, // CGC 10 Pristine $45.39
  "manual-only-price": 10463, // PSA 10
  "bgs-10-price": 19678, // BGS 10
};

describe("CGC 10 Pristine — exact tier via condition-19-price", () => {
  it("(9) CGC / 10 / PRISTINE selects the exact CGC Pristine tier at 4539 cents", () => {
    const r = getValueForRequestedGrade(product(FULL), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.field_used).toBe("condition-19-price");
    expect(r.value_pennies).toBe(4539);
    expect(r.selected_tier_key).toBe("cgc_10_pristine");
    expect(r.selected_tier_label).toBe("CGC 10 Pristine");
    expect(r.designation_exact).toBe(true);
  });

  it("(8/12) keeps ordinary CGC 10 and CGC 10 Pristine DISTINCT — never substitutes one for the other", () => {
    const pristine = getValueForRequestedGrade(product(FULL), "CGC", 10, { category: "card", designation: "PRISTINE" });
    const ordinary = getValueForRequestedGrade(product(FULL), "CGC", 10, { category: "card" });
    expect(pristine.value_pennies).toBe(4539); // condition-19
    expect(ordinary.value_pennies).toBe(2100); // condition-17
    expect(pristine.value_pennies).not.toBe(ordinary.value_pennies);
    expect(ordinary.selected_tier_key).toBe("cgc_10");
  });

  it("(13) never uses PSA 10 or BGS 10 for CGC Pristine", () => {
    const r = getValueForRequestedGrade(product(FULL), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.value_pennies).not.toBe(FULL["manual-only-price"]); // not PSA 10
    expect(r.value_pennies).not.toBe(FULL["bgs-10-price"]); // not BGS 10
  });

  it("(16) a Pristine request with NO condition-19 field falls back to COMPATIBLE ordinary CGC 10, never a fabricated Pristine value", () => {
    const noPristine = { ...FULL };
    delete (noPristine as Record<string, number>)["condition-19-price"];
    const r = getValueForRequestedGrade(product(noPristine), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.field_used).toBe("condition-17-price"); // ordinary CGC 10
    expect(r.value_pennies).toBe(2100);
    expect(r.designation_exact).toBe(false); // compatible, not exact
    expect(r.warnings.join()).toMatch(/does not distinguish/i);
  });

  it("(16) leaves the CGC Pristine tier null (never $0, never synthesized) when the source omits it", () => {
    const noPristine = { "condition-17-price": 2100 };
    const tiers = buildPriceTiers(
      { cgc_10: 2100 }, // cents map with ordinary CGC 10 only, no cgc_10_pristine
      { grader: "CGC", grade: "10", grade_label: "Pristine" },
    );
    const pristineTier = tiers.find((t) => t.tier === "cgc_10_pristine");
    expect(pristineTier).toBeDefined(); // shown as the slab's exact tier...
    expect(pristineTier!.value_cents).toBeNull(); // ...but honestly unavailable
    void noPristine;
  });

  it("surfaces a distinct cgc_10_pristine tier value when the source supplies it", () => {
    const tiers = buildPriceTiers(
      { cgc_10: 2100, cgc_10_pristine: 4539 },
      { grader: "CGC", grade: "10", grade_label: "Pristine" },
    );
    const pristine = tiers.find((t) => t.tier === "cgc_10_pristine")!;
    const ordinary = tiers.find((t) => t.tier === "cgc_10")!;
    expect(pristine.value_cents).toBe(4539);
    expect(pristine.exact_match).toBe(true); // the slab's own exact tier
    expect(ordinary.value_cents).toBe(2100);
    expect(ordinary.exact_match).toBe(false); // never the Pristine slab's exact tier
  });
});
