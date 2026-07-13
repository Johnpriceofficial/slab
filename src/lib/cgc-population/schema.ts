/**
 * Strict validation + normalization of raw Apify actor records into
 * CgcPopulationCard. Malformed records are REJECTED (with reasons) and counted,
 * never silently coerced.
 *
 * Two hard rules:
 *   - Every population count must be a NONNEGATIVE INTEGER when present.
 *   - A MISSING count stays null — it is never turned into a claimed zero. Only
 *     an explicit 0 from the source becomes 0.
 */

import {
  AUTHENTIC_COUNT_FIELDS,
  GRADE_COUNT_FIELDS,
  type CgcPopulationCard,
  type GradeCountField,
} from "./types";
import { cardNumberToken, normalizeCardName, normalizeCardNumber, normalizeSetName, normalizeVariant } from "./normalize";

/**
 * Validation outcome. `value` is null on failure, and `errors` is empty on
 * success — a non-discriminated shape so it narrows correctly under this
 * project's non-strict tsconfig (boolean-discriminant unions don't).
 */
export interface CgcValidation {
  value: CgcPopulationCard | null;
  errors: string[];
}

const ALL_COUNT_KEYS = [...GRADE_COUNT_FIELDS, ...AUTHENTIC_COUNT_FIELDS, "total_graded"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse ONE count. Returns { count } for a valid nonneg integer or explicit
 * null (missing), or { error } for a malformed / negative / non-integer value.
 */
function parseCount(v: unknown): { count: number | null } | { error: string } {
  if (v === null || v === undefined || v === "") return { count: null }; // missing ≠ 0
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: "not an integer" };
  if (n < 0) return { error: "negative" };
  return { count: n };
}

/** Validate + normalize a single raw record. */
export function validateCgcRecord(raw: unknown): CgcValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { value: null, errors: ["record is not an object"] };

  // A usable population record must carry an identity to match on.
  const cardName = strOrNull(raw["card_name"]);
  const cardNumber = strOrNull(raw["card_number"]);
  if (!cardName && !cardNumber) errors.push("missing both card_name and card_number");

  const counts = {} as CgcPopulationCard["counts"];
  for (const key of ALL_COUNT_KEYS) {
    const parsed = parseCount(raw[key]);
    if ("error" in parsed) {
      errors.push(`${key}: ${parsed.error}`);
    } else {
      counts[key as GradeCountField] = parsed.count;
    }
  }

  if (errors.length > 0) return { value: null, errors };

  const value: CgcPopulationCard = {
    cgc_card_id: numOrNull(raw["card_id"]),
    card_name: cardName,
    normalized_card_name: normalizeCardName(cardName),
    card_number: cardNumber,
    normalized_card_number: normalizeCardNumber(cardNumber),
    card_number_token: cardNumberToken(cardNumber),
    parallel_or_variant: strOrNull(raw["parallel_or_variant"]),
    normalized_variant: normalizeVariant(strOrNull(raw["parallel_or_variant"])),
    autograph: boolOrNull(raw["autograph"]),
    memorabilia: boolOrNull(raw["memorabilia"]),
    set_name: strOrNull(raw["set_name"]),
    normalized_set_name: normalizeSetName(strOrNull(raw["set_name"])),
    cgc_set_id: numOrNull(raw["set_id"]),
    category: strOrNull(raw["category"]),
    subcategory: strOrNull(raw["sport_or_subcategory"]),
    brand: strOrNull(raw["brand"]),
    year: strOrNull(raw["year"]),
    report_url: strOrNull(raw["report_url"]),
    counts,
    source_retrieved_at: null,
    raw_record: raw,
  };
  return { value, errors: [] };
}

/** Validate a batch, returning the good records and an error count. */
export function validateCgcBatch(raws: unknown[]): { cards: CgcPopulationCard[]; errorCount: number; errors: string[] } {
  const cards: CgcPopulationCard[] = [];
  const errors: string[] = [];
  for (const raw of raws) {
    const v = validateCgcRecord(raw);
    if (v.value) cards.push(v.value);
    else errors.push(v.errors.join("; "));
  }
  return { cards, errorCount: errors.length, errors };
}
