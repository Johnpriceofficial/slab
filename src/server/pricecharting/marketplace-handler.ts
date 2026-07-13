/**
 * Admin-only PriceCharting Marketplace request handler.
 *
 * This adapter deliberately returns only an allowlisted, buyer-PII-free offer
 * snapshot. The API token stays in the Edge Function and raw marketplace
 * payloads are never sent to the browser or persisted.
 */

import { PriceChartingClient, type FetchLike } from "../../lib/pricecharting/client";
import type { Clock } from "../../lib/pricecharting/clock";
import type { Logger } from "../../lib/pricecharting/logger";
import {
  editOffer,
  endOffer,
  getOfferDetails,
  leaveOfferFeedback,
  listMarketplaceOffers,
  markOfferShipped,
  publishOffer,
  refundOffer,
} from "../../lib/pricecharting/marketplace";
import type { FeedbackRating, OfferDetails, OfferSummary, PublishOfferInput } from "../../lib/pricecharting/types";

export type MarketplaceAction =
  | "list"
  | "details"
  | "publish"
  | "edit"
  | "ship"
  | "feedback"
  | "end"
  | "refund";

export interface MarketplaceInput {
  action?: MarketplaceAction;
  slab_id?: string;
  offer_id?: string;
  seller_id?: string;
  status?: "available" | "sold" | "ended" | "collection";
  product_id?: string;
  product_name?: string;
  sku?: string;
  condition_id?: number;
  price_min_dollars?: number | string;
  price_max_dollars?: number | string;
  cost_basis_dollars?: number | string;
  description?: string;
  pristine?: boolean;
  scratch?: boolean;
  stickers?: boolean;
  tear?: boolean;
  writing?: boolean;
  broken?: boolean;
  tracking_number?: string;
  rating?: FeedbackRating;
  comment?: string;
  confirm?: boolean;
  confirm_refund?: boolean;
  idempotency_key?: string;
}

export interface MarketplaceSnapshot {
  offer_id: string;
  product_id: string | null;
  product_name: string | null;
  sku: string | null;
  condition_id: number | null;
  status: "available" | "collection" | "sold" | "ended" | "refunded" | "unknown";
  cost_basis_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  sale_price_cents: number | null;
  shipping_premium_cents: number | null;
  shipped: boolean | null;
  refunded: boolean | null;
  feedback_status: string | null;
  tracking_number: string | null;
  listed_at: string | null;
  sold_at: string | null;
  shipped_at: string | null;
  ended_at: string | null;
}

export interface MarketplaceDeps {
  tokenProvider: () => string;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  beforeRequest?: (endpoint: string) => Promise<void>;
}

export type MarketplaceHandlerBody =
  | { status: "success"; action: MarketplaceAction; snapshot?: MarketplaceSnapshot; offers?: MarketplaceSnapshot[] }
  | { status: "error"; error_code: string; message: string; retryable?: boolean };

function cents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function dollarsToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function statusOf(value: unknown, refunded?: boolean | null): MarketplaceSnapshot["status"] {
  if (refunded === true) return "refunded";
  const status = text(value)?.toLowerCase();
  return status === "available" || status === "collection" || status === "sold" || status === "ended" || status === "refunded"
    ? status
    : "unknown";
}

function fromSummary(offer: OfferSummary): MarketplaceSnapshot {
  return {
    offer_id: offer.offer_id,
    product_id: text(offer.raw["product-id"] ?? offer.raw.id),
    product_name: offer.product_name,
    sku: offer.sku,
    condition_id: offer.condition_id,
    status: statusOf(offer.status),
    cost_basis_cents: cents(offer.raw["cost-basis"]),
    price_min_cents: cents(offer.raw["price-min"]),
    price_max_cents: cents(offer.raw["price-max"] ?? offer.price_pennies),
    sale_price_cents: cents(offer.raw["sale-price"]),
    shipping_premium_cents: cents(offer.raw["shipping-premium"]),
    shipped: null,
    refunded: null,
    feedback_status: null,
    tracking_number: null,
    listed_at: text(offer.raw["start-date"]),
    sold_at: text(offer.raw["sold-date"]),
    shipped_at: null,
    ended_at: text(offer.raw["end-date"]),
  };
}

function fromDetails(details: OfferDetails): MarketplaceSnapshot {
  return {
    offer_id: details.offer_id,
    product_id: details.product.pricecharting_id,
    product_name: details.product.name,
    sku: text(details.raw.sku),
    condition_id: cents(details.raw["condition-id"]),
    status: statusOf(details.status ?? (details.sold ? "sold" : null), details.refunded),
    cost_basis_cents: details.cost_basis_pennies,
    price_min_cents: cents(details.raw["price-min"]),
    price_max_cents: cents(details.raw["price-max"]),
    sale_price_cents: details.sale_price_pennies,
    shipping_premium_cents: details.shipping_premium_pennies,
    shipped: details.shipped,
    refunded: details.refunded,
    feedback_status: details.feedback_status,
    tracking_number: details.tracking_number,
    listed_at: details.dates.started,
    sold_at: details.dates.sold,
    shipped_at: details.dates.shipped,
    ended_at: details.dates.ended,
  };
}

function required(value: unknown, name: string): string {
  const v = text(value);
  if (!v) throw new Error(`${name} is required.`);
  return v;
}

function isError(result: unknown): result is { status: "error"; error_code: string; message: string; retryable?: boolean } {
  return !!result && typeof result === "object" && (result as { status?: string }).status === "error";
}

function httpStatus(code: string): number {
  if (code === "CONFIRMATION_REQUIRED" || code === "INVALID_PARAMETER" || code === "MISSING_PARAMETER" || code === "VALIDATION_ERROR") return 400;
  if (code === "AUTHENTICATION_ERROR") return 502;
  if (code === "RATE_LIMITED") return 429;
  if (code === "OFFER_NOT_FOUND") return 404;
  return 502;
}

function publishInput(input: MarketplaceInput): PublishOfferInput {
  return {
    product: input.product_id,
    sku: input.sku,
    condition_id: input.condition_id,
    price_min_dollars: input.price_min_dollars,
    price_max_dollars: input.price_max_dollars,
    cost_basis_dollars: input.cost_basis_dollars,
    description: input.description,
    pristine: input.pristine,
    scratch: input.scratch,
    stickers: input.stickers,
    tear: input.tear,
    writing: input.writing,
    broken: input.broken,
    confirm: input.confirm,
    idempotency_key: input.idempotency_key,
  };
}

export async function handleMarketplaceRequest(
  rawInput: unknown,
  deps: MarketplaceDeps,
): Promise<{ statusCode: number; body: MarketplaceHandlerBody }> {
  try {
    if (!rawInput || typeof rawInput !== "object") throw new Error("A JSON object is required.");
    const input = rawInput as MarketplaceInput;
    const action = input.action;
    if (!action || !["list", "details", "publish", "edit", "ship", "feedback", "end", "refund"].includes(action)) {
      throw new Error("A valid marketplace action is required.");
    }

    const client = new PriceChartingClient({
      tokenProvider: deps.tokenProvider,
      fetch: deps.fetch,
      clock: deps.clock,
      logger: deps.logger,
      beforeRequest: deps.beforeRequest as never,
    });

    if (action === "list") {
      const result = await listMarketplaceOffers(client, {
        ...(input.seller_id ? { seller: input.seller_id } : {}),
        ...(input.status ? { status: input.status } : {}),
      });
      if (isError(result)) return { statusCode: httpStatus(result.error_code), body: result };
      return { statusCode: 200, body: { status: "success", action, offers: result.map(fromSummary) } };
    }

    const offerId = action === "publish" ? null : required(input.offer_id, "offer_id");
    if (action === "details") {
      const result = await getOfferDetails(client, offerId!);
      if (isError(result)) return { statusCode: httpStatus(result.error_code), body: result };
      return { statusCode: 200, body: { status: "success", action, snapshot: fromDetails(result) } };
    }

    let writeResult;
    if (action === "publish") writeResult = await publishOffer(client, publishInput(input));
    else if (action === "edit") writeResult = await editOffer(client, offerId!, publishInput(input));
    else if (action === "ship") writeResult = await markOfferShipped(client, offerId!, input.tracking_number, input.confirm);
    else if (action === "feedback") writeResult = await leaveOfferFeedback(client, offerId!, input.rating as FeedbackRating, input.comment);
    else if (action === "end") writeResult = await endOffer(client, offerId!, { confirm: input.confirm === true });
    else writeResult = await refundOffer(client, offerId!, { confirm_refund: input.confirm_refund === true });

    if (isError(writeResult)) return { statusCode: httpStatus(writeResult.error_code), body: writeResult };

    // Publishing can be mirrored immediately from its validated request. Other
    // writes return a minimal safe snapshot; a subsequent details sync refreshes
    // sale price/timestamps without exposing buyer data.
    const snapshot: MarketplaceSnapshot = {
      offer_id: writeResult.offer_id,
      product_id: text(input.product_id),
      product_name: text(input.product_name),
      sku: text(input.sku),
      condition_id: cents(input.condition_id),
      status: action === "publish" || action === "edit" ? "available" : action === "end" ? "ended" : action === "refund" ? "refunded" : "unknown",
      cost_basis_cents: dollarsToCents(input.cost_basis_dollars),
      price_min_cents: dollarsToCents(input.price_min_dollars),
      price_max_cents: dollarsToCents(input.price_max_dollars),
      sale_price_cents: null,
      shipping_premium_cents: null,
      shipped: action === "ship" ? true : null,
      refunded: action === "refund" ? true : null,
      feedback_status: action === "feedback" ? "submitted" : null,
      tracking_number: action === "ship" ? text(input.tracking_number) : null,
      listed_at: action === "publish" ? new Date().toISOString() : null,
      sold_at: null,
      shipped_at: action === "ship" ? new Date().toISOString() : null,
      ended_at: action === "end" ? new Date().toISOString() : null,
    };
    return { statusCode: 200, body: { status: "success", action, snapshot } };
  } catch (error) {
    return {
      statusCode: 400,
      body: { status: "error", error_code: "INVALID_PARAMETER", message: error instanceof Error ? error.message : "Invalid request.", retryable: false },
    };
  }
}
