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

export interface ScoredCandidate {
  product: Product;
  score: number; // 0..100 normalized
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
}

/** Score a single candidate product against the item's identifiers. */
export function scoreCandidate(item: ItemInput, product: Product): ScoredCandidate {
  const ids = extractIdentifiers(item);
  const hay = normalizeText(`${product.name} ${product.console_or_category ?? ""}`);
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const missing: string[] = [];
  let awarded = 0;
  let possible = 0;
  let disqualified = false;
  let characterExact = false;
  let numberExactFull = false;
  // A "distinctive" number carries a promo suffix or letters ("289/S-P",
  // "SWSH123") and is globally unique; a bare digit ("4") is shared across sets.
  let numberDistinctive = false;

  for (const id of ids) {
    possible += id.weight;

    if (id.kind === "number") {
      // Compare canonical NUMERATORS only. "016/064" → "16" matches candidate
      // "#16"; it does NOT match "#69"/"#76", and is never concatenated to
      // "016064". The denominator (set size) is not part of the identity.
      const wantedTok = cardNumberToken(id.value);
      const candTok = cardNumberToken(extractHashNumber(product.name));
      // Separately, does the FULL printed number (incl. promo suffix) match?
      const wantFull = normalizeFullNumber(id.value);
      const candFull = normalizeFullNumber(extractFullCardNumber(product.name));
      if (wantFull && candFull && wantFull === candFull) numberExactFull = true;
      if (wantFull && /[^0-9]/.test(wantFull)) numberDistinctive = true;
      // Conflicting PROMO SUFFIXES are a hard conflict (S-P vs SV-P), but a
      // MISSING suffix on either side is never a conflict, and numeric
      // denominators (/64) are not suffixes.
      const wantSuffix = promoSuffix(wantFull);
      const candSuffix = promoSuffix(candFull);
      if (wantSuffix && candSuffix && wantSuffix !== candSuffix) {
        conflicts.push(`card_number mismatch: promo suffix /${wantSuffix} (${id.value}) vs /${candSuffix}`);
        disqualified = true;
      }
      if (candTok !== null && wantedTok !== null) {
        if (candTok === wantedTok) {
          awarded += id.weight;
          reasons.push(`Exact ${id.key} #${wantedTok} (display ${id.value})`);
        } else {
          // A DIFFERENT explicit number is a disqualifying conflict.
          conflicts.push(`${id.key} mismatch: wanted #${wantedTok} (${id.value}), candidate #${candTok}`);
          disqualified = true;
        }
      } else if (wantedTok !== null && numberTokenPresent(hay, wantedTok)) {
        awarded += id.weight * 0.85;
        reasons.push(`${id.key} #${wantedTok} present`);
      } else {
        missing.push(`${id.key} #${wantedTok ?? id.value} not found in candidate`);
      }
      continue;
    }

    if (id.kind === "console") {
      // Console/region mismatch is a hard conflict for video games.
      const wantTokens = tokens(id.value);
      const present = wantTokens.some((t) => hay.includes(t));
      if (present) {
        awarded += id.weight;
        reasons.push(`Console matches "${id.value}"`);
      } else {
        conflicts.push(`Console "${id.value}" not present in candidate "${product.console_or_category ?? ""}"`);
        disqualified = true;
      }
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
        } else {
          conflicts.push(`Year mismatch: wanted ${wantYear}, candidate ${relYear}`);
          // Year mismatch is a strong signal but not always disqualifying
          // (reprints); heavily penalize rather than hard-reject.
        }
      } else {
        // The candidate provides no year to compare against — treat as UNKNOWN,
        // not a miss: remove its weight from the denominator so a card whose
        // PriceCharting product simply lists no release date is not penalized.
        possible -= id.weight;
        missing.push(`Year ${wantYear || "?"} could not be confirmed (candidate has no release date)`);
      }
      continue;
    }

    // Text identifier: award proportional to token coverage.
    const wantTokens = tokens(id.value);
    if (wantTokens.length === 0) {
      possible -= id.weight;
      continue;
    }

    // Card name: every MAJOR character must be present. A missing/replaced
    // character (e.g. Piplup vs Pikachu) is a hard disqualification, not a
    // partial-coverage penalty.
    if (id.key === "card_name") {
      const cm = characterMatch(id.value, product.name);
      if (cm.wanted.length > 0 && !cm.ok) {
        conflicts.push(`character mismatch: candidate is missing ${cm.missing.join(", ")}`);
        disqualified = true;
      } else if (cm.wanted.length > 0 && cm.ok) {
        characterExact = true; // every major character present
      }
    }

    const hits = wantTokens.filter((t) => hay.includes(t)).length;
    const coverage = hits / wantTokens.length;
    if (coverage > 0) {
      awarded += id.weight * coverage;
      if (coverage >= 0.99) reasons.push(`Matches ${id.key} "${id.value}"`);
      else reasons.push(`Partial ${id.key} match "${id.value}" (${Math.round(coverage * 100)}%)`);
    } else {
      missing.push(`${id.key} "${id.value}" not found`);
    }
  }

  let score = possible > 0 ? Math.round((awarded / possible) * 100) : 0;

  // IDENTITY FLOOR: an exact character match + an exact DISTINCTIVE full number
  // (promo suffix or alphanumeric — globally unique) with no conflicts is a
  // confident identity match, even when the catalog set label differs
  // ("Sword & Shield Promos" vs "Pokemon Japanese Promo") or PriceCharting lists
  // no year. Those catalog-alias / missing-year differences must not hold a
  // genuine exact match below the confirm threshold. Pure-numeric numbers are
  // NOT distinctive (shared across sets) and are deliberately excluded; genuine
  // multi-candidate ties are still capped by the ambiguity guard downstream.
  if (characterExact && numberExactFull && numberDistinctive && conflicts.length === 0) {
    score = Math.max(score, 95);
    reasons.push("Exact character + exact distinctive collector number — catalog/year differences ignored");
  }

  return { product, score, awarded, possible, reasons, conflicts, missing, disqualified, characterExact, numberExactFull };
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
    .sort((a, b) => b.score - a.score);

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
