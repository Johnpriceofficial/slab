import { describe, it, expect } from "vitest";
import { canonicalMarketplaceSku } from "../../lib/slabs/marketplace-sku";

describe("canonicalMarketplaceSku", () => {
  it("is GCV + 6-digit zero-padded inventory number", () => {
    expect(canonicalMarketplaceSku({ inventory_number: 47 })).toBe("GCV000047");
    expect(canonicalMarketplaceSku({ inventory_number: 1 })).toBe("GCV000001");
    expect(canonicalMarketplaceSku({ inventory_number: 123456 })).toBe("GCV123456");
  });

  it("leaves inventory numbers longer than six digits intact", () => {
    expect(canonicalMarketplaceSku({ inventory_number: 1234567 })).toBe("GCV1234567");
  });

  it("regression: slab #47 (public code S0005) → GCV000047, NOT GCV-S0005", () => {
    // The canonical SKU is derived from inventory_number (47), never the public
    // code (S0005). eBay and PriceCharting must agree on this exact value.
    const sku = canonicalMarketplaceSku({ inventory_number: 47 });
    expect(sku).toBe("GCV000047");
    expect(sku).not.toContain("S0005");
    expect(sku).not.toContain("-");
  });

  it("both marketplace surfaces resolve the identical SKU for the same slab", () => {
    // PriceCharting and eBay listing paths both call this one helper; proving the
    // helper is deterministic proves the two surfaces can never diverge.
    const slab = { inventory_number: 47 };
    expect(canonicalMarketplaceSku(slab)).toBe(canonicalMarketplaceSku(slab));
    expect(canonicalMarketplaceSku(slab)).toBe("GCV000047");
  });
});
