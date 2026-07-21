/**
 * Regression for the P0.1 finding, verified against production record
 * 3455aa7b-a727-4814-91eb-9a3dd6f17846 (slab S0001, Charmander): a
 * manually-typed number stored in pricecharting_value_cents was otherwise
 * indistinguishable, in the on-screen inventory table, from a real
 * PriceCharting-sourced figure. The data model itself was already correct
 * (valuation_provenance is a proper NOT NULL discriminator, and
 * EXCEL_MASTER_COLUMNS already exported it) -- this closes the gap in the
 * on-screen INVENTORY_TABLE_COLUMNS, which lacked a raw, auditable
 * provenance column (the inline (manual)/(compatible)/(estimate) marker on
 * the Guide Value cell itself is covered separately in
 * guide-value-marker.test.ts).
 */
import { describe, it, expect } from "vitest";
import { INVENTORY_TABLE_COLUMNS, EXCEL_MASTER_COLUMNS } from "@/lib/slabs/constants";

describe("INVENTORY_TABLE_COLUMNS — the guide value column is never shown without an auditable source", () => {
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

  it("the guide-value column itself is labeled source-neutrally, not \"PriceCharting Value\"", () => {
    const inventoryCol = INVENTORY_TABLE_COLUMNS.find((c) => c.key === "pricecharting_value_cents");
    expect(inventoryCol?.label).toBe("Guide Value");
    const excelCol = EXCEL_MASTER_COLUMNS.find((c) => c.key === "pricecharting_value_cents");
    expect(excelCol?.label).toBe("Guide Value");
  });

  it("EXCEL_MASTER_COLUMNS still carries valuation_provenance (unchanged, was already correct)", () => {
    expect(EXCEL_MASTER_COLUMNS.map((c) => c.key)).toContain("valuation_provenance");
  });
});
