/**
 * Normalization from raw PriceCharting product JSON to the typed `Product`
 * model. Missing prices stay `null` — never coerced to 0.
 */

import type { Pennies } from "./money";
import type { Product, RawProduct } from "./types";

/**
 * All price-bearing fields we recognize (integer pennies).
 *
 * PriceCharting keeps adding graded "condition-NN" columns beyond what its docs
 * list. Anything NOT in this allowlist is silently dropped by `normalizeProduct`,
 * which is exactly why CGC 10 Pristine (condition-19-price) never reached the
 * valuation before — the list stopped at condition-18. The documented+observed
 * numbering is: 17 = CGC 10, 18 = SGC 10, 19 = CGC 10 Pristine, 20 = BGS 10 Black
 * Label, 21 = TAG 10, 22 = ACE 10. See grade-mapping.ts for the field→tier map.
 */
export const KNOWN_PRICE_FIELDS = [
  "loose-price",
  "cib-price",
  "new-price",
  "graded-price",
  "box-only-price",
  "manual-only-price",
  "bgs-10-price",
  "condition-17-price",
  "condition-18-price",
  "condition-19-price",
  "condition-20-price",
  "condition-21-price",
  "condition-22-price",
  "retail-loose-buy",
  "retail-loose-sell",
  "retail-cib-buy",
  "retail-cib-sell",
  "retail-new-buy",
  "retail-new-sell",
] as const;

function toPennies(v: unknown): Pennies | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  // Prices are integers; guard against unexpected fractional/string junk.
  return Math.round(n);
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Convert a raw API product into the normalized `Product`. */
export function normalizeProduct(raw: RawProduct): Product {
  const raw_prices: Record<string, Pennies | null> = {};
  for (const field of KNOWN_PRICE_FIELDS) {
    if (field in raw) raw_prices[field] = toPennies(raw[field]);
  }

  const id = toStr(raw.id);
  return {
    pricecharting_id: id ?? "",
    name: toStr(raw["product-name"]) ?? "",
    console_or_category: toStr(raw["console-name"]),
    release_date: toStr(raw["release-date"]),
    upc: toStr(raw.upc),
    asin: toStr(raw.asin),
    epid: toStr(raw.epid),
    genre: toStr(raw.genre),
    raw_prices,
  };
}

/**
 * PriceCharting's /api/products returns a `products` array. Normalize each.
 * Tolerates either an array payload or a wrapper object.
 */
export function normalizeProductList(payload: Record<string, unknown>): Product[] {
  const list =
    (payload.products as RawProduct[] | undefined) ??
    (Array.isArray(payload) ? (payload as unknown as RawProduct[]) : undefined) ??
    [];
  return list.map((r) => normalizeProduct(r)).filter((p) => p.pricecharting_id !== "");
}
