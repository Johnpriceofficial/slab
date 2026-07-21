/**
 * Regression for the P0.1 finding, verified against production record
 * 3455aa7b-a727-4814-91eb-9a3dd6f17846 (slab S0001, Charmander): a
 * manually-typed number stored in pricecharting_value_cents is otherwise
 * indistinguishable, in the on-screen inventory table, from a real
 * PriceCharting-sourced figure. The data model itself was already correct
 * (valuation_provenance is a proper NOT NULL discriminator, and
 * EXCEL_MASTER_COLUMNS already exports it) -- this closes the gap in the
 * on-screen INVENTORY_TABLE_COLUMNS, which lacked it.
 */
import { describe, it, expect } from "vitest";
import { INVENTORY_TABLE_COLUMNS, EXCEL_MASTER_COLUMNS } from "@/lib/slabs/constants";
import { buildPricingModel } from "@/lib/slabs/pricing-display";

describe("INVENTORY_TABLE_COLUMNS — PriceCharting Value must never appear without its discriminator", () => {
  it("includes a valuation_provenance column, same as EXCEL_MASTER_COLUMNS already did", () => {
    const keys = INVENTORY_TABLE_COLUMNS.map((c) => c.key);
    expect(keys).toContain("valuation_provenance");
    expect(keys).toContain("pricecharting_value_cents");
  });

  it("places Valuation Provenance immediately after Valuation Confidence, matching the Excel Master convention", () => {
    const keys = INVENTORY_TABLE_COLUMNS.map((c) => c.key);
    const confidenceIdx = keys.indexOf("valuation_confidence");
    const provenanceIdx = keys.indexOf("valuation_provenance");
    expect(provenanceIdx).toBe(confidenceIdx + 1);
  });

  it("EXCEL_MASTER_COLUMNS still carries valuation_provenance (unchanged, was already correct)", () => {
    expect(EXCEL_MASTER_COLUMNS.map((c) => c.key)).toContain("valuation_provenance");
  });
});

describe("buildPricingModel — manual valuations must be labelable as manual, not PriceCharting-sourced", () => {
  it("reports match_kind 'manual' for a manually-entered guide value with no confirmed product", () => {
    const model = buildPricingModel({
      final_cents: 4250,
      guide_cents: 4250,
      quick_cents: 3400,
      replacement_cents: 4675,
      valuation_confidence: "moderate",
      valuation_provenance: "manual_guide",
      price_variance_percent: 0,
      grader: "CGC",
      grade: "10",
      grade_label: "PRISTINE",
      product_name: null,
      product_id: null,
    });
    expect(model.match_kind).toBe("manual");
    expect(model.basis_label).toMatch(/manual/i);
  });

  it("reports a non-manual match_kind when the value came from a confirmed PriceCharting tier", () => {
    const model = buildPricingModel({
      final_cents: 12000,
      guide_cents: 12000,
      quick_cents: 9600,
      replacement_cents: 13200,
      valuation_confidence: "high",
      valuation_provenance: "pricecharting_exact_tier",
      price_variance_percent: 0,
      grader: "PSA",
      grade: "10",
      grade_label: null,
      product_name: "Some Card",
      product_id: "123",
      designation_exact: true,
    });
    expect(model.match_kind).not.toBe("manual");
  });
});
