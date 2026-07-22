// Fail-closed, paginated eBay order reader. Fetches EVERY page of the Fulfillment
// getOrders result, strictly validating each order (non-empty orderId + structural
// line items) and every pagination page, and never returning partial data as
// success. Identical duplicate orders across pages are deduped; conflicting
// duplicates fail closed. DI fetch → fully unit-testable.

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

/** Strict order contract: non-empty orderId, and every line item a plain object
 *  with a non-empty lineItemId. The canonical form is the COMPLETE persisted
 *  provider record (every field kept in raw_response — buyer, fulfillment
 *  instructions, cancellation, pricing, unknown fields, and all line data) with
 *  lineItems normalized by lineItemId, so two same-id records that differ in ANY
 *  persisted field can never be silently deduplicated. The canonical is compared
 *  only in-memory — never logged or returned. */
export function validateOrder(raw: unknown): ItemValidation<RawOrder> {
  if (!isObj(raw)) return { ok: false };
  const orderId = raw.orderId;
  if (typeof orderId !== "string" || !orderId) return { ok: false };
  const rawLines = raw.lineItems;
  if (rawLines !== undefined && !Array.isArray(rawLines)) return { ok: false };
  const lines = Array.isArray(rawLines) ? rawLines : [];
  for (const li of lines) {
    if (!isObj(li) || typeof li.lineItemId !== "string" || !li.lineItemId) return { ok: false };
  }
  // Compare the ENTIRE record; normalize only lineItem ORDER (by lineItemId) so a
  // line reordering alone is not a false conflict.
  const normalized: Record<string, unknown> = Array.isArray(rawLines)
    ? { ...raw, lineItems: [...lines].sort((a, b) => (String((a as Record<string, unknown>).lineItemId) < String((b as Record<string, unknown>).lineItemId) ? -1 : String((a as Record<string, unknown>).lineItemId) > String((b as Record<string, unknown>).lineItemId) ? 1 : 0)) }
    : { ...raw };
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
