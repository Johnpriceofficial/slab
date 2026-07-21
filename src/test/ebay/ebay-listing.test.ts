import { describe, it, expect } from "vitest";
import { ebaySkuForSlab, ebayListingTitle, slabImagePaths, type ListingSlab } from "../../lib/slabs/ebay-listing";

describe("ebaySkuForSlab", () => {
  it("brand-prefixes the canonical public code, never the raw inventory number", () => {
    expect(ebaySkuForSlab({ inventory_code: "S0001", inventory_number: 42 })).toBe("GCV-S0001");
    expect(ebaySkuForSlab({ inventory_code: "  S0123  " })).toBe("GCV-S0123");
  });
  it("falls back to the inventory number only when the code is missing", () => {
    expect(ebaySkuForSlab({ inventory_number: 42 })).toBe("GCV-S42");
    expect(ebaySkuForSlab({})).toBe("GCV-UNKNOWN");
  });
});

describe("ebayListingTitle", () => {
  const full: ListingSlab = {
    year: 2016, set_name: "XY Evolutions", card_name: "Charizard", card_number: "11",
    variation: "Holo", rarity: "Rare Holo", grader: "PSA", grade_label: "GEM MT", grade: "10",
  };

  it("assembles a rich title in display order and stays within 80 chars", () => {
    const t = ebayListingTitle(full);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toBe("2016 XY Evolutions Charizard #11 Holo Rare Holo PSA GEM MT 10");
  });

  it("always keeps the card name and the grade suffix", () => {
    const t = ebayListingTitle(full);
    expect(t).toContain("Charizard");
    expect(t).toContain("PSA GEM MT 10");
  });

  it("drops low-value tokens (rarity → variation → #num → year → set) to fit the cap", () => {
    const longSet: ListingSlab = {
      ...full,
      set_name: "Super Long Championship Promotional Set Name Edition Deluxe",
      card_name: "Charizard VMAX Rainbow Rare Secret",
    };
    const t = ebayListingTitle(longSet);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toContain("Charizard VMAX Rainbow Rare Secret"); // name kept
    expect(t).toContain("PSA GEM MT 10"); // grade kept
    expect(t).not.toContain("Rare Holo"); // rarity dropped first
  });

  it("hard-truncates as a final guard when even name + grade exceed the cap", () => {
    const t = ebayListingTitle({ card_name: "X".repeat(120), grader: "PSA", grade: "10" }, 80);
    expect(t.length).toBe(80);
  });

  it("degrades gracefully with almost no data", () => {
    expect(ebayListingTitle({ grader: "PSA", grade: "10" })).toBe("Graded Card PSA 10");
    expect(ebayListingTitle({})).toBe("Graded Card");
  });
});

describe("slabImagePaths", () => {
  it("returns front then back, dropping empty/missing paths", () => {
    expect(slabImagePaths({ front_image_path: "f.jpg", back_image_path: "b.jpg" })).toEqual(["f.jpg", "b.jpg"]);
    expect(slabImagePaths({ front_image_path: "f.jpg", back_image_path: null })).toEqual(["f.jpg"]);
    expect(slabImagePaths({ front_image_path: "  ", back_image_path: "b.jpg" })).toEqual(["b.jpg"]);
    expect(slabImagePaths({})).toEqual([]);
  });
});
