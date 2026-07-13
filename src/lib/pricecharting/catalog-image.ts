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

export interface PublicGuidePick {
  value_cents: number;
  field: string;
  tier_key: string;
  tier_label: string;
  designation_exact: boolean;
}

function pageText(html: string): string {
  return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ");
}

function centsFor(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s+\\$([0-9,]+(?:\\.[0-9]{2})?)`, "i").exec(text);
  if (!match) return null;
  const dollars = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/** Select the public guide tier only when the API omitted the requested tier. */
export function extractPublicGuidePrice(
  html: string,
  grader: string | undefined,
  grade: number | null | undefined,
  gradeLabel?: string | null,
): PublicGuidePick | null {
  if (grade === null || grade === undefined) return null;
  const text = pageText(html);
  const designation = (gradeLabel ?? "").toLowerCase();
  let label: string;
  let field: string;
  let tierKey: string;
  let designationExact = !designation.includes("pristine") && !designation.includes("perfect");

  if (grade === 10 && grader === "CGC" && designation.includes("pristine")) {
    label = "CGC 10 Pristine"; field = "public-cgc-10-pristine"; tierKey = "cgc_10_pristine"; designationExact = true;
  } else if (grade === 10 && grader === "CGC") {
    label = "CGC 10"; field = "condition-17-price"; tierKey = "cgc_10";
  } else if (grade === 10 && grader === "PSA") {
    label = "PSA 10"; field = "manual-only-price"; tierKey = "psa_10";
  } else if (grade === 10 && grader === "BGS") {
    label = "BGS 10"; field = "bgs-10-price"; tierKey = "bgs_10";
  } else if (grade === 10 && grader === "SGC") {
    label = "SGC 10"; field = "condition-18-price"; tierKey = "sgc_10";
  } else if (grade === 9.5) {
    label = "Grade 9.5"; field = "box-only-price"; tierKey = "grade_9_5_general";
  } else if (grade === 9) {
    label = "Grade 9"; field = "graded-price"; tierKey = "grade_9_general"; designationExact = false;
  } else if (grade === 8 || grade === 8.5) {
    label = "Grade 8"; field = "new-price"; tierKey = "grade_8_to_8_5"; designationExact = grade === 8;
  } else if (grade === 7 || grade === 7.5) {
    label = "Grade 7"; field = "cib-price"; tierKey = "grade_7_to_7_5"; designationExact = grade === 7;
  } else return null;

  const value = centsFor(text, label);
  return value === null ? null : { value_cents: value, field, tier_key: tierKey, tier_label: label, designation_exact: designationExact };
}

export async function scrapePublicGuidePrice(
  fetchImpl: FetchLike,
  product: Product,
  grader: string | undefined,
  grade: number | null | undefined,
  gradeLabel?: string | null,
): Promise<PublicGuidePick | null> {
  const pageUrl = buildProductPageUrl(product);
  if (!pageUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(pageUrl, { method: "GET", headers: { Accept: "text/html", "User-Agent": "SlabVault/1.0 pricing fallback" }, signal: controller.signal });
    if (!response.ok) return null;
    return extractPublicGuidePrice(await response.text(), grader, grade, gradeLabel);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
