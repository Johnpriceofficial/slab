import { describe, it, expect } from "vitest";
import {
  resolveRefreshProduct,
  buildRefreshScalars,
  type RefreshSearch,
  type RefreshValue,
} from "@/lib/slabs/pricing-refresh";

const search = (over: Partial<RefreshSearch> = {}): RefreshSearch => ({
  requires_confirmation: false,
  auto_confirmed_product_id: "P1",
  candidates: [{ product_id: "P1", match_status: "exact" }],
  ...over,
});

const value = (over: Partial<RefreshValue> = {}): RefreshValue => ({
  product_id: "5427932",
  product_name: "Charmander #289/S-P",
  grade_field: "condition-17-price",
  guide_value_cents: 4250,
  sales_volume: 3,
  ...over,
});

describe("resolveRefreshProduct", () => {
  it("re-values the already-confirmed product directly (never re-searches)", () => {
    const r = resolveRefreshProduct("5427932", "exact", null);
    expect(r).toEqual({ kind: "product", product_id: "5427932", match_status: "exact" });
  });

  it("uses an auto-confirmed search result when no product is stored", () => {
    const r = resolveRefreshProduct(null, null, search({ auto_confirmed_product_id: "P1" }));
    expect(r).toEqual({ kind: "product", product_id: "P1", match_status: "exact" });
  });

  it("defers to manual confirmation when the search is ambiguous", () => {
    const r = resolveRefreshProduct(null, null, search({ requires_confirmation: true, auto_confirmed_product_id: null }));
    expect(r.kind).toBe("needs_confirmation");
  });

  it("reports no_product when nothing is stored and the search found nothing", () => {
    const r = resolveRefreshProduct(null, null, search({ requires_confirmation: true, auto_confirmed_product_id: null, candidates: [] }));
    expect(r.kind).toBe("no_product");
  });
});

describe("buildRefreshScalars — no data loss, atomic-write payload", () => {
  const current = (over: Partial<{ final_value_cents: number | null; pricecharting_value_cents: number | null; visual_confirmation_status: string | null; valuation_provenance: "pricecharting_exact_tier" | "manual_guide" | "tier_unavailable" }> = {}) => ({
    final_value_cents: 4250,
    pricecharting_value_cents: 4250,
    visual_confirmation_status: null,
    valuation_provenance: "pricecharting_exact_tier" as const,
    ...over,
  });

  it("sets apply_value + guide + variance when the API HAS a value for the grade", () => {
    const scalars = buildRefreshScalars(current(), value({ guide_value_cents: 5000, designation_exact: true }), "exact");
    expect(scalars.apply_value).toBe(true);
    expect(scalars.value_cents).toBe(5000);
    // variance of the operator's final ($42.50) against the new guide ($50.00)
    expect(scalars.variance).toBe(-15); // (4250-5000)/5000 = -15%
    expect(scalars.product_id).toBe("5427932");
    expect(scalars.sales_volume).toBe(3);
    expect(scalars.match_status).toBe("exact");
    expect(scalars.valuation_provenance).toBe("pricecharting_exact_tier");
    expect(scalars.valuation_confidence).toBe("high");
  });

  it("apply_value=false when the API has no value — the DB then PRESERVES a hand-entered guide", () => {
    // The Charmander: operator entered $42.50; the API has no CGC-10 tier (null).
    const scalars = buildRefreshScalars(current(), value({ guide_value_cents: null }), "exact");
    expect(scalars.apply_value).toBe(false); // DB keeps the existing value + variance
    expect(scalars.value_cents).toBeNull();
    expect(scalars.variance).toBeNull();
    // Provenance fields still refresh.
    expect(scalars.product_name).toBe("Charmander #289/S-P");
    expect(scalars.grade_field).toBe("condition-17-price");
  });

  it("carries no Final / Quick-Sale / Replacement key; confidence/provenance update atomically", () => {
    const scalars = buildRefreshScalars(current(), value({ designation_exact: false }), "exact");
    expect("final_value_cents" in scalars).toBe(false);
    expect("quick_sale_value_cents" in scalars).toBe(false);
    expect("replacement_value_cents" in scalars).toBe(false);
    expect(scalars.valuation_provenance).toBe("pricecharting_compatible_tier");
    expect(scalars.valuation_confidence).toBe("moderate");
  });

  it("variance is null when there is no final value even if the guide is present", () => {
    const scalars = buildRefreshScalars(current({ final_value_cents: null }), value({ guide_value_cents: 5000 }), "exact");
    expect(scalars.apply_value).toBe(true);
    expect(scalars.value_cents).toBe(5000);
    expect(scalars.variance).toBeNull();
  });

  it("records true unavailability separately from confidence", () => {
    const scalars = buildRefreshScalars(
      current({ final_value_cents: null, pricecharting_value_cents: null }),
      value({ guide_value_cents: null }),
      "exact",
    );
    expect(scalars.valuation_provenance).toBe("tier_unavailable");
    expect(scalars.valuation_confidence).toBeNull();
  });

  it("never overwrites a manual guide/provenance during background refresh", () => {
    const scalars = buildRefreshScalars(
      current({ valuation_provenance: "manual_guide" }),
      value({ guide_value_cents: 9999, designation_exact: true }),
      "exact",
    );
    expect(scalars.apply_value).toBe(false);
    expect(scalars.apply_provenance).toBe(false);
    expect(scalars.valuation_provenance).toBeNull();
  });
});
