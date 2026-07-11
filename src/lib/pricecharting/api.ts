/**
 * Typed read wrappers over the raw client for product endpoints.
 * These handle URL params, normalization, and empty-result semantics.
 */

import type { PriceChartingClient } from "./client";
import { PriceChartingError } from "./errors";
import { normalizeProduct, normalizeProductList } from "./product";
import type { Product, RawProduct } from "./types";

/**
 * Full-text product search (/api/products). Returns up to the first 20 matches.
 * Use this BEFORE /api/product whenever a query could match multiple variants.
 *
 * Required core function #1.
 */
export async function searchProducts(client: PriceChartingClient, query: string): Promise<Product[]> {
  const q = query?.trim();
  if (!q) {
    throw new PriceChartingError("MISSING_PARAMETER", "A non-empty search query `q` is required.");
  }
  const payload = await client.request<Record<string, unknown>>({
    endpoint: "products",
    method: "GET",
    params: { q },
  });
  return normalizeProductList(payload);
}

/**
 * Single product lookup by PriceCharting id (/api/product).
 * Required core function #2.
 */
export async function getProductById(client: PriceChartingClient, productId: string): Promise<Product> {
  const id = String(productId ?? "").trim();
  if (!id) {
    throw new PriceChartingError("MISSING_PARAMETER", "`id` is required for getProductById.");
  }
  const raw = await client.request<RawProduct>({ endpoint: "product", method: "GET", params: { id } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No product found for id ${id}.`);
  }
  return product;
}

/**
 * Single product lookup by UPC (/api/product?upc=...).
 * Required core function #3.
 */
export async function getProductByUPC(client: PriceChartingClient, upc: string): Promise<Product> {
  const code = String(upc ?? "").replace(/\s+/g, "").trim();
  if (!code) {
    throw new PriceChartingError("MISSING_PARAMETER", "`upc` is required for getProductByUPC.");
  }
  const raw = await client.request<RawProduct>({ endpoint: "product", method: "GET", params: { upc: code } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No product found for UPC ${code}.`);
  }
  return product;
}
