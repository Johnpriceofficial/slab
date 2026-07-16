/**
 * Canonical language normalization for card identity + PriceCharting matching.
 *
 * Two jobs:
 *   1. normalizeLanguage()      — fold an OCR/user language string to a canonical
 *                                 value from a fixed, documented vocabulary.
 *   2. detectConsoleLanguage()  — read the language marker out of a PriceCharting
 *                                 CONSOLE/SET name ("Pokemon Japanese Blue Sky
 *                                 Stream"). Returns null when the console carries
 *                                 NO marker, because PriceCharting leaves ENGLISH
 *                                 unmarked — the caller resolves "no marker" to
 *                                 English, never to "unknown".
 *
 * SAFETY: matching is done on WHOLE-WORD tokens, never raw substrings. A naive
 * `/chin/` test matches the Pokémon "Chinchou"; `/japan/` on a card name could
 * misfire too. So language is detected ONLY from the console/set field (never the
 * card name), and only on tokenized word boundaries.
 */

export type CanonicalLanguage =
  | "english"
  | "japanese"
  | "korean"
  | "chinese_simplified"
  | "chinese_traditional"
  | "thai"
  | "indonesian"
  | "spanish"
  | "french"
  | "german"
  | "italian"
  | "portuguese"
  | "dutch"
  | "russian"
  | "other"
  | "unknown";

/**
 * Coarser family used for CONFLICT comparison: Chinese Simplified/Traditional
 * collapse to one "chinese" family (they are the same language for the purpose of
 * "is this the wrong card"), while every distinct language stays separate. `other`
 * and `unknown` have no family (null) — they never drive a hard language conflict.
 */
export type LanguageFamily =
  | "english"
  | "japanese"
  | "korean"
  | "chinese"
  | "thai"
  | "indonesian"
  | "spanish"
  | "french"
  | "german"
  | "italian"
  | "portuguese"
  | "dutch"
  | "russian";

/** Whole-word alias → canonical language. Case/space-insensitive, token-matched. */
const ALIASES: ReadonlyArray<{ canonical: CanonicalLanguage; tokens: readonly string[] }> = [
  { canonical: "japanese", tokens: ["japanese", "japan", "jpn", "jp", "ja", "nihongo"] },
  { canonical: "korean", tokens: ["korean", "korea", "kor", "ko", "hangul"] },
  { canonical: "chinese_simplified", tokens: ["chinese simplified", "simplified chinese", "zh hans", "zhs", "simplified"] },
  { canonical: "chinese_traditional", tokens: ["chinese traditional", "traditional chinese", "zh hant", "zht", "traditional"] },
  // Generic "chinese" with no simp/trad qualifier maps to simplified (the modern default).
  { canonical: "chinese_simplified", tokens: ["chinese", "zh", "zho", "mandarin"] },
  { canonical: "thai", tokens: ["thai", "tha", "th"] },
  { canonical: "indonesian", tokens: ["indonesian", "indonesia", "ind", "bahasa"] },
  { canonical: "spanish", tokens: ["spanish", "espanol", "espanola", "spa", "es"] },
  { canonical: "french", tokens: ["french", "francais", "francaise", "fra", "fr"] },
  { canonical: "german", tokens: ["german", "deutsch", "deu", "ger", "de"] },
  { canonical: "italian", tokens: ["italian", "italiano", "ita", "it"] },
  { canonical: "portuguese", tokens: ["portuguese", "portugues", "por", "pt", "brazilian", "brazil"] },
  { canonical: "dutch", tokens: ["dutch", "nederlands", "nld", "nl"] },
  { canonical: "russian", tokens: ["russian", "russia", "rus", "ru"] },
  { canonical: "english", tokens: ["english", "eng", "en"] },
];

/**
 * Lowercase, strip diacritics, and fold punctuation to spaces so tokens match on
 * word boundaries. Combining marks are REMOVED (not turned into spaces) so
 * "français" folds to "francais" rather than splitting into "franc ais".
 */
function tokenize(s: string): string {
  return ` ${(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** True when `token` (which may itself contain spaces) appears as whole word(s). */
function hasToken(haystackPadded: string, token: string): boolean {
  return haystackPadded.includes(` ${token} `);
}

/**
 * Fold an OCR/user-entered language string to a canonical value. Empty/whitespace
 * → "unknown"; a non-empty string that matches no alias → "other". Never guesses.
 */
export function normalizeLanguage(input: string | null | undefined): CanonicalLanguage {
  const raw = (input ?? "").trim();
  if (!raw) return "unknown";
  const hay = tokenize(raw);
  for (const { canonical, tokens } of ALIASES) {
    for (const t of tokens) {
      if (hasToken(hay, t)) return canonical;
    }
  }
  return "other";
}

/**
 * Detect the language marker in a PriceCharting console/set name. Returns null
 * when NO marker is present — PriceCharting leaves English unmarked, so an
 * unmarked console is resolved to English by the caller, distinct from a genuinely
 * unknown request language. Only multi-letter, unambiguous console markers are
 * used here (never 2-letter codes like "de"/"it", which collide with real words).
 */
export function detectConsoleLanguage(consoleName: string | null | undefined): CanonicalLanguage | null {
  const hay = tokenize(consoleName ?? "");
  if (!hay.trim()) return null;
  const CONSOLE_MARKERS: ReadonlyArray<{ canonical: CanonicalLanguage; tokens: readonly string[] }> = [
    { canonical: "japanese", tokens: ["japanese", "japan"] },
    { canonical: "korean", tokens: ["korean", "korea"] },
    { canonical: "chinese_traditional", tokens: ["chinese traditional", "traditional chinese"] },
    { canonical: "chinese_simplified", tokens: ["chinese simplified", "simplified chinese", "chinese"] },
    { canonical: "thai", tokens: ["thai"] },
    { canonical: "indonesian", tokens: ["indonesian", "indonesia"] },
    { canonical: "spanish", tokens: ["spanish"] },
    { canonical: "french", tokens: ["french"] },
    { canonical: "german", tokens: ["german"] },
    { canonical: "italian", tokens: ["italian"] },
    { canonical: "portuguese", tokens: ["portuguese"] },
    { canonical: "dutch", tokens: ["dutch"] },
    { canonical: "russian", tokens: ["russian"] },
  ];
  for (const { canonical, tokens } of CONSOLE_MARKERS) {
    for (const t of tokens) {
      if (hasToken(hay, t)) return canonical;
    }
  }
  return null; // unmarked → the caller treats this as English
}

/** Collapse a canonical language to its conflict FAMILY (null for other/unknown). */
export function languageFamily(lang: CanonicalLanguage | null | undefined): LanguageFamily | null {
  switch (lang) {
    case "chinese_simplified":
    case "chinese_traditional":
      return "chinese";
    case "english":
    case "japanese":
    case "korean":
    case "thai":
    case "indonesian":
    case "spanish":
    case "french":
    case "german":
    case "italian":
    case "portuguese":
    case "dutch":
    case "russian":
      return lang;
    default:
      return null; // other / unknown / null
  }
}
