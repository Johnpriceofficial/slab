/**
 * Canonical Pokémon (and general TCG) collector-number parsing + equivalence.
 *
 * THE BUG THIS FIXES: the previous matcher normalized "016/064" by stripping all
 * non-alphanumerics → "016064", then compared that to a candidate's "#16" and
 * hard-disqualified it. Collector numbers are numerator/denominator; only the
 * NUMERATOR identifies the card. This module is the single source of truth for
 * parsing and comparing them, used by both the matcher and the server handler.
 *
 * Rules:
 *   - Preserve the operator's display value exactly ("016/064").
 *   - Parse numerator ("016") and denominator ("064") separately.
 *   - Canonical numerator strips leading zeros for comparison ("16"), lowercased.
 *   - The PriceCharting comparison token is the canonical numerator ("16").
 *   - NEVER concatenate numerator+denominator.
 *   - Alphanumeric promos (SV49/SV94, TG12/TG30, SWSH123, H12) keep their
 *     meaningful prefix; only leading zeros in a pure-digit token are dropped.
 */

export interface ParsedCardNumber {
  /** Trimmed original, preserved for display: "016/064". */
  display: string;
  /** Left of the slash (or the whole token): "016". */
  numerator: string | null;
  /** Right of the slash: "064" (null when there is no slash). */
  denominator: string | null;
  /** Canonical numerator for comparison: "16" (leading zeros dropped, lowercased). */
  canonicalNumerator: string | null;
  /** Canonical denominator: "64". */
  canonicalDenominator: string | null;
  /** True when the numerator carries a non-digit prefix/suffix (promo/subset). */
  isAlphanumeric: boolean;
}

/** Drop leading zeros but keep at least one digit ("016" → "16", "000" → "0"). */
function dropLeadingZeros(s: string): string {
  return s.replace(/^0+(?=[0-9a-z])/i, "");
}

/** Canonicalize one part: lowercase, keep [0-9a-z], drop leading zeros. */
function canon(part: string | null | undefined): string | null {
  if (!part) return null;
  const cleaned = part.trim().toLowerCase().replace(/[^0-9a-z]/g, "");
  if (!cleaned) return null;
  return dropLeadingZeros(cleaned);
}

/**
 * Parse a collector number in any of these forms:
 *   "016/064", "16/64", "#016", "#16", "16", "SV49/SV94", "TG12", "SWSH123"
 */
export function parseCardNumber(raw: string | null | undefined): ParsedCardNumber {
  const display = (raw ?? "").trim();
  let numerator: string | null = null;
  let denominator: string | null = null;

  if (display) {
    // Strip a single leading '#', then split on the first slash.
    const body = display.replace(/^#\s*/, "").trim();
    const slash = body.indexOf("/");
    if (slash >= 0) {
      numerator = body.slice(0, slash).trim() || null;
      denominator = body.slice(slash + 1).trim() || null;
    } else {
      // Prefix-then-number promos where the SET CODE comes first and is
      // whitespace-separated from the number: "SM-P 289", "S-P 289", "SWSH 020"
      // → the collector number is the trailing pure-digit segment ("289").
      // Contiguous alphanumerics ("SWSH123", "TG12") are left whole — there the
      // whole token IS the collector number.
      const segs = body.split(/\s+/).filter(Boolean);
      const last = segs[segs.length - 1];
      const hasSetCodePrefix = segs.slice(0, -1).some((s) => /[a-z]/i.test(s));
      if (segs.length > 1 && /^\d+$/.test(last) && hasSetCodePrefix) {
        numerator = last;
        denominator = segs.slice(0, -1).join(" ");
      } else {
        numerator = body || null;
      }
    }
  }

  const canonicalNumerator = canon(numerator);
  return {
    display,
    numerator,
    denominator,
    canonicalNumerator,
    canonicalDenominator: canon(denominator),
    isAlphanumeric: canonicalNumerator !== null && /[a-z]/.test(canonicalNumerator),
  };
}

/** The single token to compare/search with (the canonical numerator, e.g. "16"). */
export function cardNumberToken(raw: string | null | undefined): string | null {
  return parseCardNumber(raw).canonicalNumerator;
}

/**
 * Are two collector numbers the same card? Compares canonical NUMERATORS only —
 * the denominator (set size) is not part of the identity, so "016/064" == "16/64"
 * == "#16", but "016/064" != "015/064" and != "#69".
 * Returns false when either side has no parseable numerator (cannot confirm).
 */
export function cardNumbersEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ca = cardNumberToken(a);
  const cb = cardNumberToken(b);
  return ca !== null && cb !== null && ca === cb;
}
