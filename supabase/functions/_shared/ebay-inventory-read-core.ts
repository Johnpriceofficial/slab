/**
 * Pure core for the admin-only eBay `inventory_read` operation.
 *
 * The Edge handler owns authentication, token resolution, and provider I/O.
 * This module only validates bounded input and copies a strict allowlist from
 * eBay inventory-item and offer responses. Unknown fields are never returned.
 */

export interface InventoryReadInput {
  accountId: string;
  limit: number;
  offset: number;
}

export type InventoryReadInputResult =
  | { ok: true; input: InventoryReadInput }
  | { ok: false; errorCode: string; message: string };

export const DEFAULT_INVENTORY_READ_LIMIT = 25;
export const MAX_INVENTORY_READ_LIMIT = 25;
export const MAX_INVENTORY_READ_OFFSET = 100_000;
export const MAX_OFFERS_PER_SKU = 25;

const MAX_ACCOUNT_ID_LENGTH = 64;
const MAX_SKU_LENGTH = 128;

function trimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= minimum && value <= maximum ? value : null;
}

export function parseInventoryReadInput(
  body: Record<string, unknown>,
): InventoryReadInputResult {
  const accountId = trimmedString(body.account_id, MAX_ACCOUNT_ID_LENGTH);
  if (!accountId) {
    return {
      ok: false,
      errorCode: "MISSING_ACCOUNT",
      message: "account_id is required.",
    };
  }

  const limit = boundedInteger(
    body.limit,
    DEFAULT_INVENTORY_READ_LIMIT,
    1,
    MAX_INVENTORY_READ_LIMIT,
  );
  if (limit === null) {
    return {
      ok: false,
      errorCode: "INVALID_LIMIT",
      message: `limit must be an integer from 1 to ${MAX_INVENTORY_READ_LIMIT}.`,
    };
  }

  const offset = boundedInteger(body.offset, 0, 0, MAX_INVENTORY_READ_OFFSET);
  if (offset === null) {
    return {
      ok: false,
      errorCode: "INVALID_OFFSET",
      message: `offset must be an integer from 0 to ${MAX_INVENTORY_READ_OFFSET}.`,
    };
  }

  return { ok: true, input: { accountId, limit, offset } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalarString(value: unknown, maxLength: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return trimmedString(String(value), maxLength);
  }
  return trimmedString(value, maxLength);
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export interface SanitizedInventoryOffer {
  offerId: string | null;
  status: string | null;
  marketplaceId: string | null;
  format: string | null;
  price: {
    value: string | null;
    currency: string | null;
  };
  listingId: string | null;
}

export interface SanitizedInventoryItem {
  sku: string;
  title: string | null;
  condition: string | null;
  qty: number | null;
  offers: SanitizedInventoryOffer[];
}

export interface SanitizedInventoryRead {
  items: SanitizedInventoryItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number | null;
    size: number;
  };
}

function sanitizeOffers(raw: unknown): SanitizedInventoryOffer[] {
  const root = asRecord(raw);
  const providerOffers = root && Array.isArray(root.offers) ? root.offers : [];
  const offers: SanitizedInventoryOffer[] = [];

  for (const entry of providerOffers.slice(0, MAX_OFFERS_PER_SKU)) {
    const offer = asRecord(entry);
    if (!offer) continue;
    const pricingSummary = asRecord(offer.pricingSummary);
    const price = asRecord(pricingSummary?.price);
    const listing = asRecord(offer.listing);

    offers.push({
      offerId: trimmedString(offer.offerId, 128),
      status: trimmedString(offer.status, 64),
      marketplaceId: trimmedString(offer.marketplaceId, 32),
      format: trimmedString(offer.format, 64),
      price: {
        value: scalarString(price?.value, 32),
        currency: trimmedString(price?.currency, 8),
      },
      listingId: trimmedString(listing?.listingId, 128),
    });
  }

  return offers;
}

export function sanitizeInventoryRead(
  rawInventory: unknown,
  offersBySku: Record<string, unknown>,
  input: Pick<InventoryReadInput, "limit" | "offset">,
): SanitizedInventoryRead {
  const root = asRecord(rawInventory);
  const providerItems = root && Array.isArray(root.inventoryItems) ? root.inventoryItems : [];
  const items: SanitizedInventoryItem[] = [];

  for (const entry of providerItems.slice(0, input.limit)) {
    const item = asRecord(entry);
    if (!item) continue;
    const sku = trimmedString(item.sku, MAX_SKU_LENGTH);
    if (!sku) continue;

    const product = asRecord(item.product);
    const availability = asRecord(item.availability);
    const shipToLocation = asRecord(availability?.shipToLocationAvailability);

    items.push({
      sku,
      title: trimmedString(product?.title, 500),
      condition: trimmedString(item.condition, 128),
      qty: nonNegativeInteger(shipToLocation?.quantity),
      offers: sanitizeOffers(offersBySku[sku]),
    });
  }

  return {
    items,
    pagination: {
      limit: input.limit,
      offset: input.offset,
      total: nonNegativeInteger(root?.total),
      size: items.length,
    },
  };
}
