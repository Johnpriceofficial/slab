// Fail-closed, paginated eBay order reader. Fetches EVERY page of the Fulfillment
// getOrders result, strictly validating each order (non-empty orderId + a present
// lineItems array whose entries have non-empty, order-unique lineItemIds) and every
// pagination page, and never returning partial data as success. Identical duplicate
// orders across pages are deduped; conflicting duplicates fail closed. DI fetch →
// fully unit-testable.

import { fetchAllPages, type ItemValidation, type PageFetchImpl, type PaginatedResult } from "./ebay-pagination-core.ts";

export const ORDERS_PATH = "/sell/fulfillment/v1/order";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Deterministic canonical serialization: object keys sorted at every depth (so key
// order never matters); array order preserved (callers normalize meaningful arrays).
export const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};

export type RawOrder = Record<string, unknown>;

/** Strict order contract: non-empty orderId, and lineItems a PRESENT array in which
 *  every entry is a plain object with a non-empty lineItemId that is UNIQUE within the
 *  order. A missing/non-array lineItems, a line missing its id, or ANY repeated
 *  lineItemId (identical or conflicting) is rejected as malformed — two copies of the
 *  same line must never reach shaping, proposed sales, or persistence, so we fail closed
 *  rather than risk overwriting one line with another or inflating counts/proposed sales.
 *  The canonical form is the COMPLETE persisted provider record (every field kept in
 *  raw_response — buyer, fulfillment instructions, cancellation, pricing, unknown fields,
 *  and all line data) with lineItems normalized by lineItemId, so two same-id records
 *  that differ in ANY persisted field can never be silently deduplicated. The canonical
 *  is compared only in-memory — never logged or returned. */
export function validateOrder(raw: unknown): ItemValidation<RawOrder> {
  if (!isObj(raw)) return { ok: false };
  const orderId = raw.orderId;
  if (typeof orderId !== "string" || !orderId) return { ok: false };
  // A fulfillment order always carries its lines: lineItems MUST be a present array.
  const rawLines = raw.lineItems;
  if (!Array.isArray(rawLines)) return { ok: false };
  // Every line: a plain object with a non-empty, order-unique lineItemId.
  const seen = new Set<string>();
  for (const li of rawLines) {
    if (!isObj(li) || typeof li.lineItemId !== "string" || !li.lineItemId) return { ok: false };
    if (seen.has(li.lineItemId)) return { ok: false }; // repeated lineItemId → malformed (fail closed)
    seen.add(li.lineItemId);
  }
  // Compare the ENTIRE record; normalize only lineItem ORDER (by lineItemId) so a
  // line reordering alone is not a false conflict.
  const normalized: Record<string, unknown> = { ...raw, lineItems: [...rawLines].sort((a, b) => { const ai = String((a as Record<string, unknown>).lineItemId), bi = String((b as Record<string, unknown>).lineItemId); return ai < bi ? -1 : ai > bi ? 1 : 0; }) };
  return { ok: true, id: orderId, item: raw, canonical: canon(normalized) };
}

export interface OrdersFetchArgs {
  fetchImpl: PageFetchImpl;
  apiOrigin: string;
  accessToken: string;
  query?: Record<string, string>;   // e.g. { filter: "lastmodifieddate:[...]", limit: "200" }
  maxPages?: number;
  timeoutMs?: number;
  beforePageFetch?: () => Promise<boolean>;
}

export function fetchAllEbayOrders(args: OrdersFetchArgs): Promise<PaginatedResult<RawOrder>> {
  return fetchAllPages<RawOrder>({
    fetchImpl: args.fetchImpl, apiOrigin: args.apiOrigin, accessToken: args.accessToken,
    path: ORDERS_PATH, query: args.query ?? { limit: "200" }, itemsKey: "orders",
    validateItem: validateOrder, maxPages: args.maxPages, timeoutMs: args.timeoutMs, beforePageFetch: args.beforePageFetch,
  });
}
