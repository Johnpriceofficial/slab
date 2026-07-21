/**
 * Normalization from raw PriceCharting product JSON to the typed `Product`
 * model. Missing prices stay `null`; malformed records are rejected safely.
 */

import type { Pennies } from "./money";
import type { Product, RawProduct } from "./types";
import { isRecord, ProviderSchemaError } from "@/lib/providers/response-schema";

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

function toPennies(value: unknown): Pennies | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function toStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export const CONDITION_FIELD_RE = /^condition-\d+-price$/;

export function normalizeProduct(value: RawProduct | unknown): Product {
  if (!isRecord(value)) throw new ProviderSchemaError("PriceCharting", "$product", "expected an object");
  const raw = value as RawProduct & Record<string, unknown>;
  const raw_prices: Record<string, Pennies | null> = {};

  for (const field of KNOWN_PRICE_FIELDS) {
    if (field in raw) raw_prices[field] = toPennies(raw[field]);
  }
  for (const key of Object.keys(raw)) {
    if (CONDITION_FIELD_RE.test(key) && !(key in raw_prices)) raw_prices[key] = toPennies(raw[key]);
  }

  return {
    pricecharting_id: toStringValue(raw.id) ?? "",
    name: toStringValue(raw["product-name"]) ?? "",
    console_or_category: toStringValue(raw["console-name"]),
    release_date: toStringValue(raw["release-date"]),
    upc: toStringValue(raw.upc),
    asin: toStringValue(raw.asin),
    epid: toStringValue(raw.epid),
    genre: toStringValue(raw.genre),
    raw_prices,
  };
}

export function normalizeProductList(payload: Record<string, unknown>): Product[] {
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.products)
      ? payload.products
      : payload.products === null || payload.products === undefined
        ? []
        : (() => { throw new ProviderSchemaError("PriceCharting", "$.products", "expected an array"); })();

  return rawList
    .filter(isRecord)
    .map((raw) => normalizeProduct(raw))
    .filter((product) => product.pricecharting_id !== "");
}
