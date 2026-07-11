/**
 * Slab inventory domain types. Money is ALWAYS integer cents (bigint in the DB,
 * number here). Certification numbers are strings so leading zeros survive.
 */

export interface Slab {
  id: string;
  inventory_number: number;
  card_name: string | null;
  final_value_cents: number | null;
  quick_sale_value_cents: number | null;
  replacement_value_cents: number | null;
  grader: string | null;
  grade: string | null;
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
  duplicate_status: string | null;
  pricecharting_product_id: string | null;
  pricecharting_product_name: string | null;
  pricecharting_grade_field: string | null;
  pricecharting_value_cents: number | null;
  pricecharting_sales_volume: number | null;
  pricecharting_match_status: string | null;
  price_variance_percent: number | null;
  front_image_path: string | null;
  back_image_path: string | null;
  notes: string | null;
  date_valued: string | null;
  /** Set when the slab is archived (hidden from active inventory; never deleted). */
  archived_at?: string | null;
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
  certification_number: string | null;
  label_description: string | null;
  label_accuracy: string | null;
  verification_status: string | null;

  final_value_cents: number | null;
  quick_sale_value_cents: number | null;
  replacement_value_cents: number | null;

  valuation_confidence: string | null;
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
}
