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
 */

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
  /** The slab's own designation on its exact tier (e.g. "Pristine"), else null. */
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
}

export interface TierIdentity {
  grader: string | null;
  grade: string | null;
  grade_label: string | null;
}

/** Static metadata for every card price tier key PriceCharting can expose. */
export const CARD_TIER_META: ReadonlyArray<{
  key: string;
  label: string;
  grader: string | null;
  grade: string | null;
}> = [
  { key: "ungraded", label: "Ungraded", grader: null, grade: null },
  { key: "grade_7_to_7_5", label: "Grade 7–7.5", grader: null, grade: "7" },
  { key: "grade_8_to_8_5", label: "Grade 8–8.5", grader: null, grade: "8" },
  { key: "grade_9_general", label: "Grade 9 (general)", grader: null, grade: "9" },
  { key: "grade_9_5_general", label: "Grade 9.5 (general)", grader: null, grade: "9.5" },
  { key: "psa_10", label: "PSA 10", grader: "PSA", grade: "10" },
  { key: "cgc_10", label: "CGC 10", grader: "CGC", grade: "10" },
  { key: "bgs_10", label: "BGS 10", grader: "BGS", grade: "10" },
  { key: "sgc_10", label: "SGC 10", grader: "SGC", grade: "10" },
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
  const exactKey = graderTenKey(id.grader, id.grade);
  const designation = id.grade_label ? titleCase(id.grade_label) : null;

  return CARD_TIER_META.map((meta) => {
    const raw = values[meta.key];
    const value_cents = raw === null || raw === undefined ? null : raw;
    const exact_match = exactKey !== null && meta.key === exactKey;
    return {
      tier: meta.key,
      label: meta.label,
      grader: meta.grader,
      grade: meta.grade,
      designation: exact_match ? designation : null,
      value_cents,
      available: value_cents !== null,
      exact_match,
      source: "PriceCharting",
    };
  });
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
