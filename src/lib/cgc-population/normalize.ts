/**
 * Deterministic normalization for CGC population matching. Kept separate from
 * scoring so both retrieval and comparison use identical canonical forms.
 *
 * The card-number NUMERATOR token reuses the PriceCharting tokenizer (the single
 * source of truth) — but per spec it is a retrieval AID only and never overrides
 * set / character / language / variation conflicts. The complete printed number
 * (e.g. "289/S-P") is always preserved separately.
 */

import { parseCardNumber } from "@/lib/pricecharting/card-number";

/** Lowercase, strip diacritics + trademark marks, collapse whitespace. */
export function normalizeText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const cleaned = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics: Pokémon → Pokemon
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/** Card name normalized to a comparable form (diacritics/case/space folded). */
export function normalizeCardName(s: string | null | undefined): string | null {
  return normalizeText(s);
}

/** Set name normalized for comparison. */
export function normalizeSetName(s: string | null | undefined): string | null {
  return normalizeText(s);
}

/** Parallel/variant normalized for comparison. */
export function normalizeVariant(s: string | null | undefined): string | null {
  return normalizeText(s);
}

/**
 * The COMPLETE printed collector number, folded to a comparable form but with
 * its full value preserved ("289/S-P" → "289/s-p"). Never reduced to just the
 * numerator here — that would lose the printed identity.
 */
export function normalizeCardNumber(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const cleaned = s.toLowerCase().replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

/** Canonical numerator token for retrieval ("289/S-P" → "289"). Aid only. */
export function cardNumberToken(s: string | null | undefined): string | null {
  return parseCardNumber(s).canonicalNumerator;
}
