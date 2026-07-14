/**
 * Deterministic identity normalization applied AFTER the vision model replies.
 *
 * The model is told that compatible readings are not conflicts (e.g. a numeric
 * grade "10" alongside a label "PRISTINE"), but a prompt is a request, not a
 * guarantee. This module makes the reconciliation deterministic and testable:
 * pure functions, no model, no network, no guessing of unreadable characters.
 *
 * It never INVENTS a value. It only:
 *   - splits a combined grade token ("PRISTINE 10") into grade + designation,
 *   - composes/decomposes rarity + finish <-> variation,
 *   - canonicalizes known grader names, and
 *   - strips spaces/punctuation from a certification number (digits untouched).
 *
 * Bundled into the Edge Function alongside the analyze-slab handler, so it runs
 * identically in Node (vitest) and Deno (production).
 */

export interface GradeParts {
  grade: string;
  grade_label: string;
}

/** Canonical grader tokens the app understands. */
const GRADER_ALIASES: Record<string, string> = {
  cgc: "CGC",
  "certified guaranty company": "CGC",
  psa: "PSA",
  "professional sports authenticator": "PSA",
  bgs: "BGS",
  beckett: "BGS",
  "beckett grading services": "BGS",
  sgc: "SGC",
  "sportscard guaranty": "SGC",
  "sportscard guaranty corporation": "SGC",
  ags: "AGS",
  "ace grading": "AGS",
};

/**
 * Split a grade string into its numeric grade and its designation/tier label.
 *
 *   normalizeGrade("PRISTINE 10") => { grade: "10", grade_label: "PRISTINE" }
 *   normalizeGrade("10")          => { grade: "10", grade_label: "" }
 *   normalizeGrade("GEM MINT 9.5")=> { grade: "9.5", grade_label: "GEM MINT" }
 *
 * The numeric grade is the first number token (supports one decimal, e.g. 9.5);
 * everything else is the label. Never fabricates a grade that isn't present.
 */
export function normalizeGrade(raw: string | null | undefined): GradeParts {
  const text = (raw ?? "").trim();
  if (!text) return { grade: "", grade_label: "" };
  const match = text.match(/(?<![\d.])\d{1,2}(?:\.\d)?(?![\d.])/);
  const grade = match ? match[0] : "";
  const label = (match ? text.replace(match[0], " ") : text).replace(/\s+/g, " ").trim();
  return { grade, grade_label: label };
}

export interface VariationParts {
  rarity: string;
  finish: string;
  variation: string;
}

/**
 * Reconcile rarity, finish, and a combined variation string. These three are
 * compatible views of one fact, never a conflict:
 *
 *   { rarity: "Mega Attack Rare", finish: "Holo", variation: "" }
 *     => variation: "Mega Attack Rare - Holo"
 *
 *   { rarity: "", finish: "Holo", variation: "Mega Attack Rare - Holo" }
 *     => rarity: "Mega Attack Rare"
 *
 * Composition and decomposition are both deterministic and lossless: a value is
 * only ever DERIVED from another present value, never invented.
 */
export function normalizeVariation(parts: {
  rarity?: string | null;
  finish?: string | null;
  variation?: string | null;
}): VariationParts {
  let rarity = (parts.rarity ?? "").trim();
  let finish = (parts.finish ?? "").trim();
  let variation = (parts.variation ?? "").trim();

  // Compose the combined form when both components are present but it is blank.
  if (!variation && rarity && finish) {
    variation = `${rarity} - ${finish}`;
  } else if (!variation && rarity && !finish) {
    variation = rarity;
  }

  // Decompose a "<rarity> - <finish>" variation to fill a missing component,
  // matching on the dash separator only (no fuzzy splitting).
  if (variation.includes(" - ")) {
    const [head, ...rest] = variation.split(" - ");
    const tail = rest.join(" - ").trim();
    if (!rarity && head.trim()) rarity = head.trim();
    if (!finish && tail) finish = tail;
  } else if (variation && finish && !rarity && variation.toLowerCase().endsWith(finish.toLowerCase())) {
    // "Mega Attack Rare - Holo" already handled above; here handle "... Holo"
    // without the dash by trimming the finish suffix.
    const stripped = variation.slice(0, variation.length - finish.length).replace(/[-\s]+$/, "").trim();
    if (stripped) rarity = stripped;
  }

  return { rarity, finish, variation };
}

/**
 * Canonicalize a grading company name to a known token (CGC, PSA, BGS, SGC,
 * AGS). An unrecognized grader is returned trimmed and unchanged — normalization
 * must never destroy a reading it doesn't recognize.
 */
export function normalizeGrader(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const key = text.toLowerCase().replace(/[.\s]+/g, " ").trim();
  return GRADER_ALIASES[key] ?? text;
}

/**
 * Normalize a certification number by removing spaces and punctuation ONLY.
 * Every alphanumeric character — including leading zeros — is preserved exactly
 * as read. A digit is never replaced, dropped, or "corrected".
 */
export function normalizeCertification(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^0-9A-Za-z]/g, "");
}

/**
 * A field carrying a reconciled value plus whether normalization DERIVED it from
 * other present evidence (so a caller can surface a derived value distinctly).
 */
export interface NormalizedField {
  value: string;
  derived: boolean;
}

export interface NormalizedIdentity {
  grade: NormalizedField;
  grade_label: NormalizedField;
  rarity: NormalizedField;
  finish: NormalizedField;
  variation: NormalizedField;
}

/**
 * Apply grade and variation reconciliation across a set of already-read values,
 * treating compatible readings as one fact rather than a conflict. Pure and
 * order-independent; used by the analyze handler after the model + re-verify
 * passes so the same logic runs in Node and Deno.
 */
export function reconcileIdentity(input: {
  grade?: string | null;
  grade_label?: string | null;
  rarity?: string | null;
  finish?: string | null;
  variation?: string | null;
}): NormalizedIdentity {
  const rawGrade = (input.grade ?? "").trim();
  const rawLabel = (input.grade_label ?? "").trim();

  // A designation may arrive folded into either field ("PRISTINE 10" in the
  // label, or the whole thing in grade). Split both and prefer explicit values.
  const fromGrade = normalizeGrade(rawGrade);
  const fromLabel = normalizeGrade(rawLabel);
  const grade = fromGrade.grade || fromLabel.grade;
  // The label designation is whatever text remains once the number is removed,
  // from whichever field carried it.
  const grade_label = fromLabel.grade_label || fromGrade.grade_label;

  const variation = normalizeVariation({
    rarity: input.rarity,
    finish: input.finish,
    variation: input.variation,
  });

  const field = (value: string, ...sources: Array<string | null | undefined>): NormalizedField => ({
    value,
    derived: value !== "" && !sources.some((s) => (s ?? "").trim() === value),
  });

  return {
    grade: field(grade, rawGrade),
    grade_label: field(grade_label, rawLabel),
    rarity: field(variation.rarity, input.rarity),
    finish: field(variation.finish, input.finish),
    variation: field(variation.variation, input.variation),
  };
}
