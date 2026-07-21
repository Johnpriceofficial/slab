// Pure helpers for turning a slab into an eBay listing's identity: a canonical
// SKU, an optimized (<=80 char) title, and its stored image paths. Kept pure and
// separate so they are unit-tested without a browser or network, and reused by
// the EbaySellerPanel when preparing/publishing a listing.

// Fields these helpers read — a subset of Slab, so tests can pass minimal objects.
export interface ListingSlab {
  inventory_code?: string | null;
  inventory_number?: number | null;
  card_name?: string | null;
  set_name?: string | null;
  card_number?: string | null;
  year?: number | null;
  variation?: string | null;
  rarity?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_label?: string | null;
  front_image_path?: string | null;
  back_image_path?: string | null;
}

const clean = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * The canonical, immutable eBay SKU for a slab: the DB-generated public code
 * (e.g. "S0001") brand-prefixed → "GCV-S0001". Never the mutable-looking raw
 * inventory number. Deterministic, so order-sync maps a sale back to the slab.
 */
export function ebaySkuForSlab(slab: ListingSlab): string {
  const code = clean(slab.inventory_code);
  if (code) return `GCV-${code}`;
  const n = typeof slab.inventory_number === "number" ? slab.inventory_number : null;
  return n != null ? `GCV-S${n}` : "GCV-UNKNOWN";
}

/**
 * An optimized eBay title within eBay's 80-char cap. The card name and the
 * grade (grader + designation + grade) are always kept; lower-value tokens are
 * dropped in order (rarity → variation → card #→ year → set) until it fits, then
 * hard-truncated as a final guard.
 */
export function ebayListingTitle(slab: ListingSlab, max = 80): string {
  const cardName = clean(slab.card_name) || "Graded Card";
  const grade = [clean(slab.grader), clean(slab.grade_label), clean(slab.grade)].filter(Boolean).join(" ");
  const year = typeof slab.year === "number" ? String(slab.year) : "";
  const set = clean(slab.set_name);
  const num = clean(slab.card_number) ? `#${clean(slab.card_number)}` : "";
  const variation = clean(slab.variation);
  const rarity = clean(slab.rarity);

  const build = (skip: ReadonlySet<string>): string => {
    const segs = ([["year", year], ["set", set], ["name", cardName], ["num", num], ["var", variation], ["rarity", rarity]] as const)
      .filter(([k, v]) => v && !skip.has(k))
      .map(([, v]) => v);
    if (grade) segs.push(grade);
    return segs.join(" ").replace(/\s+/g, " ").trim();
  };

  const dropOrder = ["rarity", "var", "num", "year", "set"]; // name + grade never dropped
  const skip = new Set<string>();
  let title = build(skip);
  for (const key of dropOrder) {
    if (title.length <= max) break;
    skip.add(key);
    title = build(skip);
  }
  return title.length <= max ? title : title.slice(0, max).trim();
}

/** Stored image paths for a slab, front first — the inputs to signed-URL resolution. */
export function slabImagePaths(slab: ListingSlab): string[] {
  return [slab.front_image_path, slab.back_image_path].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}
