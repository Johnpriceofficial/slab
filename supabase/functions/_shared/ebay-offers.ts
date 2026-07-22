// Fail-closed, dependency-injected eBay getOffers discovery. The full multi-page
// workflow is testable with a mocked fetch (no Deno/npm imports beyond the pure
// summary parser), so pagination loops, page caps, unsafe `next` links, and
// incomplete provider results are proven — not assumed. NO offer may be created,
// adopted, published, or reconciled unless discovery here completed IN FULL.

import { extractOfferSummaries, type OfferSummary } from "./ebay-listing-core.ts";

// Documented eBay "no offers exist for this SKU" error ids (getOffers 404).
export const EBAY_NO_OFFERS_ERROR_IDS = new Set([25702, 25710, 25713]);
// Server-controlled page cap; the browser cannot raise it.
export const OFFER_MAX_PAGES = 20;
const GET_OFFERS_PATH = "/sell/inventory/v1/offer";

export type OffersDiscovery =
  | { ok: true; offers: OfferSummary[]; pagesFetched: number; providerTotal: number | null; providerSize: number | null; deduplicatedCount: number }
  | { ok: false; errorCode: string; httpStatus: number | null; safeProviderErrorId: number | null; pagesFetched: number };

export interface OffersFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
export type OffersFetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<OffersFetchResponse>;

/**
 * Strictly validate a provider `next` pagination URL before following it: https,
 * EXACT approved origin (so an alternate port or foreign host is rejected), the
 * exact getOffers path, no embedded credentials, no fragment, and the same
 * canonical SKU. The bearer token must never leave the approved origin/path.
 */
export function validateNextUrl(next: string, apiOrigin: string, sku: string): { ok: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(next); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "protocol" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  if (u.hash) return { ok: false, reason: "fragment" };
  if (u.origin !== apiOrigin) return { ok: false, reason: "origin" }; // origin = proto+host+port → alternate port rejected
  if (u.pathname !== GET_OFFERS_PATH) return { ok: false, reason: "path" };
  if ((u.searchParams.get("sku") ?? "") !== sku) return { ok: false, reason: "sku" };
  return { ok: true };
}

function safeErrorId(data: Record<string, unknown>): number | null {
  const errs = Array.isArray(data.errors) ? data.errors as Array<Record<string, unknown>> : [];
  const id = errs[0] ? Number(errs[0].errorId) : NaN;
  return Number.isFinite(id) ? id : null;
}

export interface OffersDiscoveryArgs {
  fetchImpl: OffersFetchImpl;
  apiOrigin: string;
  accessToken: string;
  sku: string;
  maxPages?: number;
}

/**
 * Retrieve ALL offers for a SKU across pages, failing CLOSED. Returns a
 * discriminated result; a partial collection is NEVER returned as complete.
 * Raw provider bodies, tokens, and URLs are never surfaced.
 */
export async function fetchAllOffersForSku(args: OffersDiscoveryArgs): Promise<OffersDiscovery> {
  const { fetchImpl, apiOrigin, accessToken, sku } = args;
  const maxPages = args.maxPages ?? OFFER_MAX_PAGES;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" };
  let url = `${apiOrigin}${GET_OFFERS_PATH}?sku=${encodeURIComponent(sku)}&limit=100`;
  const seen = new Set<string>();
  const byId = new Map<string, OfferSummary>();
  let pages = 0;
  let rawCount = 0;
  let providerTotal: number | null = null;
  let providerSize: number | null = null;

  for (;;) {
    if (pages >= maxPages) return { ok: false, errorCode: "pagination_limit_exceeded", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    if (seen.has(url)) return { ok: false, errorCode: "pagination_loop", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    seen.add(url);

    let r: OffersFetchResponse;
    try { r = await fetchImpl(url, { headers }); }
    catch { return { ok: false, errorCode: "provider_lookup_failed", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages }; }
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;

    if (!r.ok) {
      // 404 is "no offers" ONLY for a documented no-offer error id; anything else
      // (incl. an unrecognized 404) is a lookup failure, never treated as empty.
      if (r.status === 404) {
        const errs = Array.isArray(data.errors) ? data.errors as Array<Record<string, unknown>> : [];
        if (errs.some((e) => EBAY_NO_OFFERS_ERROR_IDS.has(Number(e.errorId)))) {
          return { ok: true, offers: [], pagesFetched: pages, providerTotal: 0, providerSize: 0, deduplicatedCount: 0 };
        }
      }
      return { ok: false, errorCode: "provider_lookup_failed", httpStatus: r.status, safeProviderErrorId: safeErrorId(data), pagesFetched: pages };
    }

    pages += 1;
    const summaries = extractOfferSummaries(data);
    rawCount += summaries.length;
    for (const s of summaries) byId.set(s.offerId, s);
    if (typeof data.total === "number") providerTotal = data.total;
    if (typeof data.size === "number") providerSize = data.size;

    const next = typeof data.next === "string" && data.next ? data.next : null;
    if (!next) break;
    const v = validateNextUrl(next, apiOrigin, sku);
    if (!v.ok) return { ok: false, errorCode: "unsafe_pagination_url", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
    url = next;
  }

  const offers = [...byId.values()];
  // Completeness: if the provider reports MORE offers than we collected and there
  // is no further page, the result is incomplete — never a "complete empty".
  if (providerTotal !== null && providerTotal > offers.length) {
    return { ok: false, errorCode: "incomplete_provider_result", httpStatus: null, safeProviderErrorId: null, pagesFetched: pages };
  }
  return { ok: true, offers, pagesFetched: pages, providerTotal, providerSize, deduplicatedCount: rawCount - offers.length };
}
