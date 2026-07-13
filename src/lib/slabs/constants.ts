/**
 * Shared enumerations and canonical column orders.
 *
 * The table and Excel column orders are defined ONCE here and consumed by the
 * inventory table, the Excel export, and the tests — so "Final Value must stay
 * directly after Card Name" and the exact Excel order are enforceable.
 */

import type { Slab } from "./types";

export const GRADERS = ["PSA", "BGS", "CGC", "SGC", "Other"] as const;

export const LANGUAGES = ["English", "Japanese", "Chinese", "Korean", "German", "French", "Italian", "Spanish", "Other"] as const;

export const VERIFICATION_STATUSES = [
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Unverified" },
  { value: "needs_clearer_images", label: "Needs clearer images" },
  { value: "label_error", label: "Possible label error" },
] as const;

export const LABEL_ACCURACY = [
  { value: "accurate", label: "Accurate" },
  { value: "minor_discrepancy", label: "Minor discrepancy" },
  { value: "possible_error", label: "Possible error" },
] as const;

export const VALUATION_CONFIDENCE = [
  { value: "verified", label: "Verified" },
  { value: "exact", label: "Exact" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "probable", label: "Probable" },
  { value: "low", label: "Low" },
  { value: "manual", label: "Manual" },
] as const;

/**
 * Structured reasons for visually REJECTING a PriceCharting candidate. Kept in
 * lockstep with the slabs_visual_rejection_reason_chk DB constraint.
 */
export const VISUAL_REJECTION_REASONS = [
  { value: "wrong_card", label: "Wrong card" },
  { value: "wrong_character", label: "Wrong character" },
  { value: "wrong_number", label: "Wrong collector number" },
  { value: "wrong_set", label: "Wrong set" },
  { value: "wrong_year", label: "Wrong year" },
  { value: "wrong_language", label: "Wrong language" },
  { value: "wrong_variation", label: "Wrong variation / print" },
  { value: "image_mismatch", label: "Image does not match" },
  { value: "other", label: "Other (see note)" },
] as const;

export const DUPLICATE_STATUSES = [
  { value: "unique", label: "Unique" },
  { value: "duplicate_attempt", label: "Duplicate attempt (kept)" },
  { value: "confirmed_duplicate", label: "Confirmed duplicate" },
] as const;

export const MATCH_STATUSES = ["exact", "likely", "unverified", "no_match"] as const;

/** Dashboard-derivation values (kept in sync with the dropdowns above). */
export const NEEDS_CLEARER_IMAGES_VALUE = "needs_clearer_images";
export const LABEL_ERROR_VERIFICATION_VALUE = "label_error";
export const POSSIBLE_LABEL_ERROR_ACCURACY_VALUE = "possible_error";
export const DUPLICATE_ATTEMPT_VALUES = ["duplicate_attempt", "confirmed_duplicate"];

/** Accepted image types. HEIC/HEIF accepted where the browser supports them. */
export const ACCEPTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
export const ACCEPTED_IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB — must match the bucket limit

/**
 * Normalize + validate a filename extension for a slab image. Mirrors the SQL
 * `valid_image_ext()` used inside create_slab: lowercases, tolerates a single
 * leading dot, and rejects anything not in the allow-list (which also rejects
 * path separators and traversal sequences). Returns null if unacceptable.
 */
export function normalizeImageExt(ext: string | null | undefined): string | null {
  let e = (ext ?? "").trim().toLowerCase();
  if (e.startsWith(".")) e = e.slice(1);
  return /^(jpg|jpeg|png|webp|heic|heif)$/.test(e) ? e : null;
}

export type ColumnType = "number" | "text" | "currency" | "percent" | "date";

export interface ColumnDef {
  key: keyof Slab;
  label: string;
  type: ColumnType;
}

/**
 * Inventory table column order (Phase 6). EXACT order required.
 * Final Value (index 2) must remain immediately after Card Name (index 1).
 */
export const INVENTORY_TABLE_COLUMNS: ColumnDef[] = [
  { key: "inventory_number", label: "Inventory #", type: "number" },
  { key: "card_name", label: "Card Name", type: "text" },
  { key: "final_value_cents", label: "Final Value", type: "currency" },
  { key: "grade", label: "Grade", type: "text" },
  { key: "certification_number", label: "Certification #", type: "text" },
  { key: "grader", label: "Grader", type: "text" },
  { key: "set_name", label: "Set", type: "text" },
  { key: "card_number", label: "Card #", type: "text" },
  { key: "year", label: "Year", type: "number" },
  { key: "language", label: "Language", type: "text" },
  { key: "rarity", label: "Rarity", type: "text" },
  { key: "variation", label: "Variation", type: "text" },
  { key: "verification_status", label: "Verification Status", type: "text" },
  { key: "valuation_confidence", label: "Valuation Confidence", type: "text" },
  { key: "quick_sale_value_cents", label: "Quick-Sale Value", type: "currency" },
  { key: "replacement_value_cents", label: "Replacement Value", type: "currency" },
  { key: "pricecharting_value_cents", label: "PriceCharting Value", type: "currency" },
  { key: "pricecharting_match_status", label: "PriceCharting Match", type: "text" },
  { key: "date_valued", label: "Date Valued", type: "date" },
];

/**
 * Excel Master Inventory column order (Phase 8). EXACT order required — 28 cols.
 */
export const EXCEL_MASTER_COLUMNS: ColumnDef[] = [
  { key: "inventory_number", label: "Inventory #", type: "number" },
  { key: "card_name", label: "Card Name", type: "text" },
  { key: "final_value_cents", label: "Final Value", type: "currency" },
  { key: "grade", label: "Grade", type: "text" },
  { key: "grade_label", label: "Grade Label", type: "text" },
  { key: "certification_number", label: "Certification #", type: "text" },
  { key: "grader", label: "Grader", type: "text" },
  { key: "set_name", label: "Set", type: "text" },
  { key: "card_number", label: "Card #", type: "text" },
  { key: "year", label: "Year", type: "number" },
  { key: "language", label: "Language", type: "text" },
  { key: "rarity", label: "Rarity", type: "text" },
  { key: "variation", label: "Variation", type: "text" },
  { key: "label_description", label: "Label Description", type: "text" },
  { key: "label_accuracy", label: "Label Accuracy", type: "text" },
  { key: "valuation_confidence", label: "Valuation Confidence", type: "text" },
  { key: "quick_sale_value_cents", label: "Quick-Sale Value", type: "currency" },
  { key: "replacement_value_cents", label: "Replacement/Retail Value", type: "currency" },
  { key: "date_valued", label: "Date Valued", type: "date" },
  { key: "verification_status", label: "Verification Status", type: "text" },
  { key: "duplicate_status", label: "Duplicate Status", type: "text" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "pricecharting_product_id", label: "PriceCharting Product ID", type: "text" },
  { key: "pricecharting_product_name", label: "PriceCharting Product Name", type: "text" },
  { key: "pricecharting_grade_field", label: "PriceCharting Grade Field", type: "text" },
  { key: "pricecharting_value_cents", label: "PriceCharting Value", type: "currency" },
  { key: "pricecharting_sales_volume", label: "PriceCharting Sales Volume", type: "number" },
  { key: "pricecharting_match_status", label: "PriceCharting Match Status", type: "text" },
  { key: "price_variance_percent", label: "Price Variance %", type: "percent" },
];

export const EXCEL_COMPS_COLUMNS: Array<{ key: keyof import("./types").SlabComp; label: string; type: ColumnType }> = [
  { key: "slab_id", label: "Slab ID", type: "text" },
  { key: "sale_date", label: "Sale Date", type: "date" },
  { key: "sold_price_cents", label: "Sold Price", type: "currency" },
  { key: "shipping_cents", label: "Shipping", type: "currency" },
  { key: "total_price_cents", label: "Total Price", type: "currency" },
  { key: "marketplace", label: "Marketplace", type: "text" },
  { key: "grader", label: "Grader", type: "text" },
  { key: "grade", label: "Grade", type: "text" },
  { key: "exact_match", label: "Exact Match", type: "text" },
  { key: "source_url", label: "Source URL", type: "text" },
  { key: "notes", label: "Notes", type: "text" },
];
