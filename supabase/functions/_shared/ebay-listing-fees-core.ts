/**
 * Pure core for the admin-only eBay `listing_fees` read operation.
 *
 * No Deno, no fetch, no secrets: this module only VALIDATES the request and
 * STRICTLY ALLOWLISTS the provider response, so no unexpected provider field or
 * token-shaped value can flow back through the boundary. The `listing_fees`
 * branch in `_shared/ebay.ts` resolves the seller token server-side (never from
 * the caller) and performs the I/O; this core is unit-tested without Deno.
 */

export interface ListingFeesInput {
  accountId: string;
  offerIds: string[];
}

export type ListingFeesInputResult =
  | { ok: true; input: ListingFeesInput }
  | { ok: false; errorCode: string; message: string };

/** eBay's get_listing_fees accepts up to 250 offers; a UI read caps far lower. */
export const MAX_LISTING_FEE_OFFERS = 25;
const MAX_ID_LEN = 64;

function trimmedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s.length > 0 && s.length <= maxLen ? s : null;
}

/**
 * Validate the request body. Never trusts unbounded input: ids are trimmed,
 * length-bounded, de-duplicated, and capped.
 */
export function parseListingFeesInput(body: Record<string, unknown>): ListingFeesInputResult {
  const accountId = trimmedString(body.account_id, MAX_ID_LEN);
  if (!accountId) {
    return { ok: false, errorCode: "MISSING_ACCOUNT", message: "account_id is required." };
  }
  const rawIds = body.offer_ids;
  if (!Array.isArray(rawIds)) {
    return { ok: false, errorCode: "MISSING_OFFER_IDS", message: "offer_ids (array) is required." };
  }
  const seen = new Set<string>();
  const offerIds: string[] = [];
  for (const raw of rawIds) {
    const id = trimmedString(raw, MAX_ID_LEN);
    if (id && !seen.has(id)) {
      seen.add(id);
      offerIds.push(id);
    }
  }
  if (offerIds.length === 0) {
    return { ok: false, errorCode: "MISSING_OFFER_IDS", message: "At least one offer id is required." };
  }
  if (offerIds.length > MAX_LISTING_FEE_OFFERS) {
    return {
      ok: false,
      errorCode: "TOO_MANY_OFFER_IDS",
      message: `At most ${MAX_LISTING_FEE_OFFERS} offer ids per request.`,
    };
  }
  return { ok: true, input: { accountId, offerIds } };
}

export interface FeeAmount {
  value: string | null;
  currency: string | null;
}
export interface FeeLine {
  feeType: string | null;
  amount: FeeAmount;
}
export interface FeeSummary {
  offerId: string | null;
  marketplaceId: string | null;
  fees: FeeLine[];
}
export interface SanitizedListingFees {
  feeSummaries: FeeSummary[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Copy ONLY the known fee leaf fields; everything else the provider returns is
 * ignored. Fee amounts pass through as the provider's decimal strings (the
 * caller normalizes to integer cents). Because only these named leaves are ever
 * copied, no token/secret-shaped value can survive into the response.
 */
export function sanitizeListingFees(raw: unknown): SanitizedListingFees {
  const root = asRecord(raw);
  const summaries = root && Array.isArray(root.feeSummaries) ? root.feeSummaries : [];
  const feeSummaries: FeeSummary[] = [];
  for (const entry of summaries.slice(0, MAX_LISTING_FEE_OFFERS)) {
    const s = asRecord(entry);
    if (!s) continue;
    const fees: FeeLine[] = [];
    const rawFees = Array.isArray(s.fees) ? s.fees : [];
    for (const feeEntry of rawFees.slice(0, 50)) {
      const f = asRecord(feeEntry);
      if (!f) continue;
      const amount = asRecord(f.amount);
      fees.push({
        feeType: trimmedString(f.feeType, 128),
        amount: {
          value: trimmedString(amount?.value, 32),
          currency: trimmedString(amount?.currency, 8),
        },
      });
    }
    feeSummaries.push({
      offerId: trimmedString(s.offerId, MAX_ID_LEN),
      marketplaceId: trimmedString(s.marketplaceId, 32),
      fees,
    });
  }
  return { feeSummaries };
}
