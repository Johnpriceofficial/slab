/**
 * Server-side PriceCharting handler for the slab intake workflow.
 *
 * Framework-agnostic: pure function with injected dependencies (fetch, token
 * provider, clock, logger). Runs in Node (vitest) AND — once bundled by
 * scripts/build-pricecharting-edge-bundle.mjs — inside the Supabase Edge
 * Function `pricecharting-search`.
 *
 * It uses the completed `src/lib/pricecharting` library WITHOUT modifying it,
 * and NEVER returns or logs the API token. The browser only ever sends the card
 * identity fields below; the token stays here.
 *
 * Two actions:
 *   - "search": normalize → search candidates → score → reject conflicts →
 *               return ranked candidates + confidence (never auto-confirms the
 *               first result).
 *   - "value":  value one explicitly-chosen product id at the requested grade,
 *               returning the current guide value in integer cents.
 */

import { PriceChartingClient, type FetchLike } from "../../lib/pricecharting/client";
import type { Clock } from "../../lib/pricecharting/clock";
import type { Logger } from "../../lib/pricecharting/logger";
import { nullLogger } from "../../lib/pricecharting/logger";
import { searchProducts, getProductById } from "../../lib/pricecharting/api";
import { buildSearchQuery, scoreCandidate, requiresHighConfidence } from "../../lib/pricecharting/matching";
import { getValueForRequestedGrade } from "../../lib/pricecharting/grade-mapping";
import { normalizeProduct } from "../../lib/pricecharting/product";
import { PriceChartingError, isPriceChartingError } from "../../lib/pricecharting/errors";
import type { CardItemInput, GradingCompany, RawProduct } from "../../lib/pricecharting/types";

/** Fields the browser is allowed to send. NO token, NO product internals. */
export interface SlabSearchInput {
  action?: "search" | "value";
  card_name?: string;
  set?: string;
  card_number?: string;
  year?: number | string;
  language?: string;
  variation?: string;
  grader?: string;
  grade?: string | number;
  /** Required for action "value": the product the user explicitly confirmed. */
  product_id?: string;
}

export interface HandlerDeps {
  tokenProvider: () => string;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

export type MatchStatus = "exact" | "likely" | "unverified" | "no_match";

export interface CandidateResult {
  product_id: string;
  product_name: string;
  console_or_category: string | null;
  confidence_score: number;
  match_status: MatchStatus;
  grade_field: string | null;
  guide_value_cents: number | null;
  company_specific: boolean;
  conflicts: string[];
}

export interface SearchResponse {
  status: "success";
  action: "search";
  query: string;
  confidence_score: number;
  confidence_level: string;
  requires_confirmation: boolean;
  auto_confirmed_product_id: string | null;
  candidates: CandidateResult[];
  warnings: string[];
}

export interface ValueResponse {
  status: "success";
  action: "value";
  product_id: string;
  product_name: string;
  console_or_category: string | null;
  grade_field: string | null;
  guide_value_cents: number | null;
  company_specific: boolean;
  is_estimate: boolean;
  sales_volume: number | null;
  available_values_cents: Record<string, number | null>;
  warnings: string[];
}

export interface HandlerErrorBody {
  status: "error";
  error_code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface HandlerResult {
  statusCode: number;
  body: SearchResponse | ValueResponse | HandlerErrorBody;
}

/** HTTP status for a normalized error code. */
function httpStatusFor(code: string): number {
  switch (code) {
    case "AUTHENTICATION_ERROR":
    case "SUBSCRIPTION_REQUIRED":
      return 502; // upstream/config problem — do not leak specifics to the browser
    case "RATE_LIMITED":
      return 429;
    case "MISSING_PARAMETER":
    case "INVALID_PARAMETER":
    case "VALIDATION_ERROR":
      return 400;
    case "PRODUCT_NOT_FOUND":
      return 404;
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

function toGradingCompany(grader?: string): GradingCompany | undefined {
  if (!grader) return undefined;
  const g = grader.trim().toUpperCase();
  if (g === "PSA" || g === "BGS" || g === "CGC" || g === "SGC") return g;
  return "OTHER";
}

function toGradeNumber(grade?: string | number): number | undefined {
  if (grade === undefined || grade === null || grade === "") return undefined;
  const n = typeof grade === "number" ? grade : Number(String(grade).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function toYear(year?: number | string): number | undefined {
  if (year === undefined || year === null || year === "") return undefined;
  const n = typeof year === "number" ? year : Number(String(year).replace(/[^0-9]/g, "").slice(0, 4));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Build the structured card input the library expects. */
function toCardInput(input: SlabSearchInput): CardItemInput {
  return {
    category: "trading_card",
    card_name: input.card_name?.trim() || undefined,
    set: input.set?.trim() || undefined,
    card_number: input.card_number?.trim() || undefined,
    year: toYear(input.year),
    language: input.language?.trim() || undefined,
    variant: input.variation?.trim() || undefined,
    grading_company: toGradingCompany(input.grader),
    grade: toGradeNumber(input.grade),
  };
}

function levelFor(score: number): string {
  if (score >= 95) return "Exact";
  if (score >= 85) return "High";
  if (score >= 70) return "Probable";
  if (score >= 50) return "Low";
  return "Unresolved";
}

function statusFor(score: number, disqualified: boolean): MatchStatus {
  if (disqualified || score < 50) return "no_match";
  if (score >= 95) return "exact";
  if (score >= 70) return "likely";
  return "unverified";
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function makeClient(deps: HandlerDeps): PriceChartingClient {
  return new PriceChartingClient({
    fetch: deps.fetch,
    clock: deps.clock,
    logger: deps.logger ?? nullLogger,
    tokenProvider: deps.tokenProvider,
  });
}

function errorBody(err: unknown): HandlerErrorBody {
  const pcErr = isPriceChartingError(err)
    ? err
    : new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected error occurred.", { cause: err });
  return pcErr.toJSON();
}

/**
 * Handle one PriceCharting request. Returns a normalized `{ statusCode, body }`.
 * The token is never included in the returned body under any code path.
 */
export async function handlePriceChartingRequest(
  input: SlabSearchInput,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  const action = input.action ?? "search";

  try {
    const client = makeClient(deps);
    if (action === "value") {
      return await handleValue(client, input);
    }
    return await handleSearch(client, input);
  } catch (err) {
    const body = errorBody(err);
    return { statusCode: httpStatusFor(body.error_code), body };
  }
}

async function handleSearch(client: PriceChartingClient, input: SlabSearchInput): Promise<HandlerResult> {
  const item = toCardInput(input);
  const query = buildSearchQuery(item);
  if (!query) {
    throw new PriceChartingError("MISSING_PARAMETER", "Provide at least a card name, set, or card number to search.");
  }

  let products;
  try {
    products = await searchProducts(client, query);
  } catch (err) {
    if (isPriceChartingError(err) && err.code === "PRODUCT_NOT_FOUND") products = [];
    else throw err;
  }

  const scored = products.map((p) => scoreCandidate(item, p)).sort((a, b) => b.score - a.score);
  const grader = item.grading_company;
  const grade = item.grade ?? null;

  const candidates: CandidateResult[] = scored.slice(0, 5).map((s) => {
    // Per-candidate guide value at the requested grade (integer cents).
    const lookup = getValueForRequestedGrade(s.product, grader, grade, { category: "card" });
    return {
      product_id: s.product.pricecharting_id,
      product_name: s.product.name,
      console_or_category: s.product.console_or_category,
      confidence_score: s.disqualified ? Math.min(s.score, 40) : s.score,
      match_status: statusFor(s.score, s.disqualified),
      grade_field: lookup.field_used,
      guide_value_cents: lookup.value_pennies,
      company_specific: lookup.company_specific,
      conflicts: s.conflicts,
    };
  });

  const eligible = scored.filter((s) => !s.disqualified);
  const top = eligible[0];
  const runnerUp = eligible[1];

  let confidence = top ? top.score : 0;
  // Ambiguity guard mirrors the library: a near-tie is not confident.
  if (top && runnerUp && top.score - runnerUp.score < 8) confidence = Math.min(confidence, 68);
  if (top && top.conflicts.length > 0) confidence = Math.max(0, confidence - 20);

  const threshold = requiresHighConfidence(item) ? 85 : 70;
  const requiresConfirmation = confidence < threshold;

  const body: SearchResponse = {
    status: "success",
    action: "search",
    query,
    confidence_score: confidence,
    confidence_level: levelFor(confidence),
    requires_confirmation: requiresConfirmation,
    // Never auto-confirm the first result: only surface an id when the gate clears.
    auto_confirmed_product_id: !requiresConfirmation && top ? top.product.pricecharting_id : null,
    candidates,
    warnings: [
      "Values are the Current PriceCharting Guide Value — not a last-sold, eBay-sold, or confirmed sale price.",
    ],
  };
  return { statusCode: 200, body };
}

async function handleValue(client: PriceChartingClient, input: SlabSearchInput): Promise<HandlerResult> {
  const productId = input.product_id?.trim();
  if (!productId) {
    throw new PriceChartingError("MISSING_PARAMETER", "product_id is required to retrieve a verified value.");
  }
  const grader = toGradingCompany(input.grader);
  const grade = toGradeNumber(input.grade) ?? null;

  // Fetch raw product through the rate-limited client so we can also read the
  // optional sales-volume field the normalized model does not carry.
  const raw = await client.request<RawProduct>({ endpoint: "product", method: "GET", params: { id: productId } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No product found for id ${productId}.`);
  }
  void getProductById; // (kept exported for callers; raw path used here for sales volume)

  const salesVolume = numberOrNull(
    raw["sales-volume"] ?? raw["sale-volume"] ?? raw["salesVolume"] ?? raw["sales_volume"],
  );

  const lookup = getValueForRequestedGrade(product, grader, grade, { category: "card" });
  const availableCents: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(lookup.nearby_values)) {
    availableCents[k] = v === null ? null : Math.round(v * 100);
  }

  const body: ValueResponse = {
    status: "success",
    action: "value",
    product_id: product.pricecharting_id,
    product_name: product.name,
    console_or_category: product.console_or_category,
    grade_field: lookup.field_used,
    guide_value_cents: lookup.value_pennies,
    company_specific: lookup.company_specific,
    is_estimate: lookup.is_estimate,
    sales_volume: salesVolume,
    available_values_cents: availableCents,
    warnings: [
      "Current PriceCharting Guide Value — not a last-sold, eBay-sold, or confirmed historical sale.",
      ...lookup.warnings,
    ],
  };
  return { statusCode: 200, body };
}
