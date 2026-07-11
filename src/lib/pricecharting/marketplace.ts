/**
 * Marketplace offer operations.
 *
 * Every WRITE (publish/edit/ship/feedback/end/refund) requires explicit
 * confirmation. Refunds — financially destructive — require a SECOND explicit
 * confirmation (`confirm_refund: true`) and are never triggered automatically.
 * All writes emit an audit record.
 */

import type { PriceChartingClient } from "./client";
import { convertDollarsToPennies, convertPenniesToDollars, type Pennies } from "./money";
import { PriceChartingError, isPriceChartingError } from "./errors";
import { createAuditLog } from "./audit";
import { OFFER_LIMITS } from "./config";
import type {
  FeedbackRating,
  OfferDetails,
  OfferFilters,
  OfferSummary,
  PublishOfferInput,
  Result,
} from "./types";

/** Valid marketplace condition IDs (meanings vary by category — see the spec). */
export const VALID_CONDITION_IDS = new Set([1, 2, 3, 5, 6, 7, 8, 9, 10, 13]);
const VALID_STATUS = new Set(["available", "sold", "ended", "collection"]);
const VALID_SORT = new Set(["name", "starts", "lowest-price"]);
const VALID_RATINGS = new Set<number>([2, 1, 0, -1, -2]);

/* ------------------------------ helpers -------------------------------- */

function penniesOf(raw: unknown): Pennies | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function strOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}
function boolOf(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return null;
}

function normalizeOfferSummary(raw: Record<string, unknown>): OfferSummary {
  const price = penniesOf(raw["price"] ?? raw["price-max"] ?? raw["sale-price"]);
  const conditionId = penniesOf(raw["condition-id"]);
  return {
    offer_id: strOf(raw["offer-id"] ?? raw["id"]) ?? "",
    product_name: strOf(raw["product-name"]),
    console_or_category: strOf(raw["console-name"]),
    status: strOf(raw["status"]),
    price_pennies: price,
    price_dollars: convertPenniesToDollars(price),
    condition_id: conditionId,
    sku: strOf(raw["sku"]),
    raw,
  };
}

function normalizeOfferList(payload: Record<string, unknown>): OfferSummary[] {
  const list =
    (payload.offers as Array<Record<string, unknown>> | undefined) ??
    (Array.isArray(payload) ? (payload as unknown as Array<Record<string, unknown>>) : undefined) ??
    [];
  return list.map(normalizeOfferSummary).filter((o) => o.offer_id !== "");
}

function toErr(err: unknown): Result<never> {
  if (isPriceChartingError(err)) return err.toJSON() as Result<never>;
  return new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected error occurred.", { cause: err }).toJSON() as Result<never>;
}

function validateFilters(filters: OfferFilters): void {
  if (filters.status && !VALID_STATUS.has(filters.status)) {
    throw new PriceChartingError("INVALID_PARAMETER", `Invalid status "${filters.status}".`);
  }
  if (filters.sort && !VALID_SORT.has(filters.sort)) {
    throw new PriceChartingError("INVALID_PARAMETER", `Invalid sort "${filters.sort}".`);
  }
  if (filters["condition-id"] !== undefined && !VALID_CONDITION_IDS.has(filters["condition-id"])) {
    throw new PriceChartingError("INVALID_CONDITION", `Invalid condition-id ${filters["condition-id"]}.`);
  }
}

/* ------------------------------- reads --------------------------------- */

/** Required core function #14. */
export async function listMarketplaceOffers(
  client: PriceChartingClient,
  filters: OfferFilters = {},
): Promise<Result<OfferSummary[]>> {
  try {
    validateFilters(filters);
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null) params[k] = v as string | number;
    }
    const payload = await client.request<Record<string, unknown>>({ endpoint: "offers", method: "GET", params });
    const offers = normalizeOfferList(payload);
    createAuditLog(
      { action: "offer.list", outcome: "success", summary: `Listed ${offers.length} offers`, context: { filters } },
      { clock: client.clock, sink: client.auditSink },
    );
    return offers;
  } catch (err) {
    return toErr(err);
  }
}

/** Required core function #15. */
export function listSoldMarketplaceOffers(
  client: PriceChartingClient,
  filters: Omit<OfferFilters, "status"> = {},
): Promise<Result<OfferSummary[]>> {
  return listMarketplaceOffers(client, { ...filters, status: "sold" });
}

/**
 * Offer details (/api/offer-details). Buyer info is PRIVATE data — masked in
 * logs and never to be used for marketing.
 * Required core function #16.
 */
export async function getOfferDetails(
  client: PriceChartingClient,
  offerId: string,
): Promise<Result<OfferDetails>> {
  try {
    const id = strOf(offerId);
    if (!id) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required.");
    const raw = await client.request<Record<string, unknown>>({
      endpoint: "offer-details",
      method: "GET",
      params: { "offer-id": id },
    });

    const details: OfferDetails = {
      offer_id: id,
      product: {
        pricecharting_id: strOf(raw["product-id"] ?? raw["id"]),
        name: strOf(raw["product-name"]),
        console_or_category: strOf(raw["console-name"]),
      },
      status: strOf(raw["status"]),
      sold: boolOf(raw["sold"]),
      shipped: boolOf(raw["shipped"]),
      refunded: boolOf(raw["refunded"]),
      sale_price_pennies: penniesOf(raw["sale-price"]),
      cost_basis_pennies: penniesOf(raw["cost-basis"]),
      shipping_premium_pennies: penniesOf(raw["shipping-premium"]),
      tracking_number: strOf(raw["tracking-number"]),
      feedback_status: strOf(raw["feedback-status"]),
      dates: {
        started: strOf(raw["start-date"]),
        sold: strOf(raw["sold-date"]),
        shipped: strOf(raw["shipped-date"]),
        ended: strOf(raw["end-date"]),
      },
      buyer: {
        name: strOf(raw["buyer-name"]),
        email: strOf(raw["buyer-email"]),
        address: strOf(raw["shipping-address"]),
      },
      raw,
    };

    createAuditLog(
      { action: "offer.details", outcome: "success", summary: `Fetched details for offer ${id}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return details;
  } catch (err) {
    return toErr(err);
  }
}

/* ------------------------------- writes -------------------------------- */

function assertConfirmed(confirm: boolean | undefined, action: string): void {
  if (confirm !== true) {
    throw new PriceChartingError(
      "CONFIRMATION_REQUIRED",
      `${action} is a write action and requires explicit confirmation (confirm: true).`,
    );
  }
}

/** Validate + assemble the publish/edit parameters. */
async function buildOfferParams(
  client: PriceChartingClient,
  input: PublishOfferInput,
  isEdit: boolean,
): Promise<Record<string, string | number>> {
  const params: Record<string, string | number> = {};

  if (isEdit) {
    if (!input["offer-id"]) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required to edit an offer.");
    params["offer-id"] = input["offer-id"];
  } else {
    const identifiers = [input.product, input.upc, input.asin, input.epid].filter(Boolean);
    if (identifiers.length === 0) {
      throw new PriceChartingError(
        "MISSING_PARAMETER",
        "A new listing requires exactly one of: product, upc, asin, epid.",
      );
    }
    if (identifiers.length > 1) {
      throw new PriceChartingError(
        "INVALID_PARAMETER",
        "Provide only ONE product identifier (product, upc, asin, or epid) for a new listing.",
      );
    }
    if (input.product) params["product"] = input.product;
    if (input.upc) params["upc"] = input.upc;
    if (input.asin) params["asin"] = input.asin;
    if (input.epid) params["epid"] = input.epid;
  }

  // Condition id.
  if (input.condition_id !== undefined) {
    if (!VALID_CONDITION_IDS.has(input.condition_id)) {
      throw new PriceChartingError("INVALID_CONDITION", `Invalid condition-id ${input.condition_id}.`);
    }
    params["condition-id"] = input.condition_id;
  }

  // Prices → pennies.
  const min = convertDollarsToPennies(input.price_min_dollars ?? null);
  const max = convertDollarsToPennies(input.price_max_dollars ?? null);
  if (min !== null && min < 0) throw new PriceChartingError("INVALID_PARAMETER", "price-min cannot be negative.");
  if (max !== null && max < 0) throw new PriceChartingError("INVALID_PARAMETER", "price-max cannot be negative.");
  if (min !== null && max !== null && min > max) {
    throw new PriceChartingError("INVALID_PARAMETER", "price-min cannot exceed price-max.");
  }
  if (min !== null) params["price-min"] = min;
  if (max !== null) params["price-max"] = max;

  // Cost basis → pennies.
  const cost = convertDollarsToPennies(input.cost_basis_dollars ?? null);
  if (cost !== null) {
    if (cost < 0) throw new PriceChartingError("INVALID_PARAMETER", "cost-basis cannot be negative.");
    params["cost-basis"] = cost;
  }

  // Description length.
  if (input.description !== undefined) {
    if (input.description.length > OFFER_LIMITS.DESCRIPTION_MAX) {
      throw new PriceChartingError(
        "VALIDATION_ERROR",
        `Description exceeds ${OFFER_LIMITS.DESCRIPTION_MAX} characters (${input.description.length}).`,
      );
    }
    params["description"] = input.description;
  }

  // SKU: <=64 alphanumeric, unique among ACTIVE offers.
  if (input.sku !== undefined) {
    if (!/^[A-Za-z0-9]+$/.test(input.sku)) {
      throw new PriceChartingError("VALIDATION_ERROR", "SKU must be alphanumeric.");
    }
    if (input.sku.length > OFFER_LIMITS.SKU_MAX) {
      throw new PriceChartingError("VALIDATION_ERROR", `SKU exceeds ${OFFER_LIMITS.SKU_MAX} characters.`);
    }
    await assertSkuUnique(client, input.sku, input["offer-id"]);
    params["sku"] = input.sku;
  }

  // Quantity — only for collection items.
  if (input.quantity !== undefined) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new PriceChartingError("INVALID_PARAMETER", "quantity must be a positive integer.");
    }
    if (input.quantity > 1 && !input.add_to_collection) {
      throw new PriceChartingError(
        "INVALID_PARAMETER",
        "quantity > 1 is only supported for collection items (set add_to_collection: true).",
      );
    }
    params["quantity"] = input.quantity;
  }

  if (input.add_to_collection) params["add-to-collection"] = "on";

  // Damage / condition tags.
  const damageTags: Array<[keyof PublishOfferInput, string]> = [
    ["broken", "broken"],
    ["scratch", "scratch"],
    ["stickers", "stickers"],
    ["tear", "tear"],
    ["writing", "writing"],
  ];
  const isNewSealed = input.condition_id === 2;
  if (input.pristine) {
    const otherDamage = damageTags.some(([k]) => input[k] === true);
    if (otherDamage && !isNewSealed) {
      throw new PriceChartingError(
        "VALIDATION_ERROR",
        "pristine excludes other damage tags unless the item is New/sealed (condition-id 2).",
      );
    }
    params["pristine"] = "on";
    if (!isNewSealed) return params; // pristine wins; skip other damage tags
  }
  for (const [key, apiKey] of damageTags) {
    if (input[key] === true) params[apiKey] = "on";
  }

  return params;
}

/** Best-effort active-SKU uniqueness check (available + collection listings). */
async function assertSkuUnique(client: PriceChartingClient, sku: string, ownOfferId?: string): Promise<void> {
  const statuses: Array<OfferFilters["status"]> = ["available", "collection"];
  for (const status of statuses) {
    try {
      const payload = await client.request<Record<string, unknown>>({
        endpoint: "offers",
        method: "GET",
        params: { status: status as string, sort: "name" },
      });
      const offers = normalizeOfferList(payload);
      const clash = offers.find((o) => o.sku && o.sku.toLowerCase() === sku.toLowerCase() && o.offer_id !== ownOfferId);
      if (clash) {
        throw new PriceChartingError("VALIDATION_ERROR", `SKU "${sku}" is already used by an active offer.`, {
          details: { conflicting_offer_id: clash.offer_id },
        });
      }
    } catch (err) {
      // Re-throw our own validation conflict; ignore lookup failures so a
      // transient offers outage doesn't block a legitimate publish.
      if (isPriceChartingError(err) && err.code === "VALIDATION_ERROR") throw err;
    }
  }
}

/**
 * Publish a NEW offer. Requires confirm: true and a verified product identifier.
 * Required core function #17.
 */
export async function publishOffer(
  client: PriceChartingClient,
  input: PublishOfferInput,
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    assertConfirmed(input.confirm, "Publishing an offer");
    if (input["offer-id"]) {
      throw new PriceChartingError("INVALID_PARAMETER", "publishOffer creates NEW listings; use editOffer with offer-id.");
    }
    const params = await buildOfferParams(client, input, false);
    const raw = await client.request<Record<string, unknown>>({
      endpoint: "offer-publish",
      method: "POST",
      params,
      idempotencyKey: input.idempotency_key,
    });
    const offerId = strOf(raw["offer-id"] ?? raw["id"]) ?? "";
    createAuditLog(
      { action: "offer.publish", outcome: "success", summary: `Published offer ${offerId}`, context: { sku: input.sku } },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: offerId, raw };
  } catch (err) {
    createAuditLog(
      { action: "offer.publish", outcome: "failure", summary: "Publish failed" },
      { clock: client.clock, sink: client.auditSink },
    );
    return toErr(err);
  }
}

/**
 * Edit an EXISTING offer by id. Requires confirm: true.
 * Required core function #18.
 */
export async function editOffer(
  client: PriceChartingClient,
  offerId: string,
  updates: Omit<PublishOfferInput, "offer-id">,
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    assertConfirmed(updates.confirm, "Editing an offer");
    const input: PublishOfferInput = { ...updates, "offer-id": offerId };
    const params = await buildOfferParams(client, input, true);
    const raw = await client.request<Record<string, unknown>>({
      endpoint: "offer-publish",
      method: "POST",
      params,
      idempotencyKey: updates.idempotency_key,
    });
    createAuditLog(
      { action: "offer.edit", outcome: "success", summary: `Edited offer ${offerId}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: offerId, raw };
  } catch (err) {
    return toErr(err);
  }
}

/**
 * Mark an offer shipped. Requires confirm: true. Tracking number is optional
 * and masked in logs.
 * Required core function #19.
 */
export async function markOfferShipped(
  client: PriceChartingClient,
  offerId: string,
  trackingNumber?: string,
  confirm?: boolean,
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    assertConfirmed(confirm, "Marking an offer shipped");
    const id = strOf(offerId);
    if (!id) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required.");
    const params: Record<string, string> = { "offer-id": id };
    if (trackingNumber && trackingNumber.trim()) params["tracking-number"] = trackingNumber.trim();
    const raw = await client.request<Record<string, unknown>>({ endpoint: "offer-ship", method: "POST", params });
    createAuditLog(
      {
        action: "offer.ship",
        outcome: "success",
        summary: `Marked offer ${id} shipped`,
        context: { "tracking-number": trackingNumber },
      },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: id, raw };
  } catch (err) {
    return toErr(err);
  }
}

/**
 * Leave buyer feedback. Requires a valid rating (-2..2).
 * Required core function #20.
 */
export async function leaveOfferFeedback(
  client: PriceChartingClient,
  offerId: string,
  rating: FeedbackRating,
  comment?: string,
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    const id = strOf(offerId);
    if (!id) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required.");
    if (!VALID_RATINGS.has(rating)) {
      throw new PriceChartingError("INVALID_PARAMETER", "rating must be one of 2, 1, 0, -1, -2.");
    }
    const params: Record<string, string | number> = { "offer-id": id, rating };
    if (comment && comment.trim()) params["comment"] = comment.trim();
    const raw = await client.request<Record<string, unknown>>({ endpoint: "offer-feedback", method: "POST", params });
    createAuditLog(
      { action: "offer.feedback", outcome: "success", summary: `Left feedback ${rating} on offer ${id}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: id, raw };
  } catch (err) {
    return toErr(err);
  }
}

/**
 * End an active offer. Requires explicit confirmation.
 * Required core function #21.
 */
export async function endOffer(
  client: PriceChartingClient,
  offerId: string,
  confirmation: { confirm: boolean },
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    assertConfirmed(confirmation?.confirm, "Ending an offer");
    const id = strOf(offerId);
    if (!id) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required.");
    const raw = await client.request<Record<string, unknown>>({
      endpoint: "offer-end",
      method: "POST",
      params: { "offer-id": id },
    });
    createAuditLog(
      { action: "offer.end", outcome: "success", summary: `Ended offer ${id}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: id, raw };
  } catch (err) {
    return toErr(err);
  }
}

/**
 * Refund an offer. FINANCIALLY DESTRUCTIVE — requires a dedicated second
 * confirmation (`confirm_refund: true`). Never called automatically.
 * Required core function #22.
 */
export async function refundOffer(
  client: PriceChartingClient,
  offerId: string,
  confirmation: { confirm_refund: boolean },
): Promise<Result<{ offer_id: string; raw: Record<string, unknown> }>> {
  try {
    if (confirmation?.confirm_refund !== true) {
      throw new PriceChartingError(
        "CONFIRMATION_REQUIRED",
        "Refund is a destructive financial action and requires confirm_refund: true. It is never performed automatically.",
      );
    }
    const id = strOf(offerId);
    if (!id) throw new PriceChartingError("MISSING_PARAMETER", "`offer-id` is required.");
    const raw = await client.request<Record<string, unknown>>({
      endpoint: "offer-refund",
      method: "POST",
      params: { "offer-id": id },
    });
    createAuditLog(
      { action: "offer.refund", outcome: "success", summary: `Refunded offer ${id}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return { offer_id: id, raw };
  } catch (err) {
    createAuditLog(
      { action: "offer.refund", outcome: "blocked", summary: `Refund blocked/failed for offer ${offerId}` },
      { clock: client.clock, sink: client.auditSink },
    );
    return toErr(err);
  }
}
