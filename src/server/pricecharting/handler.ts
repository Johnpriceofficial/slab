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
import { buildSearchQuery, scoreCandidate, requiresHighConfidence, conflictsAreNumberOnly, extractHashNumber, type ScoreBreakdown } from "../../lib/pricecharting/matching";
import { getValueForRequestedGrade } from "../../lib/pricecharting/grade-mapping";
import { normalizeProduct } from "../../lib/pricecharting/product";
import { getBestOfferImageForProduct } from "../../lib/pricecharting/marketplace";
import { scrapeCatalogImage } from "../../lib/pricecharting/catalog-image";
import { PriceChartingError, isPriceChartingError } from "../../lib/pricecharting/errors";
import type { CardItemInput, GradingCompany, RawProduct } from "../../lib/pricecharting/types";

/** Fields the browser is allowed to send. NO token, NO product internals. */
export interface SlabSearchInput {
  action?: "search" | "value" | "offer_image" | "lookup";
  card_name?: string;
  set?: string;
  card_number?: string;
  year?: number | string;
  language?: string;
  variation?: string;
  grader?: string;
  grade?: string | number;
  /** Grade designation (e.g. "PRISTINE", "GEM MINT") — needed to select the right tier. */
  grade_label?: string;
  /** Required for action "value"/"lookup": a PriceCharting product id. */
  product_id?: string;
  /** For action "lookup": a full PriceCharting product URL (id extracted if present). */
  product_url?: string;
}

/**
 * Parse a PriceCharting product id from a raw id or URL. A `?id=` query or a 5+
 * digit path segment at the END of the path is accepted. A slug-only URL yields
 * null here — it is resolved separately, via the API, by `parseProductSlug`.
 */
export function parseProductId(input: { product_id?: string; product_url?: string }): string | null {
  const direct = (input.product_id ?? "").trim();
  if (/^\d+$/.test(direct)) return direct;
  const url = (input.product_url ?? "").trim();
  if (url) {
    // Only an explicit `id=` query param, or a 5+ digit segment at the very END
    // of the path (e.g. ".../product/5427932"). A slug URL, or a stray numeric
    // query param (?sort=99999) / mid-path number (/game/12345/charizard), must
    // NOT be mistaken for a product id.
    const m = /[?&]id=(\d+)/.exec(url) ?? /\/(\d{5,})\/?(?:[?#]|$)/.exec(url);
    if (m) return m[1];
  }
  return null;
}

/**
 * Parse a CANONICAL PriceCharting product URL (a slug with no numeric id) into a
 * search query and the product slug, so the id can be resolved via the API
 * WITHOUT scraping. PriceCharting URLs look like:
 *   https://www.pricecharting.com/game/<console-slug>/<product-slug>
 * Returns null for anything that is not a `/game/<console>/<product>` slug path
 * (a bare number, a non-PriceCharting URL, or a URL that already carries an id).
 */
export function parseProductSlug(productUrl?: string): { query: string; productSlug: string } | null {
  const raw = (productUrl ?? "").trim();
  if (!raw) return null;
  let path: string;
  try {
    const u = new URL(raw);
    // Only accept PriceCharting hosts — never resolve a slug from a foreign URL.
    if (!/(^|\.)pricecharting\.com$/i.test(u.hostname)) return null;
    path = u.pathname;
  } catch {
    // Accept a bare "/game/console/product" path (no host) as well.
    if (!raw.startsWith("/game/")) return null;
    path = raw.split(/[?#]/)[0];
  }
  const m = /\/game\/([^/]+)\/([^/?#]+)/i.exec(path);
  if (!m) return null;
  const consoleSlug = decodeURIComponent(m[1]);
  const productSlug = decodeURIComponent(m[2]);
  // A purely-numeric product segment is not a slug (parseProductId handles ids).
  if (/^\d+$/.test(productSlug)) return null;
  const query = `${consoleSlug} ${productSlug}`.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (!query) return null;
  return { query, productSlug: productSlug.toLowerCase() };
}

/**
 * Normalize a product name / URL slug for slug-equality. Separators and
 * punctuation are dropped entirely (so "289/S-P" and "289s-p" compare equal) and
 * leading zeros in a number are folded (so "047" and "47" compare equal).
 */
function normalizeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "") // drop ALL separators/punctuation
    .replace(/(^|[^0-9])0+(\d)/g, "$1$2"); // fold leading zeros in numbers (047 → 47)
}

/**
 * From the products a slug query returned, choose the ONE whose own slug equals
 * the URL's product slug (never an arbitrary search hit). Returns null when there
 * is no unambiguous slug match — the caller then refuses rather than guessing.
 */
function bestSlugMatch<T extends { name: string }>(products: T[], productSlug: string): T | null {
  const target = normalizeSlug(productSlug);
  const exact = products.filter((p) => normalizeSlug(p.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // ambiguous — require the numeric id
  return null;
}

export interface HandlerDeps {
  tokenProvider: () => string;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /**
   * Durable rate-limit reservation, awaited before every PriceCharting network
   * attempt (including retries). The Edge Function injects a DB-backed reserver;
   * omitted in tests.
   */
  beforeRequest?: (endpoint: string) => Promise<void>;
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
  /** True when the candidate was hard-disqualified (shown only under "Rejected"). */
  rejected: boolean;
  /** Full structured "Why this match?" breakdown (per-field, contributions, floor). */
  breakdown: ScoreBreakdown;
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
  /** Hard-disqualified products (wrong number/character/set), with reasons. */
  rejected_candidates: CandidateResult[];
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
  /** Normalized tier the value came from ("cgc_10"); NEVER a designation the API lacks. */
  selected_tier_key: string | null;
  selected_tier_label: string | null;
  designation_requested: string | null;
  /** True only when the returned tier exactly represents the requested grade+designation. */
  designation_exact: boolean;
  /**
   * Capability state for the REQUESTED tier from the connected source:
   *   - "available"              the exact tier has a value
   *   - "tier_unavailable"       the source has no value for this tier (null, not $0);
   *                              this means "unavailable from the connected source", not
   *                              that the value does not exist anywhere.
   */
  tier_availability: "available" | "tier_unavailable";
  sales_volume: number | null;
  available_values_cents: Record<string, number | null>;
  warnings: string[];
}

/**
 * A seller listing photo for an explicitly-chosen product. This is NOT a
 * canonical catalog image and NOT proof of identity — PriceCharting's Prices API
 * exposes no product image, so the only image available is a marketplace
 * seller's photo of their own copy, keyed to the product id and often absent.
 */
/**
 * Where an image came from. The connected PriceCharting Prices API exposes NO
 * official/catalog product image, so this is only ever "marketplace_offer" (a
 * seller's own photo) or "none". "official_product" documents the taxonomy but
 * is never produced by this source — a marketplace photo is never relabelled as
 * an official image.
 */
export type ImageSource = "official_product" | "marketplace_offer" | "none";

export interface OfferImageResponse {
  status: "success";
  action: "offer_image";
  product_id: string;
  offer_image_url: string | null;
  offer_listing_count: number;
  /** Provenance of offer_image_url — never "official_product" from this source. */
  image_source: ImageSource;
  warnings: string[];
}

/**
 * Result of looking up ONE explicitly-supplied product (manual recovery, or a
 * slab's previously confirmed id). The product is fetched exactly, then run
 * through the SAME identity protections as a search candidate — the hard-conflict
 * gates (wrong character/number/promo-suffix) are never bypassed.
 */
export interface LookupResponse {
  status: "success";
  action: "lookup";
  product_id: string;
  product_name: string;
  console_or_category: string | null;
  score: number;
  disqualified: boolean;
  conflicts: string[];
  character_exact: boolean;
  number_exact_full: boolean;
  grade_field: string | null;
  guide_value_cents: number | null;
  company_specific: boolean;
  is_estimate: boolean;
  selected_tier_key: string | null;
  selected_tier_label: string | null;
  designation_requested: string | null;
  designation_exact: boolean;
  tier_availability: "available" | "tier_unavailable";
  sales_volume: number | null;
  available_values_cents: Record<string, number | null>;
  offer_image_url: string | null;
  offer_listing_count: number;
  /** Provenance of offer_image_url — never "official_product" from this source. */
  image_source: ImageSource;
  /** True when identity is not safe to auto-confirm (conflict or below threshold). */
  requires_confirmation: boolean;
  breakdown: ScoreBreakdown;
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
  body: SearchResponse | ValueResponse | OfferImageResponse | LookupResponse | HandlerErrorBody;
}

/** HTTP status for a normalized error code. */
function httpStatusFor(code: string): number {
  switch (code) {
    case "AUTHENTICATION_ERROR":
    case "SUBSCRIPTION_REQUIRED":
      return 502; // upstream/config problem — do not leak specifics to the browser
    case "RATE_LIMITED":
      return 429;
    case "RATE_LIMIT_RESERVATION_UNAVAILABLE":
      return 503; // fail closed — reservation unavailable, no upstream call made

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
    // Forward the durable reserver so retries reserve durable slots too.
    beforeRequest: deps.beforeRequest,
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
    if (action === "offer_image") {
      return await handleOfferImage(client, input, deps.fetch ?? (globalThis.fetch as FetchLike));
    }
    if (action === "lookup") {
      return await handleLookup(client, input, deps.fetch ?? (globalThis.fetch as FetchLike));
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

  const toCandidate = (s: (typeof scored)[number]): CandidateResult => {
    // Per-candidate guide value at the requested grade (integer cents).
    const lookup = getValueForRequestedGrade(s.product, grader, grade, { category: "card", designation: input.grade_label });
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
      rejected: s.disqualified,
      breakdown: s.breakdown,
    };
  };

  const eligibleScored = scored.filter((s) => !s.disqualified);
  let rejectedScored = scored.filter((s) => s.disqualified);

  // ── Number-only-conflict recovery ────────────────────────────────────────────────────────────────────
  // A candidate disqualified SOLELY on card_number (never character/console/
  // set) may be the right card with a misread digit — the exact failure mode
  // that motivated analyze-slab's independent card_number re-verification.
  // We do NOT auto-resolve this by dropping the number and picking "the"
  // survivor: some sets print multiple near-duplicate cards sharing every
  // identifier except the number (e.g. several alt-art prints of the same
  // card in one set), so more than one candidate can legitimately remain.
  // Instead: when there is NO fully-eligible candidate, promote every
  // number-only-conflicted candidate into the SELECTABLE list (never
  // auto-confirmed) with the mismatch kept visible as a caveat, so the
  // operator can pick the correct print by checking the physical card's
  // printed number — turning a dead-end rejection into an informed choice.
  let numberOnlyPromoted: typeof scored = [];
  if (eligibleScored.length === 0) {
    numberOnlyPromoted = rejectedScored.filter((s) => conflictsAreNumberOnly(s.conflicts));
    if (numberOnlyPromoted.length > 0) {
      const promotedIds = new Set(numberOnlyPromoted.map((s) => s.product.pricecharting_id));
      rejectedScored = rejectedScored.filter((s) => !promotedIds.has(s.product.pricecharting_id));
    }
  }

  const toPromotedCandidate = (s: (typeof scored)[number]): CandidateResult => {
    const base = toCandidate(s);
    const actualNumber = extractHashNumber(s.product.name);
    return {
      ...base,
      // Never silently confirmed — surfaced as a real candidate, not a reject.
      confidence_score: s.score,
      match_status: "unverified",
      rejected: false,
      conflicts: [
        ...s.conflicts,
        `Shown despite the card_number mismatch above: this is the ONLY identity ` +
          `conflict for this candidate (name/set/year/language all matched), which can ` +
          `indicate an OCR misread rather than the wrong card.${
            actualNumber ? ` This candidate's printed number is #${actualNumber}.` : ""
          } Verify the number against the physical card before selecting.`,
      ],
    };
  };

  // Selectable candidates are ELIGIBLE (never disqualified) plus any
  // number-only-conflict candidates promoted above. Hard-disqualified products
  // (wrong character/set/language, or a number conflict alongside another
  // conflict) go in the separate rejected list with reasons.
  const candidates: CandidateResult[] = [
    ...eligibleScored.slice(0, 5).map(toCandidate),
    ...numberOnlyPromoted.slice(0, 5).map(toPromotedCandidate),
  ];
  const rejected_candidates: CandidateResult[] = rejectedScored.slice(0, 5).map(toCandidate);

  const eligible = eligibleScored;
  const top = eligible[0];
  const runnerUp = eligible[1];

  let confidence = top ? top.score : 0;
  // Ambiguity guard mirrors the library: a near-tie is not confident.
  if (top && runnerUp && top.score - runnerUp.score < 8) confidence = Math.min(confidence, 68);
  if (top && top.conflicts.length > 0) confidence = Math.max(0, confidence - 20);

  const threshold = requiresHighConfidence(item) ? 85 : 70;
  const requiresConfirmation = confidence < threshold;

  const warnings = [
    "Values are the Current PriceCharting Guide Value — not a last-sold, eBay-sold, or confirmed sale price.",
  ];
  if (numberOnlyPromoted.length > 0) {
    warnings.push(
      numberOnlyPromoted.length === 1
        ? "No candidate matched every identifier, but one candidate matched everything except " +
            "the card number — shown above for manual confirmation. This often means an OCR " +
            "misread rather than the wrong card; verify the printed number before selecting it."
        : `No candidate matched every identifier, but ${numberOnlyPromoted.length} candidates matched ` +
            "everything except the card number (this set prints multiple cards that share the same " +
            "name/set/year and differ only by number) — shown above for manual confirmation. Check " +
            "the physical card's printed number to pick the correct one; none has been auto-selected.",
    );
  }

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
    rejected_candidates,
    warnings,
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

  const lookup = getValueForRequestedGrade(product, grader, grade, { category: "card", designation: input.grade_label });
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
    selected_tier_key: lookup.selected_tier_key,
    selected_tier_label: lookup.selected_tier_label,
    designation_requested: lookup.designation_requested,
    designation_exact: lookup.designation_exact,
    tier_availability: lookup.value_pennies === null ? "tier_unavailable" : "available",
    sales_volume: salesVolume,
    available_values_cents: availableCents,
    warnings: [
      "Current PriceCharting Guide Value — not a last-sold, eBay-sold, or confirmed historical sale.",
      ...lookup.warnings,
    ],
  };
  return { statusCode: 200, body };
}

/**
 * Return a seller listing photo for an explicitly-chosen product, for VISUAL
 * (metadata + photo) confirmation. This is a best-effort aid only: the image is
 * a marketplace seller's photo of their copy of the same catalog product, not a
 * canonical image and not proof the operator's slab is that product. It is
 * frequently unavailable (nobody is selling it).
 */
async function handleOfferImage(client: PriceChartingClient, input: SlabSearchInput, fetchImpl: FetchLike): Promise<HandlerResult> {
  const productId = input.product_id?.trim();
  if (!productId) {
    throw new PriceChartingError("MISSING_PARAMETER", "product_id is required to fetch a listing photo.");
  }
  const result = await getBestOfferImageForProduct(client, productId);
  if ("status" in result && result.status === "error") {
    return { statusCode: httpStatusFor(result.error_code), body: result };
  }
  const image = result as { image_url: string | null; listing_count: number };
  let imageUrl = image.image_url;
  let imageSource: ImageSource = imageUrl ? "marketplace_offer" : "none";
  if (!imageUrl) {
    try {
      const raw = await client.request<RawProduct>({ endpoint: "product", method: "GET", params: { id: productId } });
      imageUrl = await scrapeCatalogImage(fetchImpl, normalizeProduct(raw));
      if (imageUrl) imageSource = "official_product";
    } catch {
      /* Public-page fallback is best-effort. */
    }
  }
  const body: OfferImageResponse = {
    status: "success",
    action: "offer_image",
    product_id: productId,
    offer_image_url: imageUrl,
    offer_listing_count: image.listing_count,
    image_source: imageSource,
    warnings: [
      imageSource === "official_product"
        ? "Catalog card image scraped from the confirmed PriceCharting product page — it shows the raw card artwork, not your graded slab. Confirm identity by metadata too."
        : "Seller listing photo from the PriceCharting Marketplace — a copy of this product offered by a seller, not a canonical image and not proof this is your exact card. Confirm identity by the metadata fields.",
    ],
  };
  return { statusCode: 200, body };
}

/**
 * Look up ONE product by id (or a URL that carries one) and validate it against
 * the slab identity. Powers manual recovery and confirmed-id-first refresh. The
 * fetched product is scored with scoreCandidate, so wrong-character / wrong-
 * number / wrong-promo-suffix hard conflicts are surfaced and it is flagged as
 * requiring confirmation when not safe to auto-link. A best-effort offer image
 * is attached for visual review.
 */
/**
 * Resolve a canonical PriceCharting product URL (slug, no id) to a product id by
 * querying the API with the slug words and matching the returned product's own
 * slug. Returns null when the URL is not a slug URL or no unambiguous slug match
 * is found — the caller then refuses rather than linking an arbitrary product.
 * The resolved product is still run through the identity matcher downstream, so
 * a wrong-character / wrong-number slug URL is caught exactly like a search hit.
 */
async function resolveSlugToId(
  client: PriceChartingClient,
  slug: { query: string; productSlug: string },
): Promise<string | null> {
  let products: Awaited<ReturnType<typeof searchProducts>>;
  try {
    products = await searchProducts(client, slug.query);
  } catch (err) {
    if (isPriceChartingError(err) && err.code === "PRODUCT_NOT_FOUND") return null;
    throw err;
  }
  const match = bestSlugMatch(products, slug.productSlug);
  return match?.pricecharting_id ?? null;
}

async function handleLookup(client: PriceChartingClient, input: SlabSearchInput, fetchImpl: FetchLike): Promise<HandlerResult> {
  // A numeric id resolves directly; a canonical slug URL is resolved via the API
  // (no scraping) by querying the slug words and matching the product's own slug.
  let id = parseProductId(input);
  if (!id) {
    const slug = parseProductSlug(input.product_url);
    if (slug) {
      id = await resolveSlugToId(client, slug);
      if (!id) {
        throw new PriceChartingError(
          "PRODUCT_NOT_FOUND",
          "That PriceCharting URL could not be resolved to a single product via the API. " +
            "Open the product on PriceCharting and paste its numeric id (e.g. 5427932).",
        );
      }
    }
  }
  if (!id) {
    throw new PriceChartingError(
      "INVALID_PARAMETER",
      "Enter a numeric PriceCharting product id (e.g. 5427932) or a canonical PriceCharting product URL " +
        "(pricecharting.com/game/<console>/<product>). A number lifted from an unrelated part of a URL is not accepted.",
    );
  }

  const raw = await client.request<RawProduct>({ endpoint: "product", method: "GET", params: { id } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No PriceCharting product found for id ${id}.`);
  }

  const item = toCardInput(input);
  const scored = scoreCandidate(item, product); // SAME identity protections as search
  const grader = item.grading_company;
  const grade = item.grade ?? null;
  const lookup = getValueForRequestedGrade(product, grader, grade, { category: "card", designation: input.grade_label });
  const availableCents: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(lookup.nearby_values)) availableCents[k] = v === null ? null : Math.round(v * 100);
  const salesVolume = numberOrNull(
    raw["sales-volume"] ?? raw["sale-volume"] ?? raw["salesVolume"] ?? raw["sales_volume"],
  );

  let offerImageUrl: string | null = null;
  let offerListingCount = 0;
  let imageSource: ImageSource = "none";
  try {
    const img = await getBestOfferImageForProduct(client, id);
    if (!("status" in img) || img.status !== "error") {
      const i = img as { image_url: string | null; listing_count: number };
      offerImageUrl = i.image_url;
      offerListingCount = i.listing_count;
      if (offerImageUrl) imageSource = "marketplace_offer";
    }
  } catch {
    /* image is best-effort; never fails the lookup */
  }
  if (!offerImageUrl) {
    offerImageUrl = await scrapeCatalogImage(fetchImpl, product);
    if (offerImageUrl) imageSource = "official_product";
  }

  const threshold = requiresHighConfidence(item) ? 85 : 70;
  // ANY conflict — even a non-disqualifying one like a year mismatch — must
  // require confirmation, matching the search gate (which penalizes residual
  // conflicts before its threshold test). Never flag a conflicting product safe.
  const requiresConfirmation = scored.disqualified || scored.conflicts.length > 0 || scored.score < threshold;

  const body: LookupResponse = {
    status: "success",
    action: "lookup",
    product_id: product.pricecharting_id,
    product_name: product.name,
    console_or_category: product.console_or_category,
    score: scored.score,
    disqualified: scored.disqualified,
    conflicts: scored.conflicts,
    character_exact: scored.characterExact,
    number_exact_full: scored.numberExactFull,
    grade_field: lookup.field_used,
    guide_value_cents: lookup.value_pennies,
    company_specific: lookup.company_specific,
    is_estimate: lookup.is_estimate,
    selected_tier_key: lookup.selected_tier_key,
    selected_tier_label: lookup.selected_tier_label,
    designation_requested: lookup.designation_requested,
    designation_exact: lookup.designation_exact,
    tier_availability: lookup.value_pennies === null ? "tier_unavailable" : "available",
    sales_volume: salesVolume,
    available_values_cents: availableCents,
    offer_image_url: offerImageUrl,
    offer_listing_count: offerListingCount,
    image_source: imageSource,
    requires_confirmation: requiresConfirmation,
    breakdown: scored.breakdown,
    warnings: [
      "Current PriceCharting Guide Value — not a last-sold, eBay-sold, or confirmed historical sale.",
      ...(scored.disqualified
        ? [`This product HARD-CONFLICTS with the slab identity (${scored.conflicts.join("; ")}) — do not link without review.`]
        : []),
      ...lookup.warnings,
    ],
  };
  return { statusCode: 200, body };
}
