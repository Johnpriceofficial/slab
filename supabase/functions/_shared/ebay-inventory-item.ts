// Fail-closed, dependency-injected eBay getInventoryItem discovery — the second
// provider READ (after getOffers) needed to prove the COMPLETE existing SKU state
// before any mutation. Testable with a mocked fetch. Never surfaces raw provider
// bodies, tokens, URLs, or PII.

import { validateApiOrigin } from "./ebay-offers.ts";

const INVENTORY_ITEM_PATH = "/sell/inventory/v1/inventory_item/";
// getInventoryItem 404 "no inventory item exists" (documented).
const NO_ITEM_ERROR_IDS = new Set([25710]);
export const INVENTORY_ITEM_TIMEOUT_MS = 10_000;

export interface NormalizedInventoryItem {
  sku: string;
  condition: string;
  conditionDescription: string;
  conditionDescriptors: string[];
  title: string;
  description: string;
  aspects: Record<string, unknown>;
  imageCount: number;
  quantity: number | null;
}

export type InventoryItemResult =
  | { ok: true; present: true; item: NormalizedInventoryItem }
  | { ok: true; present: false }                                  // documented absence
  | { ok: false; errorCode: string; httpStatus: number | null };

export interface InventoryFetchResponse { ok: boolean; status: number; json: () => Promise<unknown> }
export type InventoryFetchInit = { headers: Record<string, string>; redirect: "manual"; signal?: unknown };
export type InventoryFetchImpl = (url: string, init: InventoryFetchInit) => Promise<InventoryFetchResponse>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Strictly normalize the getInventoryItem body; a malformed shape returns null
// (invalid) rather than silently substituting empties.
function normalizeInventoryItem(data: unknown, sku: string): NormalizedInventoryItem | null {
  if (!isObj(data)) return null;
  // A provider-echoed SKU that differs from the requested (server-derived) SKU is
  // a mismatch, never silently accepted.
  if (typeof data.sku === "string" && data.sku !== sku) return null;
  const product = isObj(data.product) ? data.product : {};
  const avail = isObj(data.availability) ? data.availability : {};
  const shipTo = isObj(avail.shipToLocationAvailability) ? avail.shipToLocationAvailability : {};
  if (data.condition !== undefined && typeof data.condition !== "string") return null;
  if (data.conditionDescription !== undefined && typeof data.conditionDescription !== "string") return null;
  if (product.title !== undefined && typeof product.title !== "string") return null;
  if (product.description !== undefined && typeof product.description !== "string") return null;
  if (product.aspects !== undefined && !isObj(product.aspects)) return null;
  const rawImages = product.imageUrls;
  if (rawImages !== undefined && !Array.isArray(rawImages)) return null;
  const descriptors = data.conditionDescriptors;
  if (descriptors !== undefined && !Array.isArray(descriptors)) return null;
  const qtyRaw = shipTo.quantity;
  // A present quantity must be a non-negative safe integer; absent stays null.
  const quantity = qtyRaw === undefined ? null : (typeof qtyRaw === "number" && Number.isSafeInteger(qtyRaw) && qtyRaw >= 0 ? qtyRaw : NaN);
  if (Number.isNaN(quantity)) return null;
  return {
    sku,
    condition: str(data.condition),
    conditionDescription: str(data.conditionDescription),
    conditionDescriptors: Array.isArray(descriptors) ? descriptors.map((d) => (isObj(d) ? `${str(d.name)}=${(Array.isArray(d.values) ? d.values.map(str) : []).sort().join(",")}` : str(d))).filter(Boolean).sort() : [],
    title: str(product.title),
    description: str(product.description),
    aspects: isObj(product.aspects) ? product.aspects : {},
    imageCount: Array.isArray(rawImages) ? rawImages.length : 0,
    quantity,
  };
}

export interface InventoryItemArgs {
  fetchImpl: InventoryFetchImpl;
  apiOrigin: string;
  accessToken: string;
  sku: string;
  timeoutMs?: number;
}

export async function fetchInventoryItemForSku(args: InventoryItemArgs): Promise<InventoryItemResult> {
  const { fetchImpl, apiOrigin, accessToken, sku } = args;
  const timeoutMs = args.timeoutMs ?? INVENTORY_ITEM_TIMEOUT_MS;
  if (!validateApiOrigin(apiOrigin)) return { ok: false, errorCode: "invalid_api_origin", httpStatus: null };
  const url = `${apiOrigin}${INVENTORY_ITEM_PATH}${encodeURIComponent(sku)}`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" };

  let r: InventoryFetchResponse;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The module enforces its own timeout (in addition to any caller AbortController).
    const timeout = new Promise<"__timeout__">((resolve) => { timer = setTimeout(() => resolve("__timeout__"), Math.max(1, timeoutMs)); });
    const raced = await Promise.race([fetchImpl(url, { headers, redirect: "manual" }), timeout]);
    if (raced === "__timeout__") return { ok: false, errorCode: "provider_timeout", httpStatus: null };
    r = raced;
  } catch (e) {
    if (e && typeof e === "object" && (e as { name?: string }).name === "AbortError") return { ok: false, errorCode: "provider_timeout", httpStatus: null };
    return { ok: false, errorCode: "inventory_item_lookup_failed", httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
  if (r.status >= 300 && r.status < 400) return { ok: false, errorCode: "provider_redirect_rejected", httpStatus: r.status };
  const data = await r.json().catch(() => null);

  if (!r.ok) {
    if (r.status === 404) {
      const errs = isObj(data) && Array.isArray((data as Record<string, unknown>).errors) ? (data as { errors: Array<Record<string, unknown>> }).errors : [];
      if (errs.length > 0 && errs.every((er) => NO_ITEM_ERROR_IDS.has(Number(er?.errorId)))) return { ok: true, present: false };
    }
    return { ok: false, errorCode: "inventory_item_lookup_failed", httpStatus: r.status };
  }
  const item = normalizeInventoryItem(data, sku);
  if (item === null) return { ok: false, errorCode: "invalid_provider_response", httpStatus: r.status };
  return { ok: true, present: true, item };
}
