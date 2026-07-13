/**
 * Deterministic CGC population matching + grade/population computation.
 *
 * Matching runs ONLY for CGC slabs and ONLY after identity is established. A
 * record is never selected merely because the card number matches: wrong name,
 * number, set, year, or parallel/promotional variation are HARD conflicts that
 * disqualify a candidate. The complete printed number ("289/S-P") is preserved;
 * the numerator token is a retrieval aid that cannot override other conflicts.
 *
 * This is population (supply) matching — NOT certification verification.
 */

import {
  GRADE_TIERS,
  AUTHENTIC_COUNT_FIELDS,
  type CgcPopulationCard,
  type GradeTier,
  type PopulationMatchStatus,
} from "./types";
import { cardNumberToken, normalizeCardName, normalizeCardNumber, normalizeSetName, normalizeVariant } from "./normalize";

export interface SlabIdentityForMatch {
  grader: string | null;
  card_name: string | null;
  card_number: string | null;
  set_name: string | null;
  year: number | string | null;
  variation: string | null;
  language: string | null;
  grade: string | null;
  grade_label: string | null;
}

/* ------------------------- grade → tier resolution ------------------------ */

function designationOf(gradeLabel: string | null): "perfect" | "pristine" | "gem_mint" | null {
  const l = (gradeLabel ?? "").toLowerCase();
  if (l.includes("perfect")) return "perfect";
  if (l.includes("pristine")) return "pristine";
  if (l.includes("gem")) return "gem_mint";
  return null;
}

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Map the slab's grade + designation to its exact population tier. Grade 10
 * REQUIRES a recognized designation (Perfect / Pristine / Gem Mint) — otherwise
 * it is ambiguous and returns null (we never guess which 10).
 */
export function resolveSlabTier(grade: string | null, gradeLabel: string | null): GradeTier | null {
  const n = Number((grade ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || (grade ?? "").trim() === "") return null;

  if (approx(n, 10)) {
    const desig = designationOf(gradeLabel);
    if (!desig) return null; // ambiguous 10 — designation required
    return GRADE_TIERS.find((t) => t.grade === 10 && t.designation === desig) ?? null;
  }
  const exact = GRADE_TIERS.find((t) => t.grade !== null && approx(t.grade, n));
  if (exact) return exact;
  // Below the lowest enumerated numeric tier → the "Lower grades" bucket.
  if (n < 6) return GRADE_TIERS.find((t) => t.field === "count_lower_grades") ?? null;
  return null;
}

export interface PopulationView {
  tier: GradeTier | null;
  total: number | null;
  at_grade: number | null;
  higher: number;
  lower: number;
}

/** Sum reported counts (null contributes 0) for tiers in a rank predicate. */
function sumTiers(card: CgcPopulationCard, pred: (t: GradeTier) => boolean): number {
  return GRADE_TIERS.filter(pred).reduce((acc, t) => acc + (card.counts[t.field] ?? 0), 0);
}

/** Compute the population view (at-grade / higher / lower / total) for a card + tier. */
export function computePopulationView(card: CgcPopulationCard, tier: GradeTier | null): PopulationView {
  return {
    tier,
    total: card.counts.total_graded,
    at_grade: tier ? card.counts[tier.field] : null,
    higher: tier ? sumTiers(card, (t) => t.rank < tier.rank) : 0,
    lower: tier ? sumTiers(card, (t) => t.rank > tier.rank) : 0,
  };
}

/* ------------------------------- matching -------------------------------- */

/** All word tokens of one set are contained in the other's (either direction). */
function tokenSubset(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  return ta.every((t) => tb.includes(t)) || tb.every((t) => ta.includes(t));
}

function yearDigits(v: number | string | null): string | null {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/\d{4}/);
  return m ? m[0] : null;
}

export interface CandidateAssessment {
  card: CgcPopulationCard;
  conflicts: string[];
  /** True full printed-number equality (strongest number match). */
  fullNumberMatch: boolean;
  nameMatched: boolean;
  setMatched: boolean;
}

/** Assess one candidate against the slab identity — collect hard conflicts. */
export function assessCandidate(slab: SlabIdentityForMatch, card: CgcPopulationCard): CandidateAssessment {
  const conflicts: string[] = [];

  const slabName = normalizeCardName(slab.card_name);
  const nameMatched = tokenSubset(slabName, card.normalized_card_name);
  if (slabName && card.normalized_card_name && !nameMatched) conflicts.push("wrong card name");

  const slabFullNum = normalizeCardNumber(slab.card_number);
  const slabToken = cardNumberToken(slab.card_number);
  const fullNumberMatch = !!slabFullNum && slabFullNum === card.normalized_card_number;
  const tokenMatch = !!slabToken && slabToken === card.card_number_token;
  if (slabFullNum && card.normalized_card_number && !fullNumberMatch && !tokenMatch) {
    conflicts.push("wrong card number");
  }

  const slabSet = normalizeSetName(slab.set_name);
  const setMatched = tokenSubset(slabSet, card.normalized_set_name);
  if (slabSet && card.normalized_set_name && !setMatched) conflicts.push("wrong set");

  const sy = yearDigits(slab.year);
  const cy = yearDigits(card.year);
  if (sy && cy && sy !== cy) conflicts.push("wrong year");

  const sv = normalizeVariant(slab.variation);
  const cv = card.normalized_variant;
  if (sv && cv && sv !== cv) conflicts.push("wrong parallel/promotional variation");

  return { card, conflicts, fullNumberMatch, nameMatched, setMatched };
}

export interface PopulationMatchResult {
  status: PopulationMatchStatus;
  card: CgcPopulationCard | null;
  confidence: number;
  method: string;
  conflicts: string[];
  /** Candidates disqualified on a hard conflict, with reasons. */
  rejected: CandidateAssessment[];
}

/**
 * Match a CGC slab against candidate population records for its set.
 * `setIndexed` distinguishes "set not indexed" from "set indexed, no matching card".
 */
export function matchPopulation(
  slab: SlabIdentityForMatch,
  candidates: CgcPopulationCard[],
  setIndexed: boolean,
): PopulationMatchResult {
  const none = { card: null, confidence: 0, method: "", conflicts: [], rejected: [] as CandidateAssessment[] };

  if ((slab.grader ?? "").trim().toUpperCase() !== "CGC") {
    return { status: "not_applicable", ...none };
  }
  if (!setIndexed) return { status: "not_indexed", ...none };
  if (candidates.length === 0) return { status: "no_record_found", ...none };

  const assessed = candidates.map((c) => assessCandidate(slab, c));
  const eligible = assessed.filter((a) => a.conflicts.length === 0);
  const rejected = assessed.filter((a) => a.conflicts.length > 0);

  if (eligible.length === 0) {
    // Candidates existed but every one conflicts on a mandatory field.
    return { status: "rejected", card: null, confidence: 20, method: "All candidates conflict on a mandatory identity field.", conflicts: [], rejected };
  }
  if (eligible.length > 1) {
    return { status: "ambiguous", card: null, confidence: 50, method: `${eligible.length} candidates remain after conflict filtering.`, conflicts: [], rejected };
  }

  const win = eligible[0];
  // Exact requires the full printed number AND a name AND a set match.
  if (win.fullNumberMatch && win.nameMatched && win.setMatched) {
    return { status: "confirmed_exact", card: win.card, confidence: 97, method: "Exact match on name + full printed number + set.", conflicts: [], rejected };
  }
  if (win.nameMatched && (win.fullNumberMatch || win.setMatched)) {
    return { status: "high_confidence_proposed", card: win.card, confidence: 85, method: "Strong match with one identity field unconfirmed — review before relying on it.", conflicts: [], rejected };
  }
  return { status: "needs_review", card: win.card, confidence: 60, method: "Partial match (numerator/one field) — manual review required.", conflicts: [], rejected };
}

export const AUTHENTIC_FIELDS = AUTHENTIC_COUNT_FIELDS;
