/**
 * Strongly typed data models for the PriceCharting integration.
 *
 * Design principles:
 *  - Missing data is `null`, never coerced to 0 or "".
 *  - Every monetary value from the API is integer pennies (see money.ts).
 *  - Output shapes are normalized and machine-readable.
 */

import type { Pennies } from "./money";
import type { PriceChartingErrorCode } from "./errors";

/* --------------------------------------------------------------------------
 * Categories
 * ------------------------------------------------------------------------ */

export type CollectibleCategory =
  | "trading_card"
  | "sports_card"
  | "video_game"
  | "comic"
  | "coin"
  | "funko_pop"
  | "lego"
  | "other";

/** Grading companies we distinguish for card/comic-specific price fields. */
export type GradingCompany = "PSA" | "BGS" | "CGC" | "SGC" | "OTHER";

/* --------------------------------------------------------------------------
 * Raw API product (the JSON PriceCharting returns from /api/product[s])
 * ------------------------------------------------------------------------ */

/**
 * Raw product record. PriceCharting hyphenates field names. Prices are pennies.
 * All price fields are optional and may be absent (treated as `null`). We keep
 * this permissive because the meaning of each price field is CATEGORY-DEPENDENT
 * (see grade-mapping.ts) — we never assume a universal mapping here.
 */
export interface RawProduct {
  status?: string;
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
  "release-date"?: string;
  upc?: string;
  asin?: string;
  epid?: string;
  genre?: string;

  // Category-dependent price fields (integer pennies). Meaning varies — do not
  // interpret these without the category-specific mapping.
  "loose-price"?: number;
  "cib-price"?: number;
  "new-price"?: number;
  "graded-price"?: number;
  "box-only-price"?: number;
  "manual-only-price"?: number;
  "bgs-10-price"?: number;
  "condition-17-price"?: number;
  "condition-18-price"?: number;

  // Retailer buy/sell guidance (video games).
  "retail-loose-buy"?: number;
  "retail-loose-sell"?: number;
  "retail-cib-buy"?: number;
  "retail-cib-sell"?: number;
  "retail-new-buy"?: number;
  "retail-new-sell"?: number;

  [key: string]: unknown;
}

/** Normalized product identity used throughout the app. */
export interface Product {
  pricecharting_id: string;
  name: string;
  console_or_category: string | null;
  release_date: string | null;
  upc: string | null;
  asin: string | null;
  epid: string | null;
  genre: string | null;
  /** The raw penny price map, keyed by the API field name. */
  raw_prices: Readonly<Record<string, Pennies | null>>;
}

/* --------------------------------------------------------------------------
 * Structured item inputs
 * ------------------------------------------------------------------------ */

export interface BaseItemInput {
  category: CollectibleCategory;
  quantity?: number;
  /** Purchase cost per unit, in pennies. */
  cost_basis?: Pennies;
  /** Free-form fallback if structured fields are unavailable. */
  raw_description?: string;
  upc?: string;
  /** Explicit PriceCharting product id — bypasses matching when supplied. */
  pricecharting_id?: string;
}

export interface CardItemInput extends BaseItemInput {
  category: "trading_card" | "sports_card";
  player_or_character?: string;
  card_name?: string;
  card_number?: string;
  set?: string;
  subset?: string;
  year?: number;
  manufacturer?: string;
  language?: string;
  edition?: string;
  first_edition?: boolean;
  holo?: boolean;
  reverse_holo?: boolean;
  parallel?: string;
  refractor?: boolean;
  insert?: string;
  promo?: boolean;
  autograph?: boolean;
  memorabilia?: boolean;
  serial_number?: string;
  error_card?: boolean;
  variant?: string;
  grading_company?: GradingCompany;
  grade?: number;
  certification_number?: string | null;
}

export interface VideoGameItemInput extends BaseItemInput {
  category: "video_game";
  title?: string;
  console?: string;
  region?: string;
  release?: string;
  edition?: string;
  variant?: string;
  /** Loose | CIB | New/Sealed | Graded. */
  condition?: "loose" | "cib" | "new" | "sealed" | "graded";
  includes_box?: boolean;
  includes_manual?: boolean;
  collectors_edition?: boolean;
}

export interface ComicItemInput extends BaseItemInput {
  category: "comic";
  series?: string;
  issue_number?: string;
  publisher?: string;
  publication_date?: string;
  variant_cover?: string;
  printing?: string;
  edition?: "newsstand" | "direct";
  grading_company?: GradingCompany;
  grade?: number;
}

export interface CoinItemInput extends BaseItemInput {
  category: "coin";
  country?: string;
  denomination?: string;
  year?: number;
  mint_mark?: string;
  composition?: string;
  variety?: string;
  grading_company?: GradingCompany;
  grade?: number;
}

export type ItemInput =
  | CardItemInput
  | VideoGameItemInput
  | ComicItemInput
  | CoinItemInput
  | (BaseItemInput & { category: "funko_pop" | "lego" | "other"; name?: string });

/* --------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------ */

export type ConfidenceLevel = "Exact" | "High" | "Probable" | "Low" | "Unresolved";

export interface MatchAssessment {
  confidence_score: number; // 0..100
  confidence_level: ConfidenceLevel;
  match_reasons: string[];
  conflicts: string[];
  missing_information: string[];
  alternatives_considered: Array<{ pricecharting_id: string; name: string; console_or_category: string | null; score: number }>;
}

export interface ProductMatchResult {
  product: Product | null;
  match: MatchAssessment;
}

/* --------------------------------------------------------------------------
 * Valuation output
 * ------------------------------------------------------------------------ */

export interface AvailableValues {
  [label: string]: number | null; // dollar values (display), null when absent
}

export interface ValuationResult {
  status: "success";
  source: "PriceCharting";
  source_type: "current_market_value";
  is_historical_sale: false;
  is_ebay_last_sold: false;
  product: {
    pricecharting_id: string;
    name: string;
    console_or_category: string | null;
    release_date: string | null;
    upc: string | null;
    asin: string | null;
    epid: string | null;
  };
  match: MatchAssessment;
  requested_condition: Record<string, unknown>;
  valuation: {
    requested_value_pennies: Pennies | null;
    requested_value_dollars: number | null;
    field_used: string | null;
    field_meaning: string | null;
    company_specific: boolean;
    is_estimate: boolean;
    available_values: AvailableValues;
  };
  quantity: number;
  extended_value_dollars: number | null;
  warnings: string[];
  retrieved_at: string;
}

/** Discriminated error output for any function that can fail gracefully. */
export interface ErrorResult {
  status: "error";
  error_code: PriceChartingErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type Result<T> = T | ErrorResult;

/* --------------------------------------------------------------------------
 * Grade lookup
 * ------------------------------------------------------------------------ */

export interface GradeLookupResult {
  value_pennies: Pennies | null;
  value_dollars: number | null;
  field_used: string | null;
  field_meaning: string | null;
  company_specific: boolean;
  is_estimate: boolean;
  warnings: string[];
  /** Nearby available grades, for context when the exact grade is missing. */
  nearby_values: AvailableValues;
}

/* --------------------------------------------------------------------------
 * Marketplace
 * ------------------------------------------------------------------------ */

export type OfferStatus = "available" | "sold" | "ended" | "collection";
export type OfferSort = "name" | "starts" | "lowest-price";

export interface OfferFilters {
  status?: OfferStatus;
  buyer?: string;
  seller?: string;
  console?: string;
  "condition-id"?: number;
  genre?: string;
  id?: string;
  sort?: OfferSort;
}

/** A marketplace offer summary as returned by /api/offers. */
export interface OfferSummary {
  offer_id: string;
  product_name: string | null;
  console_or_category: string | null;
  status: OfferStatus | string | null;
  price_pennies: Pennies | null;
  price_dollars: number | null;
  condition_id: number | null;
  sku: string | null;
  raw: Record<string, unknown>;
}

/** Rich offer detail from /api/offer-details. Buyer data is private. */
export interface OfferDetails {
  offer_id: string;
  product: { pricecharting_id: string | null; name: string | null; console_or_category: string | null };
  status: string | null;
  sold: boolean | null;
  shipped: boolean | null;
  refunded: boolean | null;
  sale_price_pennies: Pennies | null;
  cost_basis_pennies: Pennies | null;
  shipping_premium_pennies: Pennies | null;
  tracking_number: string | null; // masked in logs
  feedback_status: string | null;
  dates: Record<string, string | null>;
  /** Buyer PII. Present only when the caller is authorized; masked in all logs. */
  buyer: {
    name: string | null;
    email: string | null;
    address: string | null;
  } | null;
  raw: Record<string, unknown>;
}

export type FeedbackRating = 2 | 1 | 0 | -1 | -2;

export interface PublishOfferInput {
  // Exactly one product identifier for a NEW listing:
  product?: string;
  upc?: string;
  asin?: string;
  epid?: string;
  // For editing an existing listing:
  "offer-id"?: string;

  price_min_dollars?: number | string;
  price_max_dollars?: number | string;
  condition_id?: number;
  cost_basis_dollars?: number | string;
  description?: string;
  sku?: string;
  quantity?: number;
  add_to_collection?: boolean;

  // Condition damage tags:
  broken?: boolean;
  pristine?: boolean;
  scratch?: boolean;
  stickers?: boolean;
  tear?: boolean;
  writing?: boolean;

  /** Required guard — publishing/editing is a write action. */
  confirm?: boolean;
  /** Optional idempotency key for safe retries of write operations. */
  idempotency_key?: string;
}

/* --------------------------------------------------------------------------
 * Inventory & recovery
 * ------------------------------------------------------------------------ */

export interface InventoryItem {
  sku?: string;
  name?: string;
  quantity: number; // total units originally acquired
  quantity_remaining?: number; // unsold units (defaults to quantity)
  purchase_cost_per_unit_pennies: Pennies;
  current_value_per_unit_pennies?: Pennies | null;
}

export interface SoldOffer {
  offer_id: string;
  sku?: string;
  sale_price_pennies: Pennies;
  shipping_premium_pennies?: Pennies;
  cost_basis_pennies?: Pennies;
  quantity?: number;
}

export interface InventoryReport {
  total_cost_basis_pennies: Pennies;
  current_inventory_value_pennies: Pennies;
  recovered_amount_pennies: Pennies;
  unrecovered_cost_pennies: Pennies;
  realized_profit_loss_pennies: Pennies;
  unrealized_value_pennies: Pennies;
  projected_total_return_pennies: Pennies;
  projected_profit_loss_pennies: Pennies;
  /** null when total cost basis is 0 (never Infinity). */
  recovery_percentage: number | null;
  dollars: {
    total_cost_basis: number;
    current_inventory_value: number;
    recovered_amount: number;
    unrecovered_cost: number;
    realized_profit_loss: number;
    unrealized_value: number;
    projected_total_return: number;
    projected_profit_loss: number;
  };
}
