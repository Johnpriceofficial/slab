/**
 * Product identification & matching engine.
 *
 * Accuracy over speed. We never treat the first search result as automatically
 * correct: candidates are scored against every supplied identifier, conflicting
 * candidates are rejected, and a match is only "confirmed" when confidence is
 * high enough (>= 70 generally; >= 85 for graded/variant/high-value items).
 */

import type { PriceChartingClient } from "./client";
import { searchProducts, getProductById, getProductByUPC } from "./api";
import { PriceChartingError, isPriceChartingError } from "./errors";
import { cardNumberToken } from "./card-number";
import { characterMatch } from "./character-name";
import { normalizeLanguage, detectConsoleLanguage, languageFamily } from "./language";
import type {
  ConfidenceLevel,
  ItemInput,
  MatchAssessment,
  Product,
  ProductMatchResult,
} from "./types";

/* --------------------------- text utilities ---------------------------- */

const STOPWORDS = new Set(["the", "of", "a", "an", "and", "card", "edition"]);

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s#-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function tokenHitsHay(haystack: string, token: string): boolean {
  if (haystack.includes(token)) return true;
  if (token.endsWith("s") && token.length > 3 && haystack.includes(token.slice(0, -1))) return true;
  if (!token.endsWith("s") && haystack.includes(`${token}s`)) return true;
  return false;
}

function variationHardConflict(requestedValue: string, candidateHay: string): string | null {
  const requested = normalizeText(requestedValue);
  const wantedReverse = /\breverse[\s-]+holo\b/.test(requested);
  const candidateReverse = /\breverse[\s-]+holo\b/.test(candidateHay);
  const wantedHolo = !wantedReverse && /\bholo\b/.test(requested);
  const candidateHolo = !candidateReverse && /\bholo\b/.test(candidateHay);
  if (wantedReverse && candidateHolo) return "wanted Reverse Holo, candidate is Holo";
  if (wantedHolo && candidateReverse) return "wanted Holo, candidate is Reverse Holo";

  const wantedFirst = /\b(?:1st|first)[\s-]+edition\b/.test(requested);
  const candidateFirst = /\b(?:1st|first)[\s-]+edition\b/.test(candidateHay);
  const wantedUnlimited = /\bunlimited\b/.test(requested);
  const candidateUnlimited = /\bunlimited\b/.test(candidateHay);
  if (wantedFirst && candidateUnlimited) return "wanted First Edition, candidate is Unlimited";
  if (wantedUnlimited && candidateFirst) return "wanted Unlimited, candidate is First Edition";

  const wantedShadowless = /\bshadowless\b/.test(requested);
  const candidateShadowless = /\bshadowless\b/.test(candidateHay);
  if (wantedShadowless && candidateUnlimited) return "wanted Shadowless, candidate is Unlimited";
  if (wantedUnlimited && candidateShadowless) return "wanted Unlimited, candidate is Shadowless";
  return null;
}

/** Extract a `#`-prefixed card/issue number token from a product name, if any. */
export function extractHashNumber(name: string): string | null {
  const m = /#\s*([0-9]+[a-z]?)/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Extract the FULL printed collector number from a product name, including a
 * promo suffix: "Charmander #289/S-P" → "289/S-P", "Charmander #4" → "4".
 */
export function extractFullCardNumber(name: string): string | null {
  const m = /#\s*([0-9]+(?:\s*\/\s*[a-z0-9][a-z0-9-]*)?)/i.exec(name);
  return m ? m[1] : null;
}

/**
 * Normalize a full printed collector number for equality comparison, preserving
 * the complete value: unicode dashes → "-", lowercase, drop a leading "#", and
 * remove whitespace around "/" and "-". "289 / S–P" and "#289/S-P" → "289/s-p".
 */
export function normalizeFullNumber(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s
    .replace(/^#\s*/, "")
    .replace(/[‐-―−]/g, "-") // unicode dashes → ASCII hyphen
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The ALPHABETIC promo suffix after the slash ("289/s-p" → "s-p"), or null. A
 * purely numeric part after the slash is a set-size DENOMINATOR ("16/64"), not a
 * promo family, and is never treated as a suffix.
 */
export function promoSuffix(fullNormalized: string | null): string | null {
  if (!fullNormalized) return null;
  const i = fullNormalized.lastIndexOf("/");
  if (i < 0) return null;
  const suf = fullNormalized.slice(i + 1);
  return /[a-z]/i.test(suf) ? suf : null;
}

/** Does `needle` (a card/issue number like "4" or "17a") appear as a token? */
function numberTokenPresent(haystack: string, needle: string): boolean {
  const n = needle.toLowerCase().replace(/[^0-9a-z]/g, "");
  if (!n) return false;
  const re = new RegExp(`(^|[^0-9a-z])#?${n}([^0-9a-z]|$)`, "i");
  return re.test(haystack);
}

/* --------------------------- identifier model --------------------------- */

interface Identifier {
  key: string;
  value: string;
  weight: number;
  kind: "text" | "number" | "console" | "year";
}

/** Extract the weighted identifiers we will score against, per category. */
export function extractIdentifiers(item: ItemInput): Identifier[] {
  const ids: Identifier[] = [];
  const push = (key: string, value: unknown, weight: number, kind: Identifier["kind"] = "text") => {
    if (value === null || value === undefined) return;
    const v = String(value).trim();
    if (v === "") return;
    ids.push({ key, value: v, weight, kind });
  };

  switch (item.category) {
    case "trading_card":
    case "sports_card": {
      push("card_name", item.card_name ?? item.player_or_character, 30);
      push("card_number", item.card_number, 30, "number");
      push("set", item.set, 20);
      push("subset", item.subset, 8);
      push("year", item.year, 10, "year");
      push("manufacturer", item.manufacturer, 6);
      push("variant", item.variant ?? item.parallel ?? item.insert, 10);
      if (item.holo) push("holo", "holo", 5);
      if (item.reverse_holo) push("reverse_holo", "reverse holo", 6);
      if (item.first_edition) push("first_edition", "1st edition", 8);
      push("edition", item.edition, 5);
      push("language", item.language, 4);
      break;
    }
    case "video_game": {
      push("title", item.title, 35);
      push("console", item.console, 30, "console");
      push("region", item.region, 8);
      push("edition", item.edition ?? (item.collectors_edition ? "collector" : undefined), 10);
      push("variant", item.variant, 8);
      break;
    }
    case "comic": {
      push("series", item.series, 30);
      push("issue_number", item.issue_number, 28, "number");
      push("publisher", item.publisher, 12);
      push("year", item.publication_date, 8, "year");
      push("variant", item.variant_cover, 12);
      push("printing", item.printing, 8);
      push("edition", item.edition, 6);
      break;
    }
    case "coin": {
      push("country", item.country, 20);
      push("denomination", item.denomination, 20);
      push("year", item.year, 20, "year");
      push("mint_mark", item.mint_mark, 12);
      push("variety", item.variety, 12);
      push("composition", item.composition, 6);
      break;
    }
    default: {
      const anyItem = item as { name?: string; raw_description?: string };
      push("name", anyItem.name ?? anyItem.raw_description, 40);
      break;
    }
  }

  // Always allow a raw description to contribute lightly if present.
  if ("raw_description" in item && item.raw_description) push("raw_description", item.raw_description, 4);
  return ids;
}

/** Build a precise, deduplicated search query string. */
export function buildSearchQuery(item: ItemInput): string {
  const ids = extractIdentifiers(item).filter((i) => i.key !== "raw_description");
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    // Card/issue numbers are searched by their canonical numerator ("#16"),
    // never the concatenated "#016064".
    const numTok = id.kind === "number" ? cardNumberToken(id.value) : null;
    const raw = id.kind === "number" ? (numTok ? `#${numTok}` : id.value) : id.value;
    for (const tok of raw.split(/\s+/)) {
      const key = tok.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      parts.push(tok);
    }
  }
  const query = parts.join(" ").trim();
  if (query) return query;
  // Fallback to raw description if nothing structured was supplied.
  if ("raw_description" in item && item.raw_description) return item.raw_description.trim();
  return "";
}

/* ------------------------------ scoring -------------------------------- */

export type FieldResult = "exact" | "normalized_exact" | "partial" | "missing" | "mismatch" | "not_checked";

/** One field's requested-vs-candidate comparison, for the "Why this match?" panel. */
export interface FieldComparison {
  field: string;
  requested_value: string | null;
  candidate_value: string | null;
  normalized_requested_value: string | null;
  normalized_candidate_value: string | null;
  result: FieldResult;
  hard_conflict: boolean;
  points_possible: number;
  points_awarded: number;
  explanation: string;
}

export interface ScoreContribution {
  field: string;
  points: number;
}
export interface ScoreDeduction {
  field: string;
  points: number;
  reason: string;
}

/** Structured, human-inspectable breakdown of one candidate's score. */
export interface ScoreBreakdown {
  raw_score: number;
  adjusted_score: number;
  identity_floor_applied: boolean;
  identity_floor_reason: string | null;
  eligible: boolean;
  disqualified: boolean;
  hard_conflicts: string[];
  soft_conflicts: string[];
  warnings: string[];
  score_contributions: ScoreContribution[];
  score_deductions: ScoreDeduction[];
  fields: FieldComparison[];
}

/** Scoring version — bump when the algorithm changes (stored with confirmations). */
export const SCORING_VERSION = 2;

export interface ScoredCandidate {
  product: Product;
  score: number; // 0..100 normalized (adjusted, after the identity floor)
  awarded: number;
  possible: number;
  reasons: string[];
  conflicts: string[];
  missing: string[];
  disqualified: boolean;
  /** Every major character matched (no missing/replaced character). */
  characterExact: boolean;
  /** The FULL printed number matched, incl. any promo suffix ("289/S-P"). */
  numberExactFull: boolean;
  /** Full structured breakdown (per-field results, contributions, floor reason). */
  breakdown: ScoreBreakdown;
}

/** Score a single candidate product against the item's identifiers. */
export function scoreCandidate(item: ItemInput, product: Product): ScoredCandidate {
  const ids = extractIdentifiers(item);
  const hay = normalizeText(`${product.name} ${product.console_or_category ?? ""}`);
  const reasons: string[] = [];
  const hardConflicts: string[] = [];
  const softConflicts: string[] = [];
  const missing: string[] = [];
  const fields: FieldComparison[] = [];
  const pushField = (f: Partial<FieldComparison> & Pick<FieldComparison, "field" | "result">) =>
    fields.push({
      requested_value: null,
      candidate_value: null,
      normalized_requested_value: null,
      normalized_candidate_value: null,
      hard_conflict: false,
      points_possible: 0,
      points_awarded: 0,
      explanation: "",
      ...f,
    });
  let awarded = 0;
  let possible = 0;
  let disqualified = false;
  let characterExact = false;
  let numberExactFull = false;
  let numberDistinctive = false;

  for (const id of ids) {
    possible += id.weight;

    if (id.kind === "number") {
      const wantedTok = cardNumberToken(id.value);
      const candTok = cardNumberToken(extractHashNumber(product.name));
      const candRawFull = extractFullCardNumber(product.name);
      const wantFull = normalizeFullNumber(id.value);
      const candFull = normalizeFullNumber(candRawFull);
      if (wantFull && candFull && wantFull === candFull) numberExactFull = true;
      if (wantFull && /[^0-9]/.test(wantFull)) numberDistinctive = true;
      const wantSuffix = promoSuffix(wantFull);
      const candSuffix = promoSuffix(candFull);

      // Promo-suffix hard conflict (S-P vs SV-P); missing suffix is never a conflict.
      const suffixConflict = !!(wantSuffix && candSuffix && wantSuffix !== candSuffix);
      if (suffixConflict) {
        hardConflicts.push(`card_number mismatch: promo suffix /${wantSuffix} (${id.value}) vs /${candSuffix}`);
        disqualified = true;
      }

      let numAward = 0;
      let numeratorResult: FieldResult = "not_checked";
      if (candTok !== null && wantedTok !== null) {
        if (candTok === wantedTok) {
          numAward = id.weight;
          numeratorResult = "exact";
          reasons.push(`Exact ${id.key} #${wantedTok} (display ${id.value})`);
        } else {
          numeratorResult = "mismatch";
          hardConflicts.push(`${id.key} mismatch: wanted #${wantedTok} (${id.value}), candidate #${candTok}`);
          disqualified = true;
        }
      } else if (wantedTok !== null && numberTokenPresent(hay, wantedTok)) {
        numAward = id.weight * 0.85;
        numeratorResult = "partial";
        reasons.push(`${id.key} #${wantedTok} present`);
      } else {
        numeratorResult = "missing";
        missing.push(`${id.key} #${wantedTok ?? id.value} not found in candidate`);
      }
      awarded += numAward;

      // Emit the number sub-fields (the weight lives on complete_card_number).
      pushField({
        field: "complete_card_number",
        requested_value: id.value,
        candidate_value: candRawFull,
        normalized_requested_value: wantFull,
        normalized_candidate_value: candFull,
        result: suffixConflict ? "mismatch" : numberExactFull ? "normalized_exact" : numeratorResult,
        hard_conflict: suffixConflict || numeratorResult === "mismatch",
        points_possible: id.weight,
        points_awarded: numAward,
        explanation: numberExactFull
          ? "Full printed number matches exactly."
          : numeratorResult === "mismatch"
            ? "Different collector number."
            : numeratorResult === "partial"
              ? "Numerator present but full number unconfirmed."
              : numeratorResult === "missing"
                ? "Candidate does not expose a collector number."
                : "Numerator matches.",
      });
      pushField({
        field: "numerator",
        requested_value: wantedTok,
        candidate_value: candTok,
        result: candTok === null || wantedTok === null ? "missing" : candTok === wantedTok ? "exact" : "mismatch",
        hard_conflict: candTok !== null && wantedTok !== null && candTok !== wantedTok,
        explanation: "Leading numeric collector number.",
      });
      pushField({
        field: "promo_suffix",
        requested_value: wantSuffix,
        candidate_value: candSuffix,
        result: !wantSuffix && !candSuffix ? "not_checked" : !wantSuffix || !candSuffix ? "missing" : wantSuffix === candSuffix ? "exact" : "mismatch",
        hard_conflict: suffixConflict,
        explanation: "Promotional family suffix (e.g. S-P). A numeric denominator (/64) is not a suffix.",
      });
      continue;
    }

    if (id.kind === "console") {
      const wantTokens = tokens(id.value);
      const present = wantTokens.some((t) => hay.includes(t));
      if (present) {
        awarded += id.weight;
        reasons.push(`Console matches "${id.value}"`);
      } else {
        hardConflicts.push(`Console "${id.value}" not present in candidate "${product.console_or_category ?? ""}"`);
        disqualified = true;
      }
      pushField({
        field: "console",
        requested_value: id.value,
        candidate_value: product.console_or_category,
        result: present ? "partial" : "mismatch",
        hard_conflict: !present,
        points_possible: id.weight,
        points_awarded: present ? id.weight : 0,
        explanation: "Console/region (hard conflict for video games).",
      });
      continue;
    }

    if (id.kind === "year") {
      const yearMatch = /\b(19|20)\d{2}\b/.exec(id.value);
      const wantYear = yearMatch ? yearMatch[0] : id.value.replace(/[^0-9]/g, "").slice(0, 4);
      const relRaw = product.release_date ?? "";
      const relYear = /\b(19|20)\d{2}\b/.exec(relRaw)?.[0] ?? relRaw.slice(0, 4);
      if (wantYear && relYear) {
        if (wantYear === relYear) {
          awarded += id.weight;
          reasons.push(`Year matches ${wantYear}`);
          pushField({ field: "year", requested_value: wantYear, candidate_value: relYear, result: "exact", points_possible: id.weight, points_awarded: id.weight, explanation: "Release year matches." });
        } else {
          softConflicts.push(`Year mismatch: wanted ${wantYear}, candidate ${relYear}`);
          pushField({ field: "year", requested_value: wantYear, candidate_value: relYear, result: "mismatch", hard_conflict: false, points_possible: id.weight, points_awarded: 0, explanation: "Year differs (SOFT — reprints exist; requires review, not a hard reject)." });
        }
      } else {
        possible -= id.weight; // candidate has no year → UNKNOWN, not penalized
        missing.push(`Year ${wantYear || "?"} could not be confirmed (candidate has no release date)`);
        pushField({ field: "year", requested_value: wantYear || null, candidate_value: relYear || null, result: "missing", points_possible: 0, points_awarded: 0, explanation: "Candidate lists no release date — unknown, not penalized." });
      }
      continue;
    }

    const wantTokens = tokens(id.value);
    if (wantTokens.length === 0) {
      possible -= id.weight;
      continue;
    }

    let charHard = false;
    let languageHard = false;
    if (id.key === "language") {
      // PriceCharting marks ASIAN-language catalogs explicitly ("Pokemon Japanese
      // ...", "... Korean ...", "... Chinese ...") and leaves ENGLISH as the
      // UNMARKED default. Treating an unmarked candidate as "unknown" (the old
      // behavior) is exactly what let a Japanese slab link to the ENGLISH product:
      // both carry the same character and the same 151/165 number, and the English
      // page has no "japanese" token, so no conflict was ever raised. An unmarked
      // candidate is therefore ENGLISH, not unknown. A RECOGNIZED requested
      // language that disagrees with the candidate's (marked, or defaulted-English)
      // language is a HARD conflict — language materially changes the card and its
      // price. An UNRECOGNIZED requested language (null) never disqualifies.
      // Read language from the candidate's CONSOLE/SET name ONLY (never the card
      // name — a card named "Chinchou" must not read as Chinese) and on whole-word
      // tokens, never substrings. Compare by language FAMILY (Chinese Simplified /
      // Traditional collapse to one family).
      const wantedLanguage = languageFamily(normalizeLanguage(id.value));
      const candidateMarked = (() => {
        const l = detectConsoleLanguage(product.console_or_category);
        return l ? languageFamily(l) : null; // null when the console is unmarked
      })();
      if (wantedLanguage && candidateMarked && wantedLanguage !== candidateMarked) {
        // Two DIFFERENT positively-identified languages — unambiguously the wrong
        // card (e.g. a Japanese slab against a "... Korean ..." catalog). Hard reject.
        hardConflicts.push(`language mismatch: wanted ${wantedLanguage}, candidate is ${candidateMarked}`);
        disqualified = true;
        languageHard = true;
      } else if (wantedLanguage && wantedLanguage !== "english" && !candidateMarked) {
        // Wanted a NON-English language but the candidate console carries NO marker.
        // Because English is unmarked, this is AMBIGUOUS — most likely the English
        // product, but possibly an unmarked non-English catalog. Do NOT hard-reject
        // (that could drop the correct product), but raise a conflict so it can NEVER
        // be auto-confirmed: the exact language/catalog must be proven (public page or
        // visual) first. This is the guard that stops a Japanese slab from silently
        // linking to the English product.
        softConflicts.push(
          `language unverified: requested ${wantedLanguage}, but the candidate carries no language marker (English is unmarked on PriceCharting) — confirm the exact catalog before accepting`,
        );
      }
    }
    if (id.key === "card_name") {
      const cm = characterMatch(id.value, product.name);
      if (cm.wanted.length > 0 && !cm.ok) {
        hardConflicts.push(`character mismatch: candidate is missing ${cm.missing.join(", ")}`);
        disqualified = true;
        charHard = true;
      } else if (cm.wanted.length > 0 && cm.ok) {
        characterExact = true;
      }
    }

    if (id.key === "holo" || id.key === "reverse_holo") {
      const candidateReverse = /\breverse[\s-]+holo\b/.test(hay);
      const candidateHolo = !candidateReverse && /\bholo\b/.test(hay);
      const wantsReverse = id.key === "reverse_holo";
      const finishConflict = wantsReverse ? candidateHolo : candidateReverse;
      let finishAward = 0;
      let result: FieldResult = "missing";
      let explanation = "Finish not exposed by candidate metadata.";
      if (finishConflict) {
        const wanted = wantsReverse ? "Reverse Holo" : "Holo";
        const actual = candidateReverse ? "Reverse Holo" : "Holo";
        hardConflicts.push(`finish mismatch: wanted ${wanted}, candidate is ${actual}`);
        disqualified = true;
        result = "mismatch";
        explanation = "Holo and Reverse Holo are materially different finishes.";
      } else if ((wantsReverse && candidateReverse) || (!wantsReverse && candidateHolo)) {
        finishAward = id.weight;
        result = "exact";
        explanation = "Finish matches.";
        reasons.push(`Finish matches "${id.value}"`);
      } else {
        missing.push(`finish "${id.value}" not found`);
      }
      awarded += finishAward;
      pushField({
        field: "finish",
        requested_value: id.value,
        candidate_value: candidateReverse ? "Reverse Holo" : candidateHolo ? "Holo" : null,
        result,
        hard_conflict: finishConflict,
        points_possible: id.weight,
        points_awarded: finishAward,
        explanation,
      });
      continue;
    }

    const hits = wantTokens.filter((t) => tokenHitsHay(hay, t)).length;
    const coverage = hits / wantTokens.length;
    let textHard = false;
    let textExplanation =
      id.key === "card_name"
        ? charHard
          ? "A required character is missing/replaced (hard conflict)."
          : "Every major character present."
        : id.key === "set"
          ? "Set/catalog alias or partial label (soft unless no requested set token appears)."
          : "Supporting descriptor (soft).";
    if (id.key === "variant") {
      const conflict = variationHardConflict(id.value, hay);
      if (conflict) {
        hardConflicts.push(`variation mismatch: ${conflict}`);
        disqualified = true;
        textHard = true;
        textExplanation = "Variation mismatch (hard conflict for known mutually exclusive variants).";
      }
    }
    if (id.key === "set" && coverage === 0 && (product.console_or_category ?? "").trim()) {
      hardConflicts.push(`set mismatch: wanted "${id.value}", candidate catalog is "${product.console_or_category}"`);
      disqualified = true;
      textHard = true;
      textExplanation = "Set/catalog mismatch (hard conflict when no requested set token appears).";
    }
    const fieldAward = id.weight * coverage;
    if (coverage > 0) {
      awarded += fieldAward;
      if (coverage >= 0.99) reasons.push(`Matches ${id.key} "${id.value}"`);
      else reasons.push(`Partial ${id.key} match "${id.value}" (${Math.round(coverage * 100)}%)`);
    } else {
      missing.push(`${id.key} "${id.value}" not found`);
    }
    // The card_name field is the "character" comparison; other text ids are soft.
    pushField({
      field: id.key === "card_name" ? "character" : id.key === "variant" ? "variation" : id.key,
      requested_value: id.value,
      candidate_value: product.name,
      normalized_requested_value: normalizeText(id.value),
      normalized_candidate_value: hay,
      result: charHard || textHard ? "mismatch" : coverage >= 0.99 ? "exact" : coverage > 0 ? "partial" : "missing",
      hard_conflict: charHard || languageHard || textHard,
      points_possible: id.weight,
      points_awarded: fieldAward,
      explanation: textExplanation,
    });
  }

  // Artwork can't be compared from PriceCharting metadata — always not_checked.
  pushField({ field: "artwork", result: "not_checked", explanation: "PriceCharting metadata carries no artwork to compare; use the image gallery." });

  const rawScore = possible > 0 ? Math.round((awarded / possible) * 100) : 0;
  let score = rawScore;
  let identityFloorApplied = false;
  let identityFloorReason: string | null = null;

  const conflicts = [...hardConflicts, ...softConflicts];
  // IDENTITY FLOOR (see prior comment): exact character + exact DISTINCTIVE full
  // number + no conflicts floors the score so catalog-alias / missing-year
  // differences don't hold a genuine exact match below the confirm threshold.
  if (characterExact && numberExactFull && numberDistinctive && conflicts.length === 0) {
    if (score < 95) {
      identityFloorApplied = true;
      identityFloorReason = "Exact character + exact distinctive collector number, no conflicts — catalog-alias/missing-year differences ignored.";
    }
    score = Math.max(score, 95);
    reasons.push("Exact character + exact distinctive collector number — catalog/year differences ignored");
  }

  const score_contributions: ScoreContribution[] = fields
    .filter((f) => f.points_awarded > 0)
    .map((f) => ({ field: f.field, points: Math.round(f.points_awarded * 100) / 100 }));
  const score_deductions: ScoreDeduction[] = fields
    .filter((f) => f.points_possible > 0 && f.points_awarded < f.points_possible)
    .map((f) => ({ field: f.field, points: Math.round((f.points_possible - f.points_awarded) * 100) / 100, reason: f.explanation }));

  const breakdown: ScoreBreakdown = {
    raw_score: rawScore,
    adjusted_score: score,
    identity_floor_applied: identityFloorApplied,
    identity_floor_reason: identityFloorReason,
    eligible: !disqualified,
    disqualified,
    hard_conflicts: hardConflicts,
    soft_conflicts: softConflicts,
    warnings: missing,
    score_contributions,
    score_deductions,
    fields,
  };

  return { product, score, awarded, possible, reasons, conflicts, missing, disqualified, characterExact, numberExactFull, breakdown };
}

/* --------------------------- confidence gate --------------------------- */

const AMBIGUITY_MARGIN = 8; // points between #1 and #2 that we treat as "too close"

function levelFor(score: number): ConfidenceLevel {
  if (score >= 95) return "Exact";
  if (score >= 85) return "High";
  if (score >= 70) return "Probable";
  if (score >= 50) return "Low";
  return "Unresolved";
}

export function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  const nameDelta = a.product.name.localeCompare(b.product.name, undefined, { numeric: true, sensitivity: "base" });
  if (nameDelta !== 0) return nameDelta;
  const categoryDelta = (a.product.console_or_category ?? "").localeCompare(b.product.console_or_category ?? "", undefined, { numeric: true, sensitivity: "base" });
  if (categoryDelta !== 0) return categoryDelta;
  return a.product.pricecharting_id.localeCompare(b.product.pricecharting_id, undefined, { numeric: true, sensitivity: "base" });
}

/** Items where a wrong match is expensive require >= 85 to confirm. */
export function requiresHighConfidence(item: ItemInput): boolean {
  const anyItem = item as unknown as Record<string, unknown>;
  if (typeof anyItem.grade === "number") return true; // graded
  if (anyItem.variant || anyItem.parallel || anyItem.refractor || anyItem.insert) return true;
  if (anyItem.autograph || anyItem.serial_number || anyItem.error_card) return true;
  if (anyItem.variant_cover) return true;
  return false;
}

/**
 * Find the best product match for a structured item.
 * Required core function #4.
 *
 * Order of precedence:
 *   1. Explicit pricecharting_id  -> verified direct lookup.
 *   2. UPC                        -> direct lookup.
 *   3. Full-text search + scoring -> confidence-gated selection.
 */
export async function findBestProductMatch(
  client: PriceChartingClient,
  item: ItemInput,
): Promise<ProductMatchResult> {
  // 1. Explicit id.
  if (item.pricecharting_id) {
    const product = await getProductById(client, item.pricecharting_id);
    const scored = scoreCandidate(item, product);
    return {
      product,
      match: buildAssessment(scored, [], { forcedReason: "Explicit PriceCharting id supplied", minScore: 95 }),
    };
  }

  // 2. UPC.
  if (item.upc) {
    const product = await getProductByUPC(client, item.upc);
    const scored = scoreCandidate(item, product);
    return {
      product,
      match: buildAssessment(scored, [], { forcedReason: "Matched by UPC", minScore: 90 }),
    };
  }

  // 3. Search + score.
  const query = buildSearchQuery(item);
  if (!query) {
    return { product: null, match: unresolvedAssessment(["No identifiers supplied to search with."]) };
  }

  let candidates: Product[];
  try {
    candidates = await searchProducts(client, query);
  } catch (err) {
    if (isPriceChartingError(err) && err.code === "PRODUCT_NOT_FOUND") {
      return { product: null, match: unresolvedAssessment([`No products matched query "${query}".`]) };
    }
    throw err;
  }

  if (candidates.length === 0) {
    return { product: null, match: unresolvedAssessment([`No products matched query "${query}".`]) };
  }

  const scored = candidates
    .map((c) => scoreCandidate(item, c))
    .sort(compareScoredCandidates);

  const eligible = scored.filter((s) => !s.disqualified);
  const alternatives = scored.slice(0, 5).map((s) => ({
    pricecharting_id: s.product.pricecharting_id,
    name: s.product.name,
    console_or_category: s.product.console_or_category,
    score: s.score,
  }));

  if (eligible.length === 0) {
    return {
      product: null,
      match: {
        ...unresolvedAssessment(["All candidates conflicted with the supplied identifiers."]),
        conflicts: scored[0]?.conflicts ?? [],
        alternatives_considered: alternatives,
      },
    };
  }

  const top = eligible[0];
  const runnerUp = eligible[1];

  let confidence = top.score;
  const extraConflicts: string[] = [];
  // Ambiguity: a near-tie with a different product cannot be a confident match.
  if (runnerUp && top.score - runnerUp.score < AMBIGUITY_MARGIN) {
    confidence = Math.min(confidence, 68);
    extraConflicts.push(
      `Ambiguous: candidate ${runnerUp.product.pricecharting_id} scored ${runnerUp.score} vs ${top.score}.`,
    );
  }
  // Penalize residual (non-disqualifying) conflicts like year mismatch.
  if (top.conflicts.length > 0) confidence = Math.max(0, confidence - 20);

  const threshold = requiresHighConfidence(item) ? 85 : 70;
  const assessment: MatchAssessment = {
    confidence_score: confidence,
    confidence_level: levelFor(confidence),
    match_reasons: top.reasons,
    conflicts: [...top.conflicts, ...extraConflicts],
    missing_information: top.missing,
    alternatives_considered: alternatives.filter((a) => a.pricecharting_id !== top.product.pricecharting_id),
  };

  // Confirm the match only if confidence clears the threshold.
  const product = confidence >= threshold ? top.product : null;
  return { product, match: assessment };
}

function buildAssessment(
  scored: ScoredCandidate,
  extraConflicts: string[],
  opts: { forcedReason: string; minScore: number },
): MatchAssessment {
  const confidence = Math.max(opts.minScore, scored.score);
  const finalConfidence = scored.disqualified ? Math.min(scored.score, 60) : confidence;
  return {
    confidence_score: finalConfidence,
    confidence_level: levelFor(finalConfidence),
    match_reasons: [opts.forcedReason, ...scored.reasons],
    conflicts: [...scored.conflicts, ...extraConflicts],
    missing_information: scored.missing,
    alternatives_considered: [],
  };
}

function unresolvedAssessment(missing: string[]): MatchAssessment {
  return {
    confidence_score: 0,
    confidence_level: "Unresolved",
    match_reasons: [],
    conflicts: [],
    missing_information: missing,
    alternatives_considered: [],
  };
}

/**
 * True when a scored candidate's conflicts are ENTIRELY card_number mismatches
 * (never character/console/set). Used to distinguish "this card is definitely
 * not it" (character/console conflict — always a hard reject) from "this could
 * still be it if the number was misread" (number-only conflict — a candidate
 * for degraded-confirmation, never for silent auto-selection).
 *
 * WHY THIS MATTERS: some sets print near-duplicate cards that share every
 * identifier except the collector number (e.g. multiple alt-art/parallel
 * prints of the same card in one set). For those, dropping the number
 * constraint entirely would make MULTIPLE candidates equally "eligible" —
 * silently picking one would be a real chance of picking the wrong print.
 * The correct handling is therefore NOT "ignore the number and auto-resolve",
 * it's "stop hard-rejecting solely for a number mismatch and let the operator
 * pick from the survivors after checking the physical card" — see
 * conflictsAreNumberOnly's caller in the server handler.
 */
export function conflictsAreNumberOnly(conflicts: string[]): boolean {
  return conflicts.length > 0 && conflicts.every((c) => c.startsWith("card_number mismatch:"));
}

/** Re-exported for the confidence-gate constant, used in valuation. */
export function confidenceLevelFor(score: number): ConfidenceLevel {
  return levelFor(score);
}
export function confirmThreshold(item: ItemInput): number {
  return requiresHighConfidence(item) ? 85 : 70;
}
export { PriceChartingError };
