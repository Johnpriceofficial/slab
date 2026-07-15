/**
 * Identity completeness assessment.
 *
 * Market matching quality depends on how fully a card is identified. This module
 * reports — WITHOUT blocking any results — whether an identity is complete enough
 * for exact matching, which fields are missing, and what each missing field does
 * to match quality. A missing HELPFUL field downgrades exactness; it never
 * globally suppresses market data. A missing certification number is irrelevant
 * to CARD valuation (it only affects physical-specimen verification).
 *
 * No persistence, no migration: this only describes the input it is given.
 */

export type CompletenessStatus = "complete" | "partial" | "ambiguous";

/** How a given missing field affects matching. */
type Effect = "blocks_all" | "blocks_exact" | "downgrades_exact" | "irrelevant";

export interface CompletenessNote {
  field: string;
  effect: Effect;
  /** Plain-language explanation of the missing field's impact. */
  detail: string;
}

export interface IdentityCompleteness {
  status: CompletenessStatus;
  /** Relevant fields (name/number/language/variation/finish) that are missing. */
  missing: string[];
  /** One note per missing field, including fields that are explicitly irrelevant. */
  notes: CompletenessNote[];
}

export type SpecimenKind = "raw" | "certified";

interface Rule {
  field: string;
  effect: Effect;
  detail: string;
}

const RAW_RULES: readonly Rule[] = [
  { field: "card_name", effect: "blocks_all", detail: "Without a card name, no market match is possible." },
  { field: "card_number", effect: "blocks_exact", detail: "A missing card number generally blocks exact-card matching; results may include other cards from the set." },
  { field: "language", effect: "downgrades_exact", detail: "Missing language may downgrade exact matching when language affects price." },
  { field: "variation", effect: "downgrades_exact", detail: "Missing variation may downgrade exact matching if printing variants exist." },
  { field: "finish", effect: "downgrades_exact", detail: "Missing finish may downgrade exact matching if foil/holo finishes vary." },
  { field: "certification_number", effect: "irrelevant", detail: "A certification number is not relevant to raw-card valuation." },
];

const CERTIFIED_RULES: readonly Rule[] = [
  { field: "card_name", effect: "blocks_all", detail: "Without a card name, no market match is possible." },
  { field: "card_number", effect: "blocks_exact", detail: "A missing card number generally blocks exact-card matching; results may include other cards from the set." },
  { field: "language", effect: "downgrades_exact", detail: "Missing language may downgrade exact matching when language affects price." },
  { field: "variation", effect: "downgrades_exact", detail: "Missing variation may downgrade exact matching if printing variants exist." },
  { field: "finish", effect: "downgrades_exact", detail: "Missing finish may downgrade exact matching if foil/holo finishes vary." },
  { field: "certification_number", effect: "irrelevant", detail: "A missing certification number affects physical-specimen verification, not card valuation." },
];

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim().length > 0;
}

/**
 * Assess how completely a card is identified for market matching. Never blocks
 * results — a `partial` or `ambiguous` status still permits (lower-confidence)
 * market data. `missing` lists the matching-relevant fields that are absent;
 * fields whose effect is `irrelevant` are reported in `notes` only.
 */
export function assessIdentityCompleteness(
  identity: Record<string, unknown>,
  kind: SpecimenKind,
): IdentityCompleteness {
  const rules = kind === "raw" ? RAW_RULES : CERTIFIED_RULES;
  const notes: CompletenessNote[] = [];
  const missing: string[] = [];
  let hasBlocking = false;
  let hasDowngrade = false;

  for (const rule of rules) {
    if (present(identity[rule.field])) continue;
    notes.push({ field: rule.field, effect: rule.effect, detail: rule.detail });
    if (rule.effect === "irrelevant") continue; // reported, but does not affect status/missing
    missing.push(rule.field);
    if (rule.effect === "blocks_all" || rule.effect === "blocks_exact") hasBlocking = true;
    if (rule.effect === "downgrades_exact") hasDowngrade = true;
  }

  const status: CompletenessStatus = hasBlocking ? "ambiguous" : hasDowngrade ? "partial" : "complete";
  return { status, missing, notes };
}
