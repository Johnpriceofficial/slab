/**
 * Slab inventory domain types. Money is ALWAYS integer cents (bigint in the DB,
 * number here). Certification numbers are strings so leading zeros survive.
 */

import type { PricingPersist } from "./pricing-tiers";
import type { ValuationProvenance } from "./valuation-provenance";

export interface Slab {
  id: string;
  /** Internal, permanent number that keys image storage paths and eBay SKUs. */
  inventory_number: number;
  /** Public identifier prefix — "S" for slabs. Immutable after creation. */
  inventory_prefix: string;
  /** Per-type public sequence (1, 2, …). Immutable, never reused. */
  inventory_sequence: number;
  /** DB-generated public code, e.g. "S0001". Immutable, never reused. */
  inventory_code: string;
  card_name: string | null;
  final_value_cents: number | null;
  quick_sale_value_cents: number | null;
  replacement_value_cents: number | null;
  grader: string | null;
  grade: string | null;
  /** Grader designation/tier, e.g. "PRISTINE", "GEM MINT" — separate from grade. */
  grade_label: string | null;
  certification_number: string | null;
  /** DB-generated normalized columns (uniqueness only; never displayed). */
  certification_number_normalized?: string | null;
  grader_normalized?: string | null;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  language: string | null;
  rarity: string | null;
  variation: string | null;
  label_description: string | null;
  label_accuracy: string | null;
  verification_status: string | null;
  valuation_confidence: string | null;
  valuation_provenance?: ValuationProvenance | null;
  duplicate_status: string | null;
  pricecharting_product_id: string | null;
  pricecharting_product_name: string | null;
  pricecharting_grade_field: string | null;
  pricecharting_value_cents: number | null;
  pricecharting_sales_volume: number | null;
  pricecharting_match_status: string | null;
  /** Persisted per-tier PriceCharting table (null on older rows → sparse fallback). */
  pricecharting_tiers?: PricingPersist | null;
  /** Raw token-free PriceCharting pricing response, kept for audit. */
  pricecharting_raw?: unknown;
  /** Retrieval timestamp of the stored pricing (stale-write guard key). */
  pricecharting_priced_at?: string | null;
  // §4 visual-confirmation storage (all nullable / additive).
  candidate_image_url?: string | null;
  candidate_image_source?: string | null;
  candidate_image_type?: string | null;
  candidate_image_retrieved_at?: string | null;
  candidate_image_available?: boolean | null;
  visual_confirmation_status?: string | null;
  visual_confirmation_method?: string | null;
  visual_confirmation_at?: string | null;
  visual_confirmation_by?: string | null;
  visual_rejection_reason?: string | null;
  visual_rejection_note?: string | null;
  product_confirmation_source?: string | null;
  product_confirmed_at?: string | null;
  scoring_version?: number | null;
  price_variance_percent: number | null;
  front_image_path: string | null;
  back_image_path: string | null;
  notes: string | null;
  date_valued: string | null;
  /** Set when the slab is archived (hidden from active inventory; never deleted). */
  archived_at?: string | null;
  inventory_status?: "draft" | "active" | "listed" | "sold" | "archived";
  cost_basis_cents?: number | null;
  acquired_at?: string | null;
  sold_at?: string | null;
  sold_price_cents?: number | null;
  sale_shipping_cents?: number | null;
  visual_identity_status?: "not_checked" | "needs_review" | "verified" | "rejected";
  certification_verification_status?: "not_checked" | "unsupported" | "verified" | "failed";
  valuation_status?: "exact_api_tier" | "compatible_api_tier" | "manual" | "unavailable" | "needs_review";
  created_at: string;
  updated_at: string;
}

export interface PriceChartingOffer {
  id: string;
  slab_id: string;
  offer_id: string;
  product_id: string | null;
  product_name: string | null;
  sku: string | null;
  condition_id: number | null;
  offer_status: "available" | "collection" | "sold" | "ended" | "refunded" | "unknown";
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
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface SlabComp {
  id: string;
  slab_id: string;
  sale_date: string | null;
  sold_price_cents: number | null;
  shipping_cents: number | null;
  total_price_cents: number | null;
  marketplace: string | null;
  grader: string | null;
  grade: string | null;
  exact_match: boolean | null;
  source_url: string | null;
  notes: string | null;
  created_at: string;
}

/** Writable subset used when creating/editing a sales comp (money in cents). */
export interface SlabCompInput {
  sale_date: string | null;
  sold_price_cents: number | null;
  shipping_cents: number | null;
  total_price_cents: number | null;
  marketplace: string | null;
  grader: string | null;
  grade: string | null;
  exact_match: boolean | null;
  source_url: string | null;
  notes: string | null;
}

/** Writable subset used when creating a slab (money already in cents). */
export interface SlabInput {
  card_name: string | null;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
  language: string | null;
  rarity: string | null;
  variation: string | null;
  grader: string | null;
  grade: string | null;
  grade_label: string | null;
  certification_number: string | null;
  label_description: string | null;
  label_accuracy: string | null;
  verification_status: string | null;

  final_value_cents: number | null;
  quick_sale_value_cents: number | null;
  replacement_value_cents: number | null;

  valuation_confidence: string | null;
  valuation_provenance: ValuationProvenance;
  price_variance_percent: number | null;
  notes: string | null;
  date_valued: string | null;

  pricecharting_product_id: string | null;
  pricecharting_product_name: string | null;
  pricecharting_grade_field: string | null;
  pricecharting_value_cents: number | null;
  pricecharting_sales_volume: number | null;
  pricecharting_match_status: string | null;

  duplicate_status: string | null;
}

/** Aggregated dashboard metrics — all monetary figures are integer cents. */
export interface DashboardStats {
  total_slabs: number;
  total_final_value_cents: number;
  total_quick_sale_value_cents: number;
  total_replacement_value_cents: number;
  average_value_cents: number | null;
  median_value_cents: number | null;
  highest_value_slab: { inventory_number: number; card_name: string | null; final_value_cents: number } | null;
  count_by_grader: Record<string, number>;
  count_by_grade: Record<string, number>;
  count_by_language: Record<string, number>;
  count_by_confidence: Record<string, number>;
  count_needs_clearer_images: number;
  count_possible_label_errors: number;
  count_duplicate_attempts: number;
  active_inventory_value_cents: number;
  total_cost_basis_cents: number;
  exact_guide_inventory: number;
  compatible_guide_inventory: number;
  unvalued_inventory: number;
  listed_inventory: number;
  sold_inventory: number;
  revenue_cents: number;
  preliminary_realized_profit_cents: number;
  unrealized_gain_cents: number;
  average_days_held: number | null;
}
