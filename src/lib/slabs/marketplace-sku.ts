// THE canonical, cross-marketplace permanent SKU for a slab. Every marketplace
// surface — PriceCharting Marketplace, eBay listing creation, eBay listing
// mappings, eBay order reconciliation, exports — must derive the SKU from HERE so
// one slab has exactly one permanent SKU everywhere. It is derived from the
// immutable internal inventory_number as "GCV" + 6-digit zero-pad, e.g. slab
// inventory number 47 → "GCV000047". This format predates the integrations and
// is the user-facing permanent identifier; do not fork per-provider variants.

export interface SkuSlab {
  inventory_number: number;
}

export function canonicalMarketplaceSku(slab: SkuSlab): string {
  return `GCV${String(slab.inventory_number).padStart(6, "0")}`;
}
