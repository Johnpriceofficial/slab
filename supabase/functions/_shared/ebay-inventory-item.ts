// Fail-closed, dependency-injected eBay getInventoryItem discovery — the second
// provider READ (after getOffers) needed to prove the COMPLETE existing SKU state
// before any mutation. Testable with a mocked fetch. Never surfaces raw provider
// bodies, tokens, signed URLs, or PII.
//
// The read is bounded by an INTERNAL AbortController: on timeout the underlying
// request is actually aborted (not merely abandoned), the timer is cleared, and
// any late resolution/rejection is suppressed. A caller-supplied AbortSignal is
// honored and classified safely.

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
  aspects: Record<string, string[]>;
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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSafeNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isAbortError = (e: unknown): boolean => !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";

/**
 * Strictly normalize the getInventoryItem body. Missing REQUIRED state is never
 * coerced into an empty string/object/array/zero — a malformed shape returns null
 * (→ `invalid_provider_response`). Optional-in-contract state (absent quantity,
 * absent images) is handled explicitly as unverifiable by the comparison engine.
 */
export function normalizeInventoryItem(data: unknown, sku: string): NormalizedInventoryItem | null {
  if (!isObj(data)) return null;
  // A provider-echoed SKU that differs from the requested (server-derived) SKU is
  // a mismatch, never silently accepted. It is optional in the body (the SKU is in
  // the path); we NEVER fabricate one — the stored `sku` is the SKU we queried.
  if (data.sku !== undefined && data.sku !== sku) return null;

  if (!isObj(data.product)) return null;                        // product is required
  const product = data.product;
  if (!nonEmptyStr(data.condition)) return null;                // condition required, non-empty
  if (data.conditionDescription !== undefined && typeof data.conditionDescription !== "string") return null;
  if (!nonEmptyStr(product.title)) return null;                 // title required
  if (product.description !== undefined && typeof product.description !== "string") return null;

  // aspects: required object; keys non-empty strings; values arrays of strings.
  if (!isObj(product.aspects)) return null;
  const aspects: Record<string, string[]> = {};
  for (const key of Object.keys(product.aspects)) {
    const v = (product.aspects as Record<string, unknown>)[key];
    if (!nonEmptyStr(key) || !Array.isArray(v) || !v.every(nonEmptyStr)) return null;
    aspects[key] = [...(v as string[])].sort();
  }

  // imageUrls: optional; when present must be an array of non-empty HTTPS URLs.
  let imageCount = 0;
  if (product.imageUrls !== undefined) {
    if (!Array.isArray(product.imageUrls)) return null;
    for (const u of product.imageUrls) {
      if (!nonEmptyStr(u) || !u.startsWith("https://")) return null;
    }
    imageCount = product.imageUrls.length;
  }

  // conditionDescriptors: optional array of {name: string, values: string[]} or strings.
  let descriptors: string[] = [];
  if (data.conditionDescriptors !== undefined) {
    if (!Array.isArray(data.conditionDescriptors)) return null;
    const acc: string[] = [];
    for (const d of data.conditionDescriptors) {
      if (nonEmptyStr(d)) { acc.push(d); continue; }
      if (!isObj(d) || !nonEmptyStr(d.name)) return null;
      if (d.values !== undefined && (!Array.isArray(d.values) || !d.values.every(nonEmptyStr))) return null;
      const values = Array.isArray(d.values) ? [...(d.values as string[])].sort() : [];
      acc.push(`${d.name}=${values.join(",")}`);
    }
    descriptors = acc.sort();
  }

  // availability.shipToLocationAvailability.quantity: optional; when present a
  // non-negative safe integer (else invalid). Absent stays null (unverifiable).
  let quantity: number | null = null;
  if (data.availability !== undefined) {
    if (!isObj(data.availability)) return null;
    const shipTo = data.availability.shipToLocationAvailability;
    if (shipTo !== undefined) {
      if (!isObj(shipTo)) return null;
      if (shipTo.quantity !== undefined) {
        if (!isSafeNonNegInt(shipTo.quantity)) return null;
        quantity = shipTo.quantity;
      }
    }
  }

  return {
    sku,
    condition: data.condition,
    conditionDescription: typeof data.conditionDescription === "string" ? data.conditionDescription : "",
    conditionDescriptors: descriptors,
    title: product.title,
    description: typeof product.description === "string" ? product.description : "",
    aspects,
    imageCount,
    quantity,
  };
}

export interface InventoryItemArgs {
  fetchImpl: InventoryFetchImpl;
  apiOrigin: string;
  accessToken: string;
  sku: string;
  timeoutMs?: number;
  signal?: AbortSignal;   // optional caller-supplied abort (classified as provider_timeout)
}

export async function fetchInventoryItemForSku(args: InventoryItemArgs): Promise<InventoryItemResult> {
  const { fetchImpl, apiOrigin, accessToken, sku } = args;
  const timeoutMs = args.timeoutMs ?? INVENTORY_ITEM_TIMEOUT_MS;
  if (!validateApiOrigin(apiOrigin)) return { ok: false, errorCode: "invalid_api_origin", httpStatus: null };
  const url = `${apiOrigin}${INVENTORY_ITEM_PATH}${encodeURIComponent(sku)}`;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" };

  // Internal AbortController: the timeout (and any caller signal) actually cancels
  // the underlying request rather than leaving it running in the background.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { clearTimeout(timer); args.signal?.removeEventListener("abort", onCallerAbort); };

  const timeoutP = new Promise<"__timeout__">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("__timeout__"); }, Math.max(1, timeoutMs)); });
  const abortP = new Promise<"__aborted__">((resolve) => {
    if (controller.signal.aborted) resolve("__aborted__");
    else controller.signal.addEventListener("abort", () => resolve("__aborted__"), { once: true });
  });
  const fetchP = fetchImpl(url, { headers, redirect: "manual", signal: controller.signal });
  // Suppress a LATE rejection (after we've already returned on timeout/abort) so it
  // never surfaces as an unhandled rejection.
  fetchP.catch(() => {});

  let r: InventoryFetchResponse;
  try {
    const raced = await Promise.race([fetchP, timeoutP, abortP]);
    if (raced === "__timeout__" || raced === "__aborted__") { cleanup(); return { ok: false, errorCode: "provider_timeout", httpStatus: null }; }
    r = raced;
  } catch (e) {
    cleanup();
    if (isAbortError(e)) return { ok: false, errorCode: "provider_timeout", httpStatus: null };
    return { ok: false, errorCode: "inventory_item_lookup_failed", httpStatus: null };
  }
  cleanup();

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
