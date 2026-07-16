/**
 * PriceCharting product-page parser. Uses a real HTML parser (linkedom — works
 * in both Node and Deno) and selects the identity anchors and `#full-prices`
 * table STRUCTURALLY by DOM, not by regex, so minor whitespace/formatting
 * changes on the page don't break extraction.
 *
 *   <h1 id="product_name" title="<product-id>"> <card name> #<number> <a>console</a> </h1>
 *   <a ... data-product-id="<product-id>">
 *   <link rel="canonical" href="/game/<console>/<slug>">
 *   #full-prices  ->  <tr><td><label></td><td class="price …"><value></td></tr>
 *   <img src="https://storage.googleapis.com/images.pricecharting.com/<hash>/…">
 *
 * Non-product pages (search / error / anti-bot challenge / login) are detected
 * (no product identity + no price table) so verification can reject them.
 */

import { parseHTML } from "linkedom";

export interface RawPageRow {
  label: string;
  priceText: string;
}

export interface RawPageExtract {
  product_id: string | null;
  title: string | null;
  card_number: string | null;
  set_or_console: string | null;
  canonical_url: string | null;
  rows: RawPageRow[];
  image_url: string | null;
  /** False for search/error/challenge/login pages (no product identity + table). */
  looksLikeProductPage: boolean;
}

const clean = (s: string | null | undefined): string => (s ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

const PRODUCT_ID_RE = /^\d{3,}$/;
const PRODUCT_IMAGE_RE = /^https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\//i;

/** Card number like "047/067" or "47" from a title such as "Rayquaza VMAX #47 …". */
function cardNumberFrom(title: string | null): string | null {
  if (!title) return null;
  const m = /#\s*([0-9]+[a-z]?(?:\/[0-9]+)?)/i.exec(title);
  return m ? m[1] : null;
}

// deno-lint-ignore no-explicit-any
export function parseProductPage(html: string): RawPageExtract {
  const { document } = parseHTML(html);

  const h1 = document.querySelector("h1#product_name");

  // Product id: prefer the h1 title attribute, fall back to a data-product-id anchor.
  let product_id: string | null = null;
  const h1Title = h1?.getAttribute("title") ?? "";
  if (PRODUCT_ID_RE.test(h1Title)) product_id = h1Title;
  if (!product_id) {
    const idAnchor = document.querySelector("[data-product-id]");
    const v = idAnchor?.getAttribute("data-product-id") ?? "";
    if (PRODUCT_ID_RE.test(v)) product_id = v;
  }

  // Title = the h1 text BEFORE the nested console link; console name = the link text.
  let title: string | null = null;
  let set_or_console: string | null = null;
  if (h1) {
    const consoleLink = h1.querySelector("a");
    // Collect direct child text up to the console <a>.
    let head = "";
    // deno-lint-ignore no-explicit-any
    for (const node of Array.from(h1.childNodes) as any[]) {
      if (node.nodeType === 1 && String(node.tagName).toUpperCase() === "A") break;
      head += node.textContent ?? "";
    }
    title = clean(head) || null;
    if (consoleLink) {
      set_or_console = clean(consoleLink.textContent) || null;
      if (!set_or_console) {
        const href = consoleLink.getAttribute("href") ?? "";
        const m = /\/console\/([a-z0-9-]+)/i.exec(href);
        set_or_console = m ? m[1] : null;
      }
    }
  }

  const canonical_url = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;

  // #full-prices table → rows. Price cell picked structurally by class, so a
  // reordered/relabeled column still resolves the value.
  const rows: RawPageRow[] = [];
  const fullPrices = document.querySelector("#full-prices");
  if (fullPrices) {
    // deno-lint-ignore no-explicit-any
    for (const tr of Array.from(fullPrices.querySelectorAll("tr")) as any[]) {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      if (cells.length < 2) continue;
      // deno-lint-ignore no-explicit-any
      const label = clean((cells[0] as any).textContent);
      if (!label) continue;
      const priceCell = tr.querySelector("td.price, td.js-price") ?? cells[cells.length - 1];
      // deno-lint-ignore no-explicit-any
      const priceText = clean((priceCell as any).textContent);
      rows.push({ label, priceText });
    }
  }

  // Reference artwork: first product image on the trusted storage host.
  let image_url: string | null = null;
  // deno-lint-ignore no-explicit-any
  for (const img of Array.from(document.querySelectorAll("img")) as any[]) {
    const src = img.getAttribute("src") ?? "";
    if (PRODUCT_IMAGE_RE.test(src)) { image_url = src; break; }
  }

  const looksLikeProductPage = !!product_id && rows.length > 0;

  return {
    product_id,
    title,
    card_number: cardNumberFrom(title),
    set_or_console,
    canonical_url,
    rows,
    image_url,
    looksLikeProductPage,
  };
}
