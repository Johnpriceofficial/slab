import { PRICECHARTING_BASE_URL } from "./config";
import type { FetchLike } from "./client";
import type { Product } from "./types";

function slugSegment(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9']+/g, "-").replace(/^-+|-+$/g, "").replace(/'/g, "%27");
}

export function buildProductPageUrl(product: Product): string | null {
  if (!product.name || !product.console_or_category) return null;
  const consoleSlug = slugSegment(product.console_or_category);
  const productSlug = slugSegment(product.name.replace(/\s*#\s*/g, " "));
  if (!consoleSlug || !productSlug) return null;
  return `${PRICECHARTING_BASE_URL}/game/${consoleSlug}/${productSlug}`;
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function safeImageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(decodeHtml(raw), PRICECHARTING_BASE_URL);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)pricecharting\.com$/i.test(url.hostname) && url.hostname !== "storage.googleapis.com") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Extract only the catalog image, never sale-history thumbnails. */
export function extractCatalogImage(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i.test(tag)) continue;
    const image = safeImageUrl(/content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
    if (image) return image;
  }
  for (const tag of html.match(/<img\b[^>]*(?:id\s*=\s*["'](?:product_image|product-image)["']|class\s*=\s*["'][^"']*product-image[^"']*["']|alt\s*=\s*["']Main Image(?:\s*\||["']))[^>]*>/gi) ?? []) {
    const image = safeImageUrl(/(?:src|data-src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
    if (image) return image;
  }
  return null;
}

export async function scrapeCatalogImage(fetchImpl: FetchLike, product: Product): Promise<string | null> {
  const pageUrl = buildProductPageUrl(product);
  if (!pageUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(pageUrl, {
      method: "GET",
      headers: { Accept: "text/html", "User-Agent": "SlabVault/1.0 product-image fallback" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return extractCatalogImage(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
