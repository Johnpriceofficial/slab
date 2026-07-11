/**
 * Certification / grader normalization — the single source of truth the UI uses
 * for duplicate detection. It MUST stay byte-for-byte equivalent to the SQL
 * functions `normalize_cert(text)` and `normalize_grader(text)` in
 * migrations/20260711000000_cert_normalization.sql, because the database's
 * composite unique index is the real guarantee and the UI only previews it.
 *
 * Rules (identical on both sides):
 *   - Trim surrounding whitespace.
 *   - Remove ALL internal whitespace (spaces, tabs) so "1234 5678" == "12345678".
 *   - Uppercase (case-insensitive match).
 *   - Preserve every remaining character, including leading zeros and hyphens —
 *     "000123" and "123" are DIFFERENT certs.
 *
 * The original, operator-entered certification text is never mutated by this;
 * it is stored and displayed verbatim. Normalization only powers uniqueness.
 */

/** Normalize a certification number for duplicate comparison. */
export function normalizeCert(cert: string | null | undefined): string {
  if (cert === null || cert === undefined) return "";
  return cert.replace(/\s+/g, "").toUpperCase();
}

/** Normalize a grader/grading-company name for duplicate comparison. */
export function normalizeGrader(grader: string | null | undefined): string {
  if (grader === null || grader === undefined) return "";
  return grader.replace(/\s+/g, "").toUpperCase();
}

/**
 * Composite key used for a grader-scoped duplicate check. Empty when either part
 * normalizes to empty (an incomplete record can't collide with a complete one).
 */
export function certCompositeKey(grader: string | null | undefined, cert: string | null | undefined): string | null {
  const g = normalizeGrader(grader);
  const c = normalizeCert(cert);
  if (!g || !c) return null;
  return `${g}:${c}`;
}
