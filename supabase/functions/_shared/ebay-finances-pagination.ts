// Fail-closed, paginated eBay finance-transaction reader. Fetches EVERY page of
// the Finances getTransactions result (on the apiz gateway), strictly validating
// each transaction and every pagination page, and never returning partial data as
// success. Unknown enum / CustomCode values are PRESERVED (kept as strings), never
// coerced to zero/empty/success. DI fetch → fully unit-testable.

import { fetchAllPages, type ItemValidation, type PageFetchImpl, type PaginatedResult } from "./ebay-pagination-core.ts";

export const FINANCE_PATH = "/sell/finances/v1/transaction";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Deterministic canonical: object keys sorted at every depth; array order preserved.
export const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};

export type RawTransaction = Record<string, unknown>;

/** Strict transaction contract: non-empty transactionId; amount (when present) a
 *  plain object; date/status/type (when present) strings — unknown enum values are
 *  preserved as-is, never rejected or reinterpreted. The canonical form is the
 *  COMPLETE persisted provider record (every field kept in raw_response — amount,
 *  fee-basis, booking entry, order/payout/reference, unknown fields), so two
 *  same-id transactions that differ in ANY persisted field can never be silently
 *  deduplicated. The canonical is compared only in-memory — never logged/returned. */
export function validateTransaction(raw: unknown): ItemValidation<RawTransaction> {
  if (!isObj(raw)) return { ok: false };
  const id = raw.transactionId;
  if (typeof id !== "string" || !id) return { ok: false };
  if (raw.amount !== undefined && !isObj(raw.amount)) return { ok: false };
  for (const k of ["transactionDate", "transactionStatus", "transactionType"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") return { ok: false };
  }
  return { ok: true, id, item: raw, canonical: canon(raw) };
}

export interface FinanceFetchArgs {
  fetchImpl: PageFetchImpl;
  apiOrigin: string;   // the apiz origin
  accessToken: string;
  query?: Record<string, string>;
  maxPages?: number;
  timeoutMs?: number;
  beforePageFetch?: () => Promise<boolean>;
}

export function fetchAllEbayFinanceTransactions(args: FinanceFetchArgs): Promise<PaginatedResult<RawTransaction>> {
  return fetchAllPages<RawTransaction>({
    fetchImpl: args.fetchImpl, apiOrigin: args.apiOrigin, accessToken: args.accessToken,
    path: FINANCE_PATH, query: args.query ?? { limit: "200" }, itemsKey: "transactions",
    validateItem: validateTransaction, maxPages: args.maxPages, timeoutMs: args.timeoutMs, beforePageFetch: args.beforePageFetch,
  });
}
