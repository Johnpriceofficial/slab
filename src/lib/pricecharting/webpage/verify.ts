/**
 * Verify that a fetched page genuinely belongs to the linked product BEFORE any
 * price or artwork is accepted. The product id is the primary key; card number,
 * language, and canonical URL corroborate. A conflict is REJECTED — a page is
 * never accepted on title similarity alone. The certification number plays NO
 * part here (it identifies the physical specimen, not the catalog card).
 */

import type { PageIdentityStatus } from "./types";
import type { RawPageExtract } from "./parse";

export interface ExpectedIdentity {
  /** The confirmed PriceCharting product id. Required. */
  product_id: string;
  /** Optional corroborating fields from the canonical card identity. */
  card_number?: string | null;
  language?: string | null;
  canonical_url?: string | null;
}

export interface IdentityVerdict {
  status: PageIdentityStatus;
  reasons: string[];
}

const digitsOnly = (s: string | null | undefined): string => (s ?? "").replace(/[^0-9]/g, "");
const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A page's card number "047/067" or "47" agrees with an expected "047/067". */
function cardNumbersAgree(pageNum: string | null, expected: string | null | undefined): boolean | null {
  if (!expected || !pageNum) return null; // can't compare → no signal
  const a = digitsOnly(pageNum.split("/")[0]).replace(/^0+(?=\d)/, "");
  const b = digitsOnly(expected.split("/")[0]).replace(/^0+(?=\d)/, "");
  if (!a || !b) return null;
  return a === b;
}

export function verifyPageIdentity(extract: RawPageExtract, expected: ExpectedIdentity): IdentityVerdict {
  const reasons: string[] = [];

  // A page that isn't a product page (search/error/challenge/login) is rejected.
  if (!extract.looksLikeProductPage) {
    return { status: "REJECTED", reasons: ["Not a PriceCharting product page (no product identity or price table)."] };
  }

  // Primary key: product id must match when the page exposes one.
  if (extract.product_id && extract.product_id !== String(expected.product_id)) {
    return { status: "REJECTED", reasons: [`Product id conflict: page ${extract.product_id} vs linked ${expected.product_id}.`] };
  }

  // Card number: a conflict is disqualifying.
  const numAgree = cardNumbersAgree(extract.card_number, expected.card_number);
  if (numAgree === false) {
    return { status: "REJECTED", reasons: [`Card number conflict: page "${extract.card_number}" vs linked "${expected.card_number}".`] };
  }

  // Language: a conflict is disqualifying (language affects price).
  if (expected.language && extract.set_or_console) {
    const wantJapanese = /japan/i.test(expected.language);
    const pageJapanese = /japan/i.test(extract.set_or_console);
    if (wantJapanese !== pageJapanese) {
      return { status: "REJECTED", reasons: [`Language/region conflict: page "${extract.set_or_console}" vs linked "${expected.language}".`] };
    }
  }

  // Canonical URL: if present and it identifies a different product, reject.
  if (expected.canonical_url && extract.canonical_url && norm(extract.canonical_url) !== norm(expected.canonical_url)) {
    reasons.push("Canonical URL differs from the linked product's canonical URL.");
  }

  const idConfirmed = extract.product_id === String(expected.product_id);
  const corroborated = numAgree === true;

  if (idConfirmed && (corroborated || expected.card_number == null)) {
    return { status: "VERIFIED", reasons: reasons.length ? reasons : ["Product id (and card number where available) match the linked product."] };
  }
  // No conflict, but not fully corroborated (e.g. id present but number unknown).
  return { status: "PARTIAL", reasons: [...reasons, "Insufficient corroboration for full verification, but no conflict detected."] };
}
