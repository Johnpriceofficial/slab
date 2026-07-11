import { describe, it, expect } from "vitest";
import { centsToDollars, dollarsToCents, centsToInputString, extensionFor } from "@/lib/slabs/format";
import { computeDashboardStats, priceVariancePercent } from "@/lib/slabs/compute-stats";
import type { Slab } from "@/lib/slabs/types";

describe("format — currency conversion", () => {
  it("converts cents to dollars and back without float error", () => {
    expect(centsToDollars(42995)).toBe(429.95);
    expect(dollarsToCents("429.95")).toBe(42995);
    expect(dollarsToCents("$1,299.95")).toBe(129995);
    expect(dollarsToCents(10)).toBe(1000);
  });

  it("preserves null and zero distinctly", () => {
    expect(centsToDollars(null)).toBeNull();
    expect(centsToDollars(0)).toBe(0);
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("0")).toBe(0);
  });

  it("centsToInputString formats for editable fields", () => {
    expect(centsToInputString(12500)).toBe("125.00");
    expect(centsToInputString(null)).toBe("");
  });

  it("derives image extensions from name or mime", () => {
    expect(extensionFor("front.HEIC")).toBe("heic");
    expect(extensionFor("noext", "image/png")).toBe("png");
    expect(extensionFor("noext")).toBe("jpg");
  });
});

function slab(over: Partial<Slab>): Slab {
  return {
    id: "x",
    inventory_number: 1,
    card_name: "C",
    final_value_cents: null,
    quick_sale_value_cents: null,
    replacement_value_cents: null,
    grader: null,
    grade: null,
    grade_label: null,
    certification_number: null,
    set_name: null,
    card_number: null,
    year: null,
    language: null,
    rarity: null,
    variation: null,
    label_description: null,
    label_accuracy: null,
    verification_status: null,
    valuation_confidence: null,
    duplicate_status: null,
    pricecharting_product_id: null,
    pricecharting_product_name: null,
    pricecharting_grade_field: null,
    pricecharting_value_cents: null,
    pricecharting_sales_volume: null,
    pricecharting_match_status: null,
    price_variance_percent: null,
    front_image_path: null,
    back_image_path: null,
    notes: null,
    date_valued: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...over,
  };
}

describe("compute-stats — dashboard totals from stored cents", () => {
  it("computes totals, average, median, and highest from integer cents", () => {
    const slabs = [
      slab({ inventory_number: 1, final_value_cents: 10000, grader: "PSA", grade: "9", language: "English" }),
      slab({ inventory_number: 2, final_value_cents: 20000, grader: "PSA", grade: "10", language: "Japanese" }),
      slab({ inventory_number: 3, final_value_cents: 30000, grader: "CGC", grade: "9", language: "English" }),
    ];
    const s = computeDashboardStats(slabs);
    expect(s.total_slabs).toBe(3);
    expect(s.total_final_value_cents).toBe(60000);
    expect(s.average_value_cents).toBe(20000);
    expect(s.median_value_cents).toBe(20000);
    expect(s.highest_value_slab?.inventory_number).toBe(3);
    expect(s.count_by_grader).toEqual({ PSA: 2, CGC: 1 });
    expect(s.count_by_language).toEqual({ English: 2, Japanese: 1 });
  });

  it("counts image/label/duplicate flags", () => {
    const slabs = [
      slab({ verification_status: "needs_clearer_images" }),
      slab({ verification_status: "label_error" }),
      slab({ label_accuracy: "possible_error" }),
      slab({ duplicate_status: "duplicate_attempt" }),
    ];
    const s = computeDashboardStats(slabs);
    expect(s.count_needs_clearer_images).toBe(1);
    expect(s.count_possible_label_errors).toBe(2); // label_error status + possible_error accuracy
    expect(s.count_duplicate_attempts).toBe(1);
  });

  it("returns null median for an empty inventory (no divide-by-zero)", () => {
    const s = computeDashboardStats([]);
    expect(s.median_value_cents).toBeNull();
    expect(s.average_value_cents).toBeNull();
    expect(s.total_final_value_cents).toBe(0);
  });

  it("computes price variance percent, null when guide is zero/absent", () => {
    expect(priceVariancePercent(15000, 10000)).toBe(50);
    expect(priceVariancePercent(10000, 0)).toBeNull();
    expect(priceVariancePercent(null, 10000)).toBeNull();
  });
});
