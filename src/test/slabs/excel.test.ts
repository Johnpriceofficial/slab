import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildInventoryWorkbook, workbookFilename } from "@/lib/slabs/excel";
import { EXCEL_MASTER_COLUMNS } from "@/lib/slabs/constants";
import type { Slab, SlabComp } from "@/lib/slabs/types";

function slab(n: number, over: Partial<Slab> = {}): Slab {
  return {
    id: `s${n}`,
    inventory_number: n,
    card_name: `Card ${n}`,
    final_value_cents: 12500,
    quick_sale_value_cents: 10000,
    replacement_value_cents: 15000,
    grader: "PSA",
    grade: "9",
    certification_number: `1000${n}`,
    set_name: "Base Set",
    card_number: "4",
    year: 1999,
    language: "English",
    rarity: "Holo Rare",
    variation: "Holo",
    label_description: "desc",
    label_accuracy: "accurate",
    verification_status: "verified",
    valuation_confidence: "high",
    duplicate_status: "unique",
    pricecharting_product_id: "6910",
    pricecharting_product_name: "Charizard #4",
    pricecharting_grade_field: "graded-price",
    pricecharting_value_cents: 12500,
    pricecharting_sales_volume: 42,
    pricecharting_match_status: "exact",
    price_variance_percent: 0,
    front_image_path: `slabs/${n}/front.jpg`,
    back_image_path: `slabs/${n}/back.jpg`,
    notes: null,
    date_valued: "2026-07-10T00:00:00Z",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...over,
  };
}

const comp: SlabComp = {
  id: "c1",
  slab_id: "s1",
  sale_date: "2026-06-01",
  sold_price_cents: 12000,
  shipping_cents: 500,
  total_price_cents: 12500,
  marketplace: "eBay",
  grader: "PSA",
  grade: "9",
  exact_match: true,
  source_url: "https://example.com/x",
  notes: null,
  created_at: "2026-07-10T00:00:00Z",
};

describe("excel — structure & column order", () => {
  it("produces exactly three sheets", () => {
    const wb = buildInventoryWorkbook([slab(1)], [comp]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Master Inventory", "Sales Comps", "Summary"]);
  });

  it("uses the exact 28-column Master Inventory order with Final Value right after Card Name", () => {
    const wb = buildInventoryWorkbook([slab(1)], []);
    const ws = wb.getWorksheet("Master Inventory")!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(EXCEL_MASTER_COLUMNS.map((c) => c.label));
    expect(header[1]).toBe("Card Name");
    expect(header[2]).toBe("Final Value");
  });

  it("freezes the header row and enables filters", () => {
    const wb = buildInventoryWorkbook([slab(1)], []);
    const ws = wb.getWorksheet("Master Inventory")!;
    expect(ws.views?.[0]?.state).toBe("frozen");
    expect(ws.autoFilter).toBeTruthy();
  });
});

describe("excel — certification numbers as text", () => {
  it("stores certification numbers as text and preserves leading zeros", () => {
    const wb = buildInventoryWorkbook([slab(1, { certification_number: "0012345" })], []);
    const ws = wb.getWorksheet("Master Inventory")!;
    const certColIndex = EXCEL_MASTER_COLUMNS.findIndex((c) => c.key === "certification_number") + 1;
    const cell = ws.getRow(2).getCell(certColIndex);
    expect(typeof cell.value).toBe("string");
    expect(cell.value).toBe("0012345"); // leading zeros intact
    expect(cell.numFmt).toBe("@"); // text format
  });
});

describe("excel — currency & sorting", () => {
  it("stores money as dollar numbers with currency format", () => {
    const wb = buildInventoryWorkbook([slab(1)], []);
    const ws = wb.getWorksheet("Master Inventory")!;
    const finalCol = EXCEL_MASTER_COLUMNS.findIndex((c) => c.key === "final_value_cents") + 1;
    expect(ws.getRow(2).getCell(finalCol).value).toBe(125); // 12500 cents -> $125
    expect(ws.getColumn(finalCol).numFmt).toContain("$");
  });

  it("sorts inventory numerically ascending", () => {
    const wb = buildInventoryWorkbook([slab(3), slab(1), slab(2)], []);
    const ws = wb.getWorksheet("Master Inventory")!;
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(3).getCell(1).value).toBe(2);
    expect(ws.getRow(4).getCell(1).value).toBe(3);
  });
});

describe("excel — summary totals", () => {
  it("reports the correct total final value in the Summary sheet", () => {
    const wb = buildInventoryWorkbook([slab(1, { final_value_cents: 12500 }), slab(2, { final_value_cents: 20000 })], []);
    const ws = wb.getWorksheet("Summary")!;
    let totalCell: unknown = undefined;
    let slabsCell: unknown = undefined;
    ws.eachRow((row) => {
      if (row.getCell(1).value === "Total Final Value") totalCell = row.getCell(2).value;
      if (row.getCell(1).value === "Total Slabs") slabsCell = row.getCell(2).value;
    });
    expect(totalCell).toBe(325); // (12500 + 20000) cents -> $325
    expect(slabsCell).toBe(2);
  });
});

describe("excel — edge cases", () => {
  it("exports an empty inventory (header only, zero totals)", () => {
    const wb = buildInventoryWorkbook([], []);
    const master = wb.getWorksheet("Master Inventory")!;
    expect(master.rowCount).toBe(1); // header only
    const summary = wb.getWorksheet("Summary")!;
    let slabsCell: unknown = undefined;
    summary.eachRow((row) => {
      if (row.getCell(1).value === "Total Slabs") slabsCell = row.getCell(2).value;
    });
    expect(slabsCell).toBe(0);
  });

  it("exports a 1,000-record inventory sorted numerically", () => {
    const shuffled = Array.from({ length: 1000 }, (_, i) => 1000 - i).map((n) => slab(n));
    const wb = buildInventoryWorkbook(shuffled, []);
    const ws = wb.getWorksheet("Master Inventory")!;
    expect(ws.rowCount).toBe(1001); // header + 1000
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(1001).getCell(1).value).toBe(1000);
  });
});

describe("excel — filename", () => {
  it("uses SlabVault_Master_Inventory_YYYY-MM-DD.xlsx", () => {
    expect(workbookFilename(new Date(2026, 6, 10))).toBe("SlabVault_Master_Inventory_2026-07-10.xlsx");
  });
});
