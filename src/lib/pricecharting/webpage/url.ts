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

/**
 * Build a canonical product-page URL from a validated console slug + product slug.
 * Slugs are lowercased and stripped to a safe `[a-z0-9-]` charset so no
 * attacker-controlled path/host/query can be injected. Returns null if either
 * slug is empty after sanitization.
 */
export function buildGameUrl(consoleSlug: string, productSlug: string): string | null {
  const clean = (s: string) => (s ?? "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  const c = clean(consoleSlug);
  const p = clean(productSlug);
  if (!c || !p) return null;
  return `https://www.pricecharting.com/game/${c}/${p}`;
}
