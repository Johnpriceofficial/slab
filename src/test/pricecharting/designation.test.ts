import { describe, it, expect } from "vitest";
import { getValueForRequestedGrade, normalizeDesignation } from "@/lib/pricecharting/grade-mapping";
import type { Product } from "@/lib/pricecharting/types";

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

describe("§2/§5 designation-aware tier selection", () => {
  it("CGC 10 + Pristine → ordinary CGC 10 value, NOT designation-exact, with a warning (never a fake Pristine tier)", () => {
    const r = getValueForRequestedGrade(product({ "condition-17-price": 4539 }), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.value_pennies).toBe(4539);
    expect(r.selected_tier_key).toBe("cgc_10");
    expect(r.selected_tier_label).toBe("CGC 10"); // NOT "CGC 10 Pristine"
    expect(r.designation_requested).toBe("PRISTINE");
    expect(r.designation_exact).toBe(false);
    expect(r.warnings.join()).toMatch(/does not distinguish "PRISTINE"/i);
  });

  it("CGC 10 + Gem Mint → designation-exact (CGC 10 == Gem Mint 10)", () => {
    const r = getValueForRequestedGrade(product({ "condition-17-price": 2174 }), "CGC", 10, { category: "card", designation: "GEM MINT" });
    expect(r.designation_exact).toBe(true);
    expect(r.selected_tier_key).toBe("cgc_10");
  });

  it("CGC 10 + no designation → designation-exact", () => {
    const r = getValueForRequestedGrade(product({ "condition-17-price": 2174 }), "CGC", 10, { category: "card" });
    expect(r.designation_exact).toBe(true);
  });

  it("never marks designation-exact when the tier value is null (missing, not $0)", () => {
    const r = getValueForRequestedGrade(product({}), "CGC", 10, { category: "card", designation: "GEM MINT" });
    expect(r.value_pennies).toBeNull();
    expect(r.designation_exact).toBe(false);
    expect(r.selected_tier_key).toBeNull();
  });

  it("normalizeDesignation maps the known designations", () => {
    expect(normalizeDesignation("PRISTINE")).toBe("pristine");
    expect(normalizeDesignation("Gem Mint 10")).toBe("gem_mint");
    expect(normalizeDesignation("PERFECT")).toBe("perfect");
    expect(normalizeDesignation("")).toBeNull();
    expect(normalizeDesignation(null)).toBeNull();
  });
});
