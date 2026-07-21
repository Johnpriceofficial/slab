/**
 * SSRF-safe URL handling for the PriceCharting public-page adapter.
 *
 * URLs are only ever accepted if they are HTTPS, on an exact PriceCharting host,
 * and on a `/game/` product path. Everything else — other hosts, private/loopback
 * addresses, alternate protocols, embedded credentials — is rejected. Redirects
 * are revalidated with the same rules by the fetcher.
 */

/** Exact host allowlist. Never a suffix match (no `evil-pricecharting.com`). */
export const PAGE_HOST_ALLOWLIST: ReadonlySet<string> = new Set(["www.pricecharting.com", "pricecharting.com"]);

/** Hostnames that must never be fetched even if somehow constructed. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 literals: block loopback / private / link-local ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return true;
  }
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("[::1]") || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

/** Parse + validate a candidate URL, or return null when it is not safe. */
export function safePriceChartingGameUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null; // HTTPS only — no http:, file:, data:, etc.
  if (u.username || u.password) return null; // no embedded credentials
  if (u.port && u.port !== "443") return null; // no custom port — standard HTTPS only
  if (!PAGE_HOST_ALLOWLIST.has(u.hostname.toLowerCase())) return null;
  if (isPrivateHost(u.hostname)) return null;
  if (!u.pathname.startsWith("/game/")) return null; // product pages only, never search/offers/error
  return u;
}

/** True when a redirect Location may be followed (same strict rules). */
export function isAllowedRedirectTarget(location: string, base: string): boolean {
  let resolved: string;
  try {
    resolved = new URL(location, base).toString();
  } catch {
    return false;
  }
  return safePriceChartingGameUrl(resolved) !== null;
}

/** Fold every apostrophe variant to a single straight apostrophe. */
function normalizeApostrophes(s: string): string {
  return (s ?? "")
    .replace(/%27/gi, "'") // percent-encoded apostrophe
    .replace(/[‘’ʼʹ′´`]/g, "'"); // curly / modifier / prime / acute / backtick
}

/**
 * Build a canonical product-page URL from a console slug + product slug.
 *
 * PriceCharting KEEPS apostrophes in its slugs — "N's Zoroark ex #112" is served
 * at `/game/.../n's-zoroark-ex-112` (rendered `n%27s-...`), NOT `n-s-...`. So the
 * apostrophe must be preserved: every apostrophe variant (curly, modifier,
 * percent-encoded) is normalized to a straight apostrophe and KEPT; every other
 * non-alphanumeric run collapses to a single dash; edge dashes are trimmed. This
 * still strips any path/host/query injection (only [a-z0-9'-] survive). Returns
 * null if either slug is empty after sanitization.
 */
export function buildGameUrl(consoleSlug: string, productSlug: string): string | null {
  const clean = (s: string) =>
    normalizeApostrophes((s ?? "").toLowerCase())
      .replace(/#/g, "")
      .replace(/[^a-z0-9']+/g, "-") // keep apostrophes; collapse everything else to a dash
      .replace(/^-+|-+$/g, "");
  const c = clean(consoleSlug);
  const p = clean(productSlug);
  if (!c || !p) return null;
  return `https://www.pricecharting.com/game/${c}/${p}`;
}

/**
 * Reduce a slug or full URL to a comparison KEY that is invariant across the ways
 * the same product can be written: straight/curly/modifier/percent-encoded
 * apostrophes, hyphen-vs-apostrophe, and the exact separator run all collapse
 * away. `n's-zoroark-ex-112`, `n-s-zoroark-ex-112`, `n%27s-zoroark-ex-112`, and
 * `ns-zoroark-ex-112` all map to the same key, while a different product does not.
 * Used to compare a derived canonical URL against the page's own canonical URL
 * (and the redirect-final URL) without spurious mismatches.
 */
export function canonicalSlugKey(value: string): string {
  return normalizeApostrophes((value ?? "").toLowerCase()).replace(/[^a-z0-9]+/g, "");
}
