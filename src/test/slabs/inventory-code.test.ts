import { describe, it, expect } from "vitest";
import { formatInventoryCode, parseInventoryQuery, isInventoryQuery } from "@/lib/slabs/inventory-code";

describe("formatInventoryCode", () => {
  it("pads to at least four digits", () => {
    expect(formatInventoryCode("S", 1)).toBe("S0001");
    expect(formatInventoryCode("R", 42)).toBe("R0042");
    expect(formatInventoryCode("S", 1234)).toBe("S1234");
  });

  it("expands past four digits without truncating", () => {
    expect(formatInventoryCode("S", 12345)).toBe("S12345");
  });
});

describe("parseInventoryQuery (mirrors SQL parse_inventory_code)", () => {
  it("parses a full prefixed code", () => {
    expect(parseInventoryQuery("S0001")).toEqual({ prefix: "S", sequence: 1 });
    expect(parseInventoryQuery("R0012")).toEqual({ prefix: "R", sequence: 12 });
  });

  it("parses the numeric portion with and without padding", () => {
    expect(parseInventoryQuery("0001")).toEqual({ prefix: null, sequence: 1 });
    expect(parseInventoryQuery("1")).toEqual({ prefix: null, sequence: 1 });
  });

  it("is case-insensitive and trims", () => {
    expect(parseInventoryQuery("  s0007 ")).toEqual({ prefix: "S", sequence: 7 });
  });

  it("returns null for free text, empty, or a zero sequence", () => {
    expect(parseInventoryQuery("Charizard")).toBeNull();
    expect(parseInventoryQuery("")).toBeNull();
    expect(parseInventoryQuery("0000")).toBeNull();
    expect(parseInventoryQuery("S")).toBeNull();
    expect(parseInventoryQuery("SS01")).toBeNull();
  });

  it("isInventoryQuery reflects parseability", () => {
    expect(isInventoryQuery("S0001")).toBe(true);
    expect(isInventoryQuery("42")).toBe(true);
    expect(isInventoryQuery("Pikachu")).toBe(false);
  });
});
