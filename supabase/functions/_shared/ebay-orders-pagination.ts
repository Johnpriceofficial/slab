// Fail-closed, paginated eBay order reader. Fetches EVERY page of the Fulfillment
// getOrders result, strictly validating each order (non-empty orderId + structural
// line items) and every pagination page, and never returning partial data as
// success. Identical duplicate orders across pages are deduped; conflicting
// duplicates fail closed. DI fetch → fully unit-testable.

import { fetchAllPages, type ItemValidation, type PageFetchImpl, type PaginatedResult } from "./ebay-pagination-core.ts";

export const ORDERS_PATH = "/sell/fulfillment/v1/order";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};

export type RawOrder = Record<string, unknown>;

/** Strict order contract: non-empty orderId, and every line item a plain object
 *  with a non-empty lineItemId. The canonical form covers ALL persisted +
 *  decision-relevant fields (every status, creation/modification dates, pricing
 *  summary, cancellation state, and per-line id/sku/listing/qty/total/fulfillment/
 *  payment) with lines normalized by lineItemId, so two different orders can never
 *  be silently treated as identical. */
export function validateOrder(raw: unknown): ItemValidation<RawOrder> {
  if (!isObj(raw)) return { ok: false };
  const orderId = raw.orderId;
  if (typeof orderId !== "string" || !orderId) return { ok: false };
  const rawLines = raw.lineItems;
  if (rawLines !== undefined && !Array.isArray(rawLines)) return { ok: false };
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const canonLines: Array<Record<string, unknown>> = [];
  for (const li of lines) {
    if (!isObj(li) || typeof li.lineItemId !== "string" || !li.lineItemId) return { ok: false };
    canonLines.push({
      id: li.lineItemId, sku: li.sku ?? null, listingId: li.legacyItemId ?? li.listingMarketplaceId ?? null,
      qty: li.quantity ?? null, lineTotal: li.total ?? li.lineItemCost ?? null,
      fulfillment: li.lineItemFulfillmentStatus ?? null, payment: li.paymentStatus ?? null,
    });
  }
  canonLines.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const canonical = canon({
    orderId,
    fulfillmentStatus: raw.orderFulfillmentStatus ?? null,
    paymentStatus: raw.orderPaymentStatus ?? null,
    cancelState: isObj(raw.cancelStatus) ? (raw.cancelStatus.cancelState ?? null) : null,
    creationDate: raw.creationDate ?? null,
    lastModifiedDate: raw.lastModifiedDate ?? null,
    pricing: raw.pricingSummary ?? null,
    lines: canonLines,
  });
  return { ok: true, id: orderId, item: raw, canonical };
}

export interface OrdersFetchArgs {
  fetchImpl: PageFetchImpl;
  apiOrigin: string;
  accessToken: string;
  query?: Record<string, string>;   // e.g. { filter: "creationdate:[...]", limit: "200" }
  maxPages?: number;
  timeoutMs?: number;
}

export function fetchAllEbayOrders(args: OrdersFetchArgs): Promise<PaginatedResult<RawOrder>> {
  return fetchAllPages<RawOrder>({
    fetchImpl: args.fetchImpl, apiOrigin: args.apiOrigin, accessToken: args.accessToken,
    path: ORDERS_PATH, query: args.query ?? { limit: "200" }, itemsKey: "orders",
    validateItem: validateOrder, maxPages: args.maxPages, timeoutMs: args.timeoutMs,
  });
}
