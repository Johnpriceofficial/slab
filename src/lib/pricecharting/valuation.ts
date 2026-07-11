/**
 * Category-specific valuation. Ties matching + grade mapping together and emits
 * the normalized machine-readable ValuationResult.
 *
 * Guarantees:
 *  - No value is assigned when match confidence is below the required threshold.
 *  - PriceCharting values are always labeled as CURRENT market estimates, never
 *    as eBay last-sold or historical sales.
 *  - General Grade 9 is never described as company-specific.
 */

import type { PriceChartingClient } from "./client";
import { getProductById } from "./api";
import { findBestProductMatch, confirmThreshold } from "./matching";
import {
  buildAvailableValues,
  categoryToPriceCategory,
  getValueForRequestedGrade,
  type PriceCategory,
} from "./grade-mapping";
import { convertPenniesToDollars, multiplyPennies, type Pennies } from "./money";
import { PriceChartingError, isPriceChartingError } from "./errors";
import type {
  CardItemInput,
  CoinItemInput,
  ComicItemInput,
  ErrorResult,
  ItemInput,
  Product,
  Result,
  ValuationResult,
  VideoGameItemInput,
} from "./types";

const CURRENT_VALUE_DISCLAIMER =
  "This is a PriceCharting current market estimate, not a verified eBay last-sold result.";

export interface ValuationOptions {
  /** Allow interpolation for unsupported grades (labeled as an estimate). */
  enableEstimation?: boolean;
}

/** Map a video-game condition to its price field + human meaning. */
function videoGameField(condition: VideoGameItemInput["condition"]): { field: string; meaning: string } {
  switch (condition) {
    case "loose":
      return { field: "loose-price", meaning: "Loose (item only, no box or manual)" };
    case "cib":
      return { field: "cib-price", meaning: "Complete in box (box + manual)" };
    case "new":
    case "sealed":
      return { field: "new-price", meaning: "New / sealed" };
    case "graded":
      return { field: "graded-price", meaning: "Professionally graded" };
    default:
      return { field: "loose-price", meaning: "Loose (item only) — condition unspecified, defaulted to loose" };
  }
}

function nowIso(client: PriceChartingClient): string {
  return new Date(client.clock.now()).toISOString();
}

/** Build the standard error result when a confident match cannot be made. */
function ambiguousResult(match: ReturnType<typeof unwrapMatch>): ErrorResult {
  const hasCandidates = match.alternatives_considered.length > 0;
  const err = new PriceChartingError(
    hasCandidates ? "AMBIGUOUS_PRODUCT" : "PRODUCT_NOT_FOUND",
    hasCandidates
      ? "Could not confidently identify the product. Multiple candidates remain; review is required."
      : "No matching product was found for the supplied identifiers.",
    {
      details: {
        confidence_score: match.confidence_score,
        confidence_level: match.confidence_level,
        missing_information: match.missing_information,
        conflicts: match.conflicts,
        candidates: match.alternatives_considered,
      },
    },
  );
  return err.toJSON();
}

/** tiny helper so the type of the match object is inferred cleanly. */
function unwrapMatch(m: Awaited<ReturnType<typeof findBestProductMatch>>["match"]) {
  return m;
}

/**
 * Generic product valuation entry point.
 * Required core function #5.
 */
export async function getProductValuation(
  client: PriceChartingClient,
  item: ItemInput,
  opts: ValuationOptions = {},
): Promise<Result<ValuationResult>> {
  try {
    const { product, match } = await findBestProductMatch(client, item);

    // Confidence gate — never value an unconfirmed match.
    if (!product || match.confidence_score < confirmThreshold(item)) {
      return ambiguousResult(match);
    }

    // Verify returned identity agrees with what we searched for (defense-in-depth).
    // (findBestProductMatch already scored it; here we ensure a name exists.)
    if (!product.name) {
      return new PriceChartingError("VALIDATION_ERROR", "Matched product is missing a name.").toJSON();
    }

    const priceCategory = categoryToPriceCategory(item.category);
    const available = buildAvailableValues(product, priceCategory);
    const warnings: string[] = [CURRENT_VALUE_DISCLAIMER];

    let requestedPennies: Pennies | null = null;
    let fieldUsed: string | null = null;
    let fieldMeaning: string | null = null;
    let companySpecific = false;
    let isEstimate = false;
    const requestedCondition: Record<string, unknown> = {};

    if (item.category === "video_game") {
      const vg = item as VideoGameItemInput;
      const { field, meaning } = videoGameField(vg.condition);
      requestedPennies = product.raw_prices[field] ?? null;
      fieldUsed = requestedPennies === null ? null : field;
      fieldMeaning = meaning;
      requestedCondition.condition = vg.condition ?? "loose";
      if (requestedPennies === null) {
        warnings.push(`PriceCharting has no ${meaning} value for this product (value is null, not zero).`);
      }
    } else if (item.category === "trading_card" || item.category === "sports_card") {
      const card = item as CardItemInput;
      const lookup = getValueForRequestedGrade(product, card.grading_company, card.grade, {
        category: "card",
        enableEstimation: opts.enableEstimation,
      });
      requestedPennies = lookup.value_pennies;
      fieldUsed = lookup.field_used;
      fieldMeaning = lookup.field_meaning;
      companySpecific = lookup.company_specific;
      isEstimate = lookup.is_estimate;
      warnings.push(...lookup.warnings);
      requestedCondition.grading_company = card.grading_company ?? null;
      requestedCondition.grade = card.grade ?? null;
    } else if (item.category === "comic") {
      const comic = item as ComicItemInput;
      const lookup = getValueForRequestedGrade(product, comic.grading_company, comic.grade, {
        category: "comic",
        enableEstimation: opts.enableEstimation,
      });
      requestedPennies = lookup.value_pennies;
      fieldUsed = lookup.field_used;
      fieldMeaning = lookup.field_meaning;
      companySpecific = lookup.company_specific;
      isEstimate = lookup.is_estimate;
      warnings.push(...lookup.warnings);
      requestedCondition.grading_company = comic.grading_company ?? null;
      requestedCondition.grade = comic.grade ?? null;
    } else if (item.category === "coin") {
      const coin = item as CoinItemInput;
      const lookup = getValueForRequestedGrade(product, coin.grading_company, coin.grade, { category: "coin" });
      requestedPennies = lookup.value_pennies; // null — no documented coin mapping
      fieldUsed = lookup.field_used;
      fieldMeaning = lookup.field_meaning;
      warnings.push(...lookup.warnings);
      requestedCondition.grading_company = coin.grading_company ?? null;
      requestedCondition.grade = coin.grade ?? null;
    } else {
      // funko_pop / lego / other → base ungraded value.
      requestedPennies = product.raw_prices["loose-price"] ?? null;
      fieldUsed = requestedPennies === null ? null : "loose-price";
      fieldMeaning = "Base / ungraded value";
      requestedCondition.condition = "base";
      if (requestedPennies === null) {
        warnings.push("PriceCharting has no base value for this product (value is null, not zero).");
      }
    }

    const quantity = Math.max(1, Math.floor(item.quantity ?? 1));
    const requestedDollars = convertPenniesToDollars(requestedPennies);
    const extendedDollars =
      requestedPennies === null ? null : convertPenniesToDollars(multiplyPennies(requestedPennies, quantity));

    const result: ValuationResult = {
      status: "success",
      source: "PriceCharting",
      source_type: "current_market_value",
      is_historical_sale: false,
      is_ebay_last_sold: false,
      product: {
        pricecharting_id: product.pricecharting_id,
        name: product.name,
        console_or_category: product.console_or_category,
        release_date: product.release_date,
        upc: product.upc,
        asin: product.asin,
        epid: product.epid,
      },
      match,
      requested_condition: requestedCondition,
      valuation: {
        requested_value_pennies: requestedPennies,
        requested_value_dollars: requestedDollars,
        field_used: fieldUsed,
        field_meaning: fieldMeaning,
        company_specific: companySpecific,
        is_estimate: isEstimate,
        available_values: available,
      },
      quantity,
      extended_value_dollars: extendedDollars,
      warnings: dedupe(warnings),
      retrieved_at: nowIso(client),
    };
    return result;
  } catch (err) {
    return toErrorResult(err);
  }
}

/** Required core function #6. */
export function getCardValuation(
  client: PriceChartingClient,
  cardInput: CardItemInput,
  opts?: ValuationOptions,
): Promise<Result<ValuationResult>> {
  return getProductValuation(client, cardInput, opts);
}

/** Required core function #7. */
export function getVideoGameValuation(
  client: PriceChartingClient,
  gameInput: VideoGameItemInput,
  opts?: ValuationOptions,
): Promise<Result<ValuationResult>> {
  return getProductValuation(client, gameInput, opts);
}

/** Required core function #8. */
export function getComicValuation(
  client: PriceChartingClient,
  comicInput: ComicItemInput,
  opts?: ValuationOptions,
): Promise<Result<ValuationResult>> {
  return getProductValuation(client, comicInput, opts);
}

/** Required core function #9. */
export function getCoinValuation(
  client: PriceChartingClient,
  coinInput: CoinItemInput,
  opts?: ValuationOptions,
): Promise<Result<ValuationResult>> {
  return getProductValuation(client, coinInput, opts);
}

/**
 * Return every available condition/grade value for a product id.
 * Required core function #10.
 */
export async function getValuesForAllConditions(
  client: PriceChartingClient,
  productId: string,
  category?: PriceCategory,
): Promise<Result<{ product: Product; category: PriceCategory; values: Record<string, number | null> }>> {
  try {
    const product = await getProductById(client, productId);
    const cat = category ?? inferCategory(product);
    return { product, category: cat, values: buildAvailableValues(product, cat) };
  } catch (err) {
    return toErrorResult(err);
  }
}

function inferCategory(product: Product): PriceCategory {
  // Best-effort inference from the product's console/category label.
  return categoryFromLabel(product.console_or_category);
}

function categoryFromLabel(label: string | null): PriceCategory {
  const c = (label ?? "").toLowerCase();
  if (c.includes("card")) return "card";
  if (c.includes("comic")) return "comic";
  if (c.includes("coin")) return "coin";
  const gameHints = ["nintendo", "playstation", "xbox", "sega", "boy", "atari", "wii", "switch"];
  if (gameHints.some((h) => c.includes(h))) return "video_game";
  return "generic";
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function toErrorResult(err: unknown): ErrorResult {
  if (isPriceChartingError(err)) return err.toJSON();
  return new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected error occurred.", { cause: err }).toJSON();
}
