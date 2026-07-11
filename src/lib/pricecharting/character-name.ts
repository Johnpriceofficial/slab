/**
 * Character-name matching for Pokémon (and similar) card names.
 *
 * THE BUG THIS FIXES: "Blastoise & Piplup GX" vs a misread "Blastoise & Pikachu
 * GX" previously only lost partial token coverage — the wrong Pokémon was not
 * disqualifying. Every MAJOR named character must be present in the candidate;
 * a candidate that is missing or replaces a character is disqualified.
 *
 * This uses NO fuzzy matching — two distinct Pokémon are never treated as equal.
 * "&" and "and" are treated as equivalent joiners. Card-type suffixes (GX, EX,
 * V, VMAX, …) and joiners are stripped so only character tokens remain.
 */

/** Card-type / rarity suffix tokens that are NOT part of a character's identity. */
const NON_CHARACTER_TOKENS = new Set([
  "gx", "ex", "v", "vmax", "vstar", "vunion", "break", "prime", "legend", "star",
  "delta", "lv", "lvx", "tag", "team", "radiant", "shining", "dark", "light",
  "and", "the", "of", "de", "des", "le", "la", "el", "los",
]);

/** Normalize a name into lowercase word tokens (joiners like "&" become spaces). */
function nameTokens(name: string): string[] {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Extract the MAJOR character tokens from a card name.
 * "Blastoise & Piplup GX" → ["blastoise", "piplup"]
 * "Charizard" → ["charizard"]
 */
export function extractCharacters(name: string): string[] {
  return nameTokens(name).filter(
    (t) => !NON_CHARACTER_TOKENS.has(t) && !/^\d+$/.test(t),
  );
}

export interface CharacterMatch {
  /** True when every wanted character appears in the candidate name. */
  ok: boolean;
  /** Wanted characters absent from the candidate (the disqualifying set). */
  missing: string[];
  wanted: string[];
}

/**
 * Does the candidate name contain every major character of the wanted name?
 * Requires an exact token match per character (no fuzzy equivalence).
 */
export function characterMatch(wantedName: string, candidateName: string): CharacterMatch {
  const wanted = extractCharacters(wantedName);
  const candidateSet = new Set(nameTokens(candidateName));
  const missing = wanted.filter((c) => !candidateSet.has(c));
  // ok only when we actually had characters to check and none are missing.
  return { ok: wanted.length > 0 && missing.length === 0, missing, wanted };
}
