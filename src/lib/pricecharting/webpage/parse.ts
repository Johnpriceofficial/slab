/**
 * Pure PriceCharting product-page parser — DOM-free so it runs identically in
 * Node (vitest) and the Deno Edge bundle. It extracts the identity anchors and
 * the `#full-prices` grade table by their STABLE semantic structure:
 *
 *   <h1 id="product_name" title="<product-id>"> <card name> #<number> <console> </h1>
 *   <a ... data-product-id="<product-id>">
 *   <link rel="canonical" href="/game/<console>/<slug>">
 *   <div id="full-prices"> … <tr><td><label></td><td class="price …"><value></td></tr> … </div>
 *   <img src="https://storage.googleapis.com/images.pricecharting.com/<hash>/…">
 *
 * It classifies non-product pages (search / error / anti-bot challenge / login)
 * as NOT a product page so verification can reject them.
 */

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

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1] : null;
}

/** Extract the `#full-prices` table region only, so we never scan the whole page. */
function fullPricesRegion(html: string): string | null {
  const start = html.search(/id=["']full-prices["']/i);
  if (start < 0) return null;
  const tableStart = html.indexOf("<table", start);
  if (tableStart < 0) return null;
  const tableEnd = html.indexOf("</table>", tableStart);
  if (tableEnd < 0) return null;
  return html.slice(tableStart, tableEnd + "</table>".length);
}

function parseRows(region: string): RawPageRow[] {
  const rows: RawPageRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(region))) {
    const cells: string[] = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(tr[1]))) cells.push(stripTags(td[1]));
    if (cells.length < 2) continue;
    const label = cells[0];
    const priceText = cells[cells.length - 1];
    if (!label) continue;
    rows.push({ label, priceText });
  }
  return rows;
}

/** Card number like "#47" from a title such as "Rayquaza VMAX #47 …". */
function cardNumberFrom(title: string | null): string | null {
  if (!title) return null;
  const m = /#\s*([0-9]+[a-z]?(?:\/[0-9]+)?)/i.exec(title);
  return m ? m[1] : null;
}

export function parseProductPage(html: string): RawPageExtract {
  // Product id: prefer the h1 title attribute, fall back to a data-product-id anchor.
  const product_id =
    firstMatch(html, /id=["']product_name["'][^>]*\btitle=["'](\d{3,})["']/i) ??
    firstMatch(html, /\bdata-product-id=["'](\d{3,})["']/i);

  // Title: the h1 text up to the nested console link.
  const h1Inner = firstMatch(html, /<h1\b[^>]*id=["']product_name["'][^>]*>([\s\S]*?)<\/h1>/i);
  let title: string | null = null;
  let set_or_console: string | null = null;
  if (h1Inner) {
    const beforeLink = h1Inner.split(/<a\b/i)[0];
    title = stripTags(beforeLink) || null;
    const consoleText = firstMatch(h1Inner, /<a\b[^>]*>([\s\S]*?)<\/a>/i);
    set_or_console = consoleText ? stripTags(consoleText.replace(/<img[\s\S]*$/i, "")) || null : null;
  }
  set_or_console ??= firstMatch(html, /\/console\/([a-z0-9-]+)/i);

  const canonical_url = firstMatch(html, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);

  const region = fullPricesRegion(html);
  const rows = region ? parseRows(region) : [];

  // Reference artwork: the first product image on the trusted storage host.
  const image_url = firstMatch(html, /<img\b[^>]*src=["'](https:\/\/storage\.googleapis\.com\/images\.pricecharting\.com\/[^"']+)["']/i);

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
