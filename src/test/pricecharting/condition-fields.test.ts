import { describe, it, expect } from "vitest";
import { buildAvailableValues, getValueForRequestedGrade } from "@/lib/pricecharting/grade-mapping";
import { normalizeProduct, CONDITION_FIELD_RE } from "@/lib/pricecharting/product";
import type { Product, RawProduct } from "@/lib/pricecharting/types";

function product(prices: Record<string, number>): Product {
  return {
    pricecharting_id: "P",
    name: "Test Card #1",
    console_or_category: "Pokemon Cards",
    release_date: null,
    upc: null,
    asin: null,
    epid: null,
    genre: null,
    raw_prices: prices,
  };
}

describe("condition-NN field → tier mapping (one authoritative map)", () => {
  it("(10) condition-19-price maps to CGC 10 Pristine", () => {
    expect(buildAvailableValues(product({ "condition-19-price": 4539 }), "card").cgc_10_pristine).toBe(45.39);
    const r = getValueForRequestedGrade(product({ "condition-19-price": 4539 }), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.field_used).toBe("condition-19-price");
    expect(r.selected_tier_key).toBe("cgc_10_pristine");
    expect(r.designation_exact).toBe(true);
  });

  it("(11) condition-20-price maps to BGS 10 Black Label (distinct exact tier)", () => {
    expect(buildAvailableValues(product({ "condition-20-price": 98400 }), "card").bgs_10_black_label).toBe(984);
    const r = getValueForRequestedGrade(product({ "condition-20-price": 98400 }), "BGS", 10, { category: "card", designation: "Black Label" });
    expect(r.field_used).toBe("condition-20-price");
    expect(r.selected_tier_key).toBe("bgs_10_black_label");
    expect(r.designation_exact).toBe(true);
  });

  it("(12) condition-21-price maps to TAG 10", () => {
    expect(buildAvailableValues(product({ "condition-21-price": 5000 }), "card").tag_10).toBe(50);
  });

  it("(13) condition-22-price maps to ACE 10", () => {
    expect(buildAvailableValues(product({ "condition-22-price": 3000 }), "card").ace_10).toBe(30);
  });

  it("keeps every grade-10 tier distinct — no cross-substitution", () => {
    const vals = buildAvailableValues(
      product({
        "manual-only-price": 10000, // PSA 10
        "bgs-10-price": 20000, // BGS 10
        "condition-17-price": 2100, // CGC 10
        "condition-18-price": 1800, // SGC 10
        "condition-19-price": 4539, // CGC 10 Pristine
        "condition-20-price": 98400, // BGS 10 Black Label
      }),
      "card",
    );
    expect(new Set([vals.psa_10, vals.bgs_10, vals.cgc_10, vals.sgc_10, vals.cgc_10_pristine, vals.bgs_10_black_label]).size).toBe(6);
  });
});

describe("(14) future condition-NN fields are preserved but never invented as tiers", () => {
  it("preserves an unmapped condition-23-price in raw_prices", () => {
    const raw: RawProduct = { id: "P", "product-name": "Test", "condition-23-price": 12345 };
    const p = normalizeProduct(raw);
    expect(p.raw_prices["condition-23-price"]).toBe(12345); // NOT dropped
  });

  it("does not surface an unknown condition field as any known card tier", () => {
    const vals = buildAvailableValues(product({ "condition-23-price": 12345 }), "card");
    // None of the mapped tiers pick up the unknown field's value.
    expect(Object.values(vals)).not.toContain(123.45);
    expect(Object.values(vals)).not.toContain(12345);
  });

  it("never selects an unknown condition field as an exact tier", () => {
    const r = getValueForRequestedGrade(product({ "condition-23-price": 12345 }), "CGC", 10, { category: "card" });
    expect(r.field_used).not.toBe("condition-23-price");
  });

  it("the condition-field matcher recognizes the whole family", () => {
    expect(CONDITION_FIELD_RE.test("condition-19-price")).toBe(true);
    expect(CONDITION_FIELD_RE.test("condition-23-price")).toBe(true);
    expect(CONDITION_FIELD_RE.test("condition-100-price")).toBe(true);
    expect(CONDITION_FIELD_RE.test("loose-price")).toBe(false);
  });
});
