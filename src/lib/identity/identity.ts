/**
 * Master Identity Engine.
 *
 * The single canonical identity object every subsystem consumes instead of
 * re-parsing or reconstructing a card's identity. It carries the card's identity
 * fields, the specimen (grading) fields, market references, and — critically — a
 * deterministic content HASH of the CARD identity.
 *
 * What the hash covers, and why: the hash is over the CARD (name, set, number,
 * language, rarity, finish, variation, year, manufacturer, set_code) — NOT the
 * specimen. Two graded copies of the same card, and a raw copy of it, all hash
 * to the SAME value, because they ARE the same card; they differ only in grade
 * and certification number (a specimen is additionally keyed by grader + cert).
 * This is what lets PriceCharting products, population reports, and eBay queries
 * link once per card rather than once per physical item.
 *
 * Pure and deploy-neutral: no schema, no network. A later step may persist the
 * object as an immutable column once these semantics are confirmed.
 */

/** Fields that compose the canonical CARD identity hash. Order is fixed. */
export const CARD_IDENTITY_FIELDS = [
  "card_name",
  "set",
  "set_code",
  "card_number",
  "language",
  "rarity",
  "finish",
  "variation",
  "year",
  "manufacturer",
] as const;

export type CardIdentityField = (typeof CARD_IDENTITY_FIELDS)[number];

export interface IdentityInput {
  card_name?: string | null;
  set?: string | null;
  set_code?: string | null;
  card_number?: string | null;
  language?: string | null;
  rarity?: string | null;
  finish?: string | null;
  variation?: string | null;
  year?: string | number | null;
  manufacturer?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_label?: string | null;
  certification_number?: string | null;
  population?: Record<string, unknown> | null;
  pricecharting_product_id?: string | null;
}

export interface CardIdentity {
  card_name: string;
  set: string;
  set_code: string;
  card_number: string;
  language: string;
  rarity: string;
  finish: string;
  variation: string;
  year: string;
  manufacturer: string;
  grader: string;
  grade: string;
  grade_label: string;
  certification_number: string;
  population: Record<string, unknown>;
  pricecharting_product_id: string;
  pricecharting_url: string;
  ebay_query: string;
  /** SHA-256 hex of the canonical CARD identity (specimen fields excluded). */
  hash: string;
}

const text = (v: string | number | null | undefined): string => (v === null || v === undefined ? "" : String(v).trim());

/** Lowercase, collapse whitespace — for hashing/comparison only. */
function normText(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Keep the digits of a year only (e.g. "1999" from "©1999"). */
function normYear(v: string): string {
  const m = v.match(/\d{4}/);
  return m ? m[0] : "";
}

/** Canonicalize a card number: alnum only, drop leading zeros per slash part. */
function normCardNumber(v: string): string {
  return v
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, ""))
    .join("/");
}

/** The normalized value used in the hash for a given field. */
function normalizedFor(field: CardIdentityField, value: string): string {
  if (field === "card_number") return normCardNumber(value);
  if (field === "year") return normYear(value);
  return normText(value);
}

/**
 * The exact string the identity hash is taken over. Deterministic and stable:
 * the same card identity always yields the same string regardless of casing,
 * spacing, or (for the excluded specimen fields) grade/cert. Exposed for tests.
 */
export function canonicalIdentityString(input: IdentityInput): string {
  return CARD_IDENTITY_FIELDS.map((field) => `${field}=${normalizedFor(field, text((input as Record<string, unknown>)[field] as never))}`).join("|");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical CARD identity. Same card ⇒ same hash. */
export function identityHash(input: IdentityInput): Promise<string> {
  return sha256Hex(canonicalIdentityString(input));
}

/**
 * A stable eBay search query from the identity: card + set + number, plus the
 * grader/grade for a graded specimen. Consumed by market-intelligence lookups.
 */
export function ebayQueryFor(input: IdentityInput): string {
  const parts = [text(input.card_name), text(input.set), text(input.card_number)];
  const grade = text(input.grade);
  const grader = text(input.grader);
  if (grader && grade) parts.push(`${grader} ${grade}`);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function priceChartingUrl(productId: string): string {
  return productId ? `https://www.pricecharting.com/offers?product=${encodeURIComponent(productId)}` : "";
}

/** Build the full canonical identity object (including the hash). */
export async function buildIdentity(input: IdentityInput): Promise<CardIdentity> {
  const productId = text(input.pricecharting_product_id);
  return {
    card_name: text(input.card_name),
    set: text(input.set),
    set_code: text(input.set_code),
    card_number: text(input.card_number),
    language: text(input.language),
    rarity: text(input.rarity),
    finish: text(input.finish),
    variation: text(input.variation),
    year: normYear(text(input.year)),
    manufacturer: text(input.manufacturer),
    grader: text(input.grader),
    grade: text(input.grade),
    grade_label: text(input.grade_label),
    certification_number: text(input.certification_number),
    population: input.population ?? {},
    pricecharting_product_id: productId,
    pricecharting_url: priceChartingUrl(productId),
    ebay_query: ebayQueryFor(input),
    hash: await identityHash(input),
  };
}
