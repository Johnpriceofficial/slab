// Shared, FAIL-CLOSED, dependency-injected paginator for eBay collection reads
// (orders, finance transactions). It fetches EVERY reported provider page,
// validates continuation URLs + pagination metadata, dedupes identical duplicates,
// and NEVER returns partial data as success. Redirects, loops, page-cap breaches,
// unsafe next-URLs, incoherent metadata, malformed bodies, timeouts, and
// conflicting duplicates all fail closed. Raw provider bodies, tokens, URLs with
// sensitive parameters, and PII are never surfaced.

const APPROVED_API_ORIGINS = new Set(["https://api.ebay.com", "https://api.sandbox.ebay.com", "https://apiz.ebay.com", "https://apiz.sandbox.ebay.com"]);
export const SYNC_MAX_PAGES = 50;
export const PAGE_TIMEOUT_MS = 15_000;

export function validateApiOrigin(origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.pathname !== "/" && u.pathname !== "") return false;
  if (u.search || u.hash) return false;
  return APPROVED_API_ORIGINS.has(u.origin);
}

export function canonicalizeUrl(url: string): string {
  try { const u = new URL(url); u.searchParams.sort(); return u.toString(); } catch { return url; }
}

/** A provider `next` URL must be https, the EXACT approved origin, the EXACT
 *  resource path, with no embedded credentials and no fragment. */
export function validateNextUrl(next: string, apiOrigin: string, path: string): { ok: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(next); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "protocol" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  if (u.hash) return { ok: false, reason: "fragment" };
  if (u.origin !== apiOrigin) return { ok: false, reason: "origin" };
  if (u.pathname !== path) return { ok: false, reason: "path" };
  return { ok: true };
}

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface PageFetchResponse { ok: boolean; status: number; json: () => Promise<unknown> }
export type PageFetchInit = { headers: Record<string, string>; redirect: "manual"; signal?: unknown };
export type PageFetchImpl = (url: string, init: PageFetchInit) => Promise<PageFetchResponse>;

export type ItemValidation<T> = { ok: true; id: string; item: T; canonical: string } | { ok: false };

export type PaginatedResult<T> =
  | { ok: true; items: T[]; pagesFetched: number; providerTotal: number | null; deduplicatedCount: number }
  | { ok: false; errorCode: string; httpStatus: number | null; pagesFetched: number };

export interface PaginatorArgs<T> {
  fetchImpl: PageFetchImpl;
  apiOrigin: string;
  accessToken: string;
  path: string;
  query: Record<string, string>;
  itemsKey: string;
  validateItem: (raw: unknown) => ItemValidation<T>;
  maxPages?: number;
  timeoutMs?: number;
  // Per-page lease heartbeat: called BEFORE every provider page fetch (including
  // the first). Returning false aborts with `sync_lease_lost` before that fetch —
  // no further page, mapping, persistence, or completion occurs. It has no DB
  // access itself; the caller injects an assert-and-extend of the sync lease.
  beforePageFetch?: () => Promise<boolean>;
}

const isAbortError = (e: unknown): boolean => !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";

// One page fetch bounded by an internal AbortController (aborts the underlying
// request on timeout; suppresses late resolution/rejection).
async function fetchPage(fetchImpl: PageFetchImpl, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ kind: "ok"; r: PageFetchResponse } | { kind: "timeout" } | { kind: "network" }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"__timeout__">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("__timeout__"); }, Math.max(1, timeoutMs)); });
  const p = fetchImpl(url, { headers, redirect: "manual", signal: controller.signal });
  p.catch(() => {});
  try {
    const raced = await Promise.race([p, timeoutP]);
    clearTimeout(timer);
    if (raced === "__timeout__") return { kind: "timeout" };
    return { kind: "ok", r: raced };
  } catch (e) {
    clearTimeout(timer);
    return isAbortError(e) ? { kind: "timeout" } : { kind: "network" };
  }
}

export async function fetchAllPages<T>(args: PaginatorArgs<T>): Promise<PaginatedResult<T>> {
  const { fetchImpl, apiOrigin, accessToken, path, itemsKey, validateItem } = args;
  const maxPages = args.maxPages ?? SYNC_MAX_PAGES;
  const timeoutMs = args.timeoutMs ?? PAGE_TIMEOUT_MS;
  if (!validateApiOrigin(apiOrigin)) return { ok: false, errorCode: "invalid_api_origin", httpStatus: null, pagesFetched: 0 };

  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" };
  const qs = new URLSearchParams(args.query).toString();
  let url = `${apiOrigin}${path}${qs ? `?${qs}` : ""}`;
  const seen = new Set<string>();
  const byId = new Map<string, { item: T; canonical: string }>();
  let pages = 0, dedup = 0;
  let expectedTotal: number | null = null, expectedLimit: number | null = null, prevOffset: number | null = null;
  const fail = (errorCode: string, httpStatus: number | null = null): PaginatedResult<T> => ({ ok: false, errorCode, httpStatus, pagesFetched: pages });

  for (;;) {
    if (pages >= maxPages) return fail("pagination_limit_exceeded");
    // Lease heartbeat BEFORE every page fetch (extends the lease during a long
    // paginated run; a lost lease stops before this page is fetched).
    if (args.beforePageFetch && !(await args.beforePageFetch())) return fail("sync_lease_lost");
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return fail("pagination_loop");
    seen.add(canon);

    const res = await fetchPage(fetchImpl, url, headers, timeoutMs);
    if (res.kind === "timeout") return fail("provider_timeout");
    if (res.kind === "network") return fail("provider_lookup_failed");
    const r = res.r;
    if (r.status >= 300 && r.status < 400) return fail("provider_redirect_rejected", r.status);
    const data = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok) return fail("provider_lookup_failed", r.status);
    if (!isObj(data) || !Array.isArray(data[itemsKey])) return fail("malformed_provider_response");
    // Pagination metadata must be non-negative safe ints when present, and a total
    // must be reported so completeness is always checkable.
    for (const key of ["total", "limit", "offset", "size"] as const) {
      if (data[key] !== undefined && !isNonNegInt(data[key])) return fail("malformed_provider_response");
    }
    if (typeof data.total !== "number") return fail("malformed_provider_response");
    for (const key of ["next", "prev", "href"] as const) {
      if (data[key] !== undefined && typeof data[key] !== "string") return fail("malformed_provider_response");
    }

    pages += 1;
    const rawItems = data[itemsKey] as unknown[];
    for (const raw of rawItems) {
      const v = validateItem(raw);
      if (!v.ok) return fail("malformed_provider_response");
      const existing = byId.get(v.id);
      if (existing) {
        // Identical canonical content → dedupe; conflicting content → fail closed.
        if (existing.canonical !== v.canonical) return fail("inconsistent_provider_pagination");
        dedup += 1;
        continue;
      }
      byId.set(v.id, { item: v.item, canonical: v.canonical });
    }

    // Coherent pagination: size == raw page length; total + limit constant; offset
    // strictly increasing; href == canonical current URL; prev a safe same-path URL.
    if (typeof data.size === "number" && data.size !== rawItems.length) return fail("inconsistent_provider_pagination");
    if (expectedTotal === null) expectedTotal = data.total; else if (data.total !== expectedTotal) return fail("inconsistent_provider_pagination");
    if (typeof data.limit === "number") { if (expectedLimit === null) expectedLimit = data.limit; else if (data.limit !== expectedLimit) return fail("inconsistent_provider_pagination"); }
    if (typeof data.offset === "number") { if (prevOffset !== null && data.offset <= prevOffset) return fail("inconsistent_provider_pagination"); prevOffset = data.offset; }
    if (typeof data.href === "string" && canonicalizeUrl(data.href) !== canon) return fail("inconsistent_provider_pagination");
    if (typeof data.prev === "string" && !validateNextUrl(data.prev, apiOrigin, path).ok) return fail("inconsistent_provider_pagination");
    if (byId.size > (expectedTotal ?? Infinity)) return fail("inconsistent_provider_pagination");

    const next = typeof data.next === "string" && data.next ? data.next : null;
    if (!next) break;
    if (!validateNextUrl(next, apiOrigin, path).ok) return fail("unsafe_pagination_url");
    url = next;
  }

  const items = [...byId.values()].map((v) => v.item);
  if (expectedTotal !== null) {
    if (byId.size < expectedTotal) return fail("incomplete_provider_result");
    if (byId.size > expectedTotal) return fail("inconsistent_provider_pagination");
  }
  return { ok: true, items, pagesFetched: pages, providerTotal: expectedTotal, deduplicatedCount: dedup };
}
