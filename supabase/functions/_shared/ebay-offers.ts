// Fail-closed, dependency-injected eBay getOffers discovery. The full multi-page
// workflow is testable with a mocked fetch, so redirects, pagination loops, page
// caps, unsafe `next` links, incoherent pagination metadata, and ambiguous 404s
// are all PROVEN to fail closed — never read as complete/empty. NO offer may be
// created, adopted, published, or reconciled unless discovery here completed IN
// FULL. Raw provider bodies, tokens, and URLs are never surfaced.

import { extractOfferSummaries, type OfferSummary } from "./ebay-listing-core.ts";

// Documented eBay getOffers "no offers exist for this SKU" error ids. 25710 is a
// GENERIC missing-resource id (documented for getInventoryItem, not proven
// method-specific for getOffers) so it is intentionally EXCLUDED here.
export const EBAY_NO_OFFERS_ERROR_IDS = new Set([25702, 25713]);
export const OFFER_MAX_PAGES = 20;
const GET_OFFERS_PATH = "/sell/inventory/v1/offer";
const APPROVED_API_ORIGINS = new Set(["https://api.ebay.com", "https://api.sandbox.ebay.com"]);

export type OffersDiscovery =
  | { ok: true; offers: OfferSummary[]; pagesFetched: number; providerTotal: number | null; providerSize: number | null; deduplicatedCount: number }
  | { ok: false; errorCode: string; httpStatus: number | null; safeProviderErrorId: number | null; pagesFetched: number };

export interface OffersFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
export type OffersFetchInit = { headers: Record<string, string>; redirect: "manual" };
export type OffersFetchImpl = (url: string, init: OffersFetchInit) => Promise<OffersFetchResponse>;

/** The apiOrigin must be a bare, approved eBay API origin — https, no credentials,
 *  no path/query/fragment. Guards against a mis-configured or hostile base. */
export function validateApiOrigin(origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.pathname !== "/" && u.pathname !== "") return false;
  if (u.search || u.hash) return false;
  return APPROVED_API_ORIGINS.has(u.origin);
}

/** Sorted-query canonical form, so loop detection is order-insensitive. */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.sort();
    return u.toString();
  } catch { return url; }
}

/**
 * Strictly validate a provider `next` pagination URL: https, EXACT approved
 * origin (alternate port rejected), the exact getOffers path, no embedded
 * credentials, no fragment, and EXACTLY ONE sku param equal to the canonical SKU.
 */
export function validateNextUrl(next: string, apiOrigin: string, sku: string): { ok: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(next); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "protocol" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  if (u.hash) return { ok: false, reason: "fragment" };
  if (u.origin !== apiOrigin) return { ok: false, reason: "origin" };
  if (u.pathname !== GET_OFFERS_PATH) return { ok: false, reason: "path" };
  const skus = u.searchParams.getAll("sku");
  if (skus.length !== 1 || skus[0] !== sku) return { ok: false, reason: "sku" };
  return { ok: true };
}

function safeErrorId(data: Record<string, unknown>): number | null {
  const errs = Array.isArray(data.errors) ? data.errors as Array<Record<string, unknown>> : [];
  const id = errs[0] ? Number(errs[0].errorId) : NaN;
  return Number.isFinite(id) ? id : null;
}

// A 404 is "no offers" ONLY when there is at least one error and EVERY error is a
// documented method-specific no-offer id. A mixed/unknown/empty/malformed error
// set is NOT accepted as empty.
function is404NoOffers(data: Record<string, unknown>): boolean {
  const errs = Array.isArray(data.errors) ? data.errors as Array<Record<string, unknown>> : [];
  if (errs.length === 0) return false;
  return errs.every((e) => {
    const id = Number(e?.errorId);
    return Number.isFinite(id) && EBAY_NO_OFFERS_ERROR_IDS.has(id);
  });
}

export interface OffersDiscoveryArgs {
  fetchImpl: OffersFetchImpl;
  apiOrigin: string;
  accessToken: string;
  sku: string;
  maxPages?: number;
}

export async function fetchAllOffersForSku(args: OffersDiscoveryArgs): Promise<OffersDiscovery> {
  const { fetchImpl, apiOrigin, accessToken, sku } = args;
  const maxPages = args.maxPages ?? OFFER_MAX_PAGES;
  if (!validateApiOrigin(apiOrigin)) return { ok: false, errorCode: "invalid_api_origin", httpStatus: null, safeProviderErrorId: null, pagesFetched: 0 };

  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" };
  let url = `${apiOrigin}${GET_OFFERS_PATH}?sku=${encodeURIComponent(sku)}&limit=100`;
  const seen = new Set<string>();
  const byId = new Map<string, OfferSummary>();
  let pages = 0;
  let expectedTotal: number | null = null;
  let providerSize: number | null = null;
  let prevOffset: number | null = null;

  for (;;) {
    if (pages >= maxPages) return { ok: false, errorCode: "pagination_limit_exceeded", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return { ok: false, errorCode: "pagination_loop", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    seen.add(canon);

    let r: OffersFetchResponse;
    // redirect:"manual" so a 3xx is returned (not followed); the bearer token is
    // never forwarded to a redirect target.
    try { r = await fetchImpl(url, { headers, redirect: "manual" }); }
    catch { return { ok: false, errorCode: "provider_lookup_failed", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages }; }
    if (r.status >= 300 && r.status < 400) return { ok: false, errorCode: "provider_redirect_rejected", httpStatus: r.status, safeProviderErrorId: null, pagesFetched: pages };
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;

    if (!r.ok) {
      if (r.status === 404 && is404NoOffers(data)) return { ok: true, offers: [], pagesFetched: pages, providerTotal: 0, providerSize: 0, deduplicatedCount: 0 };
      return { ok: false, errorCode: "provider_lookup_failed", httpStatus: r.status, safeProviderErrorId: safeErrorId(data), pagesFetched: pages };
    }

    pages += 1;
    const summaries = extractOfferSummaries(data);
    // size (when present) must equal this page's parsed offer count.
    if (typeof data.size === "number") { if (data.size !== summaries.length) return { ok: false, errorCode: "inconsistent_provider_pagination", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages }; providerSize = data.size; }
    // total must be constant across pages.
    if (typeof data.total === "number") {
      if (expectedTotal === null) expectedTotal = data.total;
      else if (data.total !== expectedTotal) return { ok: false, errorCode: "inconsistent_provider_pagination", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    }
    // offset must be non-negative and strictly increasing.
    if (typeof data.offset === "number") {
      if (data.offset < 0 || (prevOffset !== null && data.offset <= prevOffset)) return { ok: false, errorCode: "inconsistent_provider_pagination", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
      prevOffset = data.offset;
    }
    // A well-formed paginated response never repeats an offerId across pages.
    for (const s of summaries) {
      if (byId.has(s.offerId)) return { ok: false, errorCode: "inconsistent_provider_pagination", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
      byId.set(s.offerId, s);
    }

    const next = typeof data.next === "string" && data.next ? data.next : null;
    if (!next) break;
    const v = validateNextUrl(next, apiOrigin, sku);
    if (!v.ok) return { ok: false, errorCode: "unsafe_pagination_url", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    url = next;
  }

  const offers = [...byId.values()];
  if (expectedTotal !== null) {
    if (offers.length < expectedTotal) return { ok: false, errorCode: "incomplete_provider_result", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    if (offers.length > expectedTotal) return { ok: false, errorCode: "inconsistent_provider_pagination", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
  }
  return { ok: true, offers, pagesFetched: pages, providerTotal: expectedTotal, providerSize, deduplicatedCount: 0 };
}
