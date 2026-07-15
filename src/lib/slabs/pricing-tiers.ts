/**
 * Canonical PriceCharting price-tier records — the single shared shape used for
 * BOTH persistence (JSONB on the slab) and display (the grade table). Building
 * them here once guarantees the intake page and the detail page classify and
 * label every tier identically.
 *
 * Rules honoured:
 *   - Unavailable tiers are stored with value_cents = null, never $0.
 *   - Tiers absent from the API keep a null value — a value is never fabricated.
 *   - PSA 10 / CGC 10 / BGS 10 / SGC 10 are distinct graders and never merged.
 *   - CGC 10, CGC 10 Pristine, and CGC 10 Perfect are DISTINCT tiers. A
 *     designation tier is never synthesized from the ordinary CGC 10 value.
 */

import { normalizeDesignation } from "@/lib/pricecharting/grade-mapping";

/** One PriceCharting tier for a product, normalized + classified. */
export interface PriceTier {
  /** Stable key, e.g. "cgc_10", "ungraded". */
  tier: string;
  /** Human label, e.g. "CGC 10", "Ungraded". */
  label: string;
  /** Normalized grading company for a grader-specific tier, else null. */
  grader: string | null;
  /** Grade for the tier, e.g. "10", "9", "9.5", else null (ungraded). */
  grade: string | null;
  /**
   * The tier's OWN intrinsic sub-designation (e.g. "Pristine" for the distinct
   * `cgc_10_pristine` tier), else null. This is a property of the tier itself —
   * it is NEVER copied from the slab onto an ordinary tier.
   */
  designation: string | null;
  /** Value in integer cents, or null when PriceCharting has no value for it. */
  value_cents: number | null;
  /** Convenience mirror of (value_cents !== null). */
  available: boolean;
  /** True when this tier is the slab's own grader + grade. */
  exact_match: boolean;
  /** Data source, always "PriceCharting". */
  source: string;
}

/** The structured JSONB persisted on a slab (never token-bearing). */
export interface PricingPersist {
  source: string;
  /** ISO retrieval timestamp — also the stale-write guard key. */
  retrieved_at: string;
  tiers: PriceTier[];
}

/** A pricing write: the structured tier table + the raw safe response for audit. */
export interface SlabPricingWrite {
  persist: PricingPersist;
  /** Raw token-free PriceCharting pricing response, stored for audit only. */
  raw?: unknown;
  /**
   * Scalar PriceCharting mirror fields to update ATOMICALLY with the tiers (set
   * on refresh; omitted on the initial save, where create_slab already set them).
   */
  scalars?: import("./pricing-refresh").RefreshScalars;
}

export interface TierIdentity {
  grader: string | null;
  grade: string | null;
  grade_label: string | null;
}

interface TierMeta {
  key: string;
  label: string;
  grader: string | null;
  grade: string | null;
  /** The tier's own intrinsic sub-designation (e.g. "Pristine"), else null. */
  designation: string | null;
}

/**
 * Static metadata for every card price tier key PriceCharting can expose via the
 * API. None of these carry a sub-designation: the API's grade-10 fields
 * (condition-17-price etc.) are the ordinary grade-10 tiers with no Pristine.
 */
export const CARD_TIER_META: ReadonlyArray<TierMeta> = [
  { key: "ungraded", label: "Ungraded", grader: null, grade: null, designation: null },
  { key: "grade_7_to_7_5", label: "Grade 7–7.5", grader: null, grade: "7", designation: null },
  { key: "grade_8_to_8_5", label: "Grade 8–8.5", grader: null, grade: "8", designation: null },
  { key: "grade_9_general", label: "Grade 9 (general)", grader: null, grade: "9", designation: null },
  { key: "grade_9_5_general", label: "Grade 9.5 (general)", grader: null, grade: "9.5", designation: null },
  { key: "psa_10", label: "PSA 10", grader: "PSA", grade: "10", designation: null },
  { key: "cgc_10", label: "CGC 10", grader: "CGC", grade: "10", designation: null },
  { key: "bgs_10", label: "BGS 10", grader: "BGS", grade: "10", designation: null },
  { key: "sgc_10", label: "SGC 10", grader: "SGC", grade: "10", designation: null },
];

/**
 * Distinct top-designation tiers (e.g. "CGC 10 Pristine", "BGS 10 Black Label").
 * These are modelled as their OWN tiers, separate from the ordinary grade-10
 * tier. PriceCharting exposes a distinct column for some of them (CGC 10 Pristine
 * = condition-19-price, BGS 10 Black Label = condition-20-price); for those the
 * value map carries a real distinct value. For the rest the value stays null —
 * we NEVER synthesize one by copying the ordinary grade-10 value.
 */
export const DESIGNATION_TIER_META: ReadonlyArray<TierMeta> = [
  { key: "cgc_10_pristine", label: "CGC 10 Pristine", grader: "CGC", grade: "10", designation: "Pristine" },
  { key: "cgc_10_perfect", label: "CGC 10 Perfect", grader: "CGC", grade: "10", designation: "Perfect" },
  { key: "bgs_10_pristine", label: "BGS 10 Pristine", grader: "BGS", grade: "10", designation: "Pristine" },
  { key: "bgs_10_black_label", label: "BGS 10 Black Label", grader: "BGS", grade: "10", designation: "Black Label" },
];

/** "PRISTINE" → "Pristine"; leaves numbers/short codes intact. */
export function titleCase(s: string): string {
  return s.replace(/\b([A-Za-z])([A-Za-z]*)\b/g, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
}

export function normalizeGrader(grader: string | null | undefined): string | null {
  const g = (grader ?? "").trim().toUpperCase();
  if (g === "PSA" || g === "CGC" || g === "BGS" || g === "SGC") return g;
  return null;
}

/** The grade-10 tier key for a grading company, or null (non-10 / unknown grader). */
export function graderTenKey(grader: string | null, grade: string | null): string | null {
  const g = normalizeGrader(grader);
  const n = Number((grade ?? "").replace(/[^0-9.]/g, ""));
  if (!g || n !== 10) return null;
  return `${g.toLowerCase()}_10`;
}

/**
 * The slab's exact tier key, accounting for its designation. A CGC 10 *Pristine*
 * slab's exact tier is the distinct `cgc_10_pristine` tier — NOT the ordinary
 * `cgc_10` tier. A plain or Gem-Mint CGC 10 slab's exact tier is `cgc_10`.
 * Returns null when there is no grader-specific grade-10 tier (non-10 grades).
 */
export function exactTierKey(id: TierIdentity): string | null {
  const base = graderTenKey(id.grader, id.grade);
  if (!base) return null;
  const desig = normalizeDesignation(id.grade_label);
  if (desig === "pristine" || desig === "perfect" || desig === "black_label") {
    const designationKey = `${base}_${desig}`;
    return DESIGNATION_TIER_META.some((m) => m.key === designationKey) ? designationKey : base;
  }
  return base;
}

/** The slab's full tier label, e.g. "CGC 10 Pristine". */
export function tierLabelOf(id: TierIdentity): string {
  return [id.grader, id.grade, id.grade_label ? titleCase(id.grade_label) : null]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Build the canonical tier records for a product from the per-tier value map the
 * value response returns (buildAvailableValues card keys). Every known tier is
 * represented; absent ones get value_cents = null (never fabricated, never $0).
 */
export function buildPriceTiers(
  availableValuesCents: Record<string, number | null> | null | undefined,
  id: TierIdentity,
): PriceTier[] {
  const values = availableValuesCents ?? {};
  const exactKey = exactTierKey(id);

  const toTier = (meta: TierMeta): PriceTier => {
    const raw = values[meta.key];
    const value_cents = raw === null || raw === undefined ? null : raw;
    return {
      tier: meta.key,
      label: meta.label,
      grader: meta.grader,
      grade: meta.grade,
      // A tier's designation is intrinsic to the tier, never copied from the slab.
      designation: meta.designation,
      value_cents,
      available: value_cents !== null,
      exact_match: exactKey !== null && meta.key === exactKey,
      source: "PriceCharting",
    };
  };

  const tiers = CARD_TIER_META.map(toTier);

  // Represent a distinct designation tier ONLY when the source supplies a value for
  // it OR it is the slab's own exact tier (so the exact tier is shown honestly,
  // as unavailable, rather than by decorating the ordinary grade-10 tier).
  for (const meta of DESIGNATION_TIER_META) {
    const sourceHasValue = values[meta.key] !== null && values[meta.key] !== undefined;
    if (sourceHasValue || meta.key === exactKey) tiers.push(toTier(meta));
  }

  return tiers;
}

/** Assemble the JSONB persistence payload from live tier values. */
export function buildPricingPersist(
  availableValuesCents: Record<string, number | null> | null | undefined,
  id: TierIdentity,
  retrievedAtIso: string,
): PricingPersist {
  return {
    source: "PriceCharting",
    retrieved_at: retrievedAtIso,
    tiers: buildPriceTiers(availableValuesCents, id),
  };
}

/** Read persisted tiers back into PriceTier[], or null when absent/malformed. */
export function hydratePriceTiers(persist: PricingPersist | null | undefined): PriceTier[] | null {
  if (!persist || !Array.isArray(persist.tiers) || persist.tiers.length === 0) return null;
  return persist.tiers;
}

/**
 * Stale-write guard: may an incoming pricing response (retrieved at `incomingIso`)
 * overwrite the stored one (retrieved at `existingIso`)? An unstamped incoming
 * response never overwrites; an equal-or-newer one does.
 */
export function isNewerPricing(existingIso: string | null | undefined, incomingIso: string | null | undefined): boolean {
  const incoming = incomingIso ? Date.parse(incomingIso) : NaN;
  if (Number.isNaN(incoming)) return false;
  if (!existingIso) return true;
  const existing = Date.parse(existingIso);
  if (Number.isNaN(existing)) return true;
  return incoming >= existing;
}
