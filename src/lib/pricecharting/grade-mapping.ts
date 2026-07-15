/**
 * Category-specific price-field interpretation.
 *
 * CRITICAL: the SAME raw API field means different things per category. There is
 * NO universal price mapping. Every function here is explicit about category and
 * about whether a value is company-specific or a general grade value.
 *
 * Card grade rules (from the spec):
 *   - loose-price        -> Ungraded
 *   - cib-price          -> Grade 7 / 7.5
 *   - new-price          -> Grade 8 / 8.5
 *   - graded-price       -> GENERAL Grade 9 (NOT company-specific)
 *   - box-only-price     -> Grade 9.5 (general)
 *   - manual-only-price  -> PSA 10
 *   - bgs-10-price       -> BGS 10
 *   - condition-17-price -> CGC 10
 *   - condition-18-price -> SGC 10
 *   - condition-19-price -> CGC 10 Pristine   (distinct from ordinary CGC 10)
 *   - condition-20-price -> BGS 10 Black Label (distinct from ordinary BGS 10)
 *   - condition-21-price -> TAG 10
 *   - condition-22-price -> ACE 10
 * Never substitute PSA 10 / CGC 10 / SGC 10 / BGS 10 for one another, and never
 * substitute an ordinary grade-10 value for its distinct top-designation tier
 * (CGC 10 vs CGC 10 Pristine, BGS 10 vs BGS 10 Black Label).
 */

import { convertPenniesToDollars, type Pennies } from "./money";
import type { AvailableValues, CollectibleCategory, GradeLookupResult, GradingCompany, Product } from "./types";

export type PriceCategory = "video_game" | "card" | "comic" | "coin" | "generic";

/** Map a collectible category to its price-interpretation family. */
export function categoryToPriceCategory(category: CollectibleCategory): PriceCategory {
  switch (category) {
    case "trading_card":
    case "sports_card":
      return "card";
    case "video_game":
      return "video_game";
    case "comic":
      return "comic";
    case "coin":
      return "coin";
    default:
      return "generic"; // funko_pop, lego, other
  }
}

/** Best-effort inference from the product's console/category label (fallback only). */
export function inferPriceCategoryFromProduct(product: Product): PriceCategory {
  const c = (product.console_or_category ?? "").toLowerCase();
  if (!c) return "generic";
  if (c.includes("card")) return "card";
  if (c.includes("comic")) return "comic";
  if (c.includes("coin") || c.includes("currency")) return "coin";
  // Common console names imply video games.
  const gameHints = ["nintendo", "playstation", "xbox", "sega", "gameboy", "game boy", "atari", "wii", "ps1", "ps2", "ps3", "ps4", "ps5", "switch"];
  if (gameHints.some((h) => c.includes(h))) return "video_game";
  return "generic";
}

const px = (product: Product, field: string): Pennies | null => product.raw_prices[field] ?? null;
const dollars = (p: Pennies | null): number | null => convertPenniesToDollars(p);

/**
 * Build a labeled map of ALL available values for a product, with labels
 * appropriate to the price category. Missing fields are `null`.
 */
export function buildAvailableValues(product: Product, category: PriceCategory): AvailableValues {
  switch (category) {
    case "card":
      return {
        ungraded: dollars(px(product, "loose-price")),
        grade_7_to_7_5: dollars(px(product, "cib-price")),
        grade_8_to_8_5: dollars(px(product, "new-price")),
        grade_9_general: dollars(px(product, "graded-price")),
        grade_9_5_general: dollars(px(product, "box-only-price")),
        psa_10: dollars(px(product, "manual-only-price")),
        bgs_10: dollars(px(product, "bgs-10-price")),
        cgc_10: dollars(px(product, "condition-17-price")),
        sgc_10: dollars(px(product, "condition-18-price")),
        // Distinct top-designation tiers — their OWN fields, never the ordinary
        // grade-10 value. Absent → null (dropped by callers), never substituted.
        cgc_10_pristine: dollars(px(product, "condition-19-price")),
        bgs_10_black_label: dollars(px(product, "condition-20-price")),
        tag_10: dollars(px(product, "condition-21-price")),
        ace_10: dollars(px(product, "condition-22-price")),
      };
    case "comic":
      return {
        ungraded: dollars(px(product, "loose-price")),
        grade_4_0_to_4_5: dollars(px(product, "cib-price")),
        grade_6_0_to_6_5: dollars(px(product, "new-price")),
        grade_8_0_to_8_5: dollars(px(product, "graded-price")),
        grade_9_2: dollars(px(product, "box-only-price")),
        grade_9_4: dollars(px(product, "condition-17-price")),
        grade_9_8: dollars(px(product, "manual-only-price")),
        grade_10_0: dollars(px(product, "bgs-10-price")),
      };
    case "video_game":
      return {
        loose: dollars(px(product, "loose-price")),
        cib: dollars(px(product, "cib-price")),
        new_sealed: dollars(px(product, "new-price")),
        graded: dollars(px(product, "graded-price")),
        box_only: dollars(px(product, "box-only-price")),
        manual_only: dollars(px(product, "manual-only-price")),
        retail_loose_buy: dollars(px(product, "retail-loose-buy")),
        retail_loose_sell: dollars(px(product, "retail-loose-sell")),
        retail_cib_buy: dollars(px(product, "retail-cib-buy")),
        retail_cib_sell: dollars(px(product, "retail-cib-sell")),
        retail_new_buy: dollars(px(product, "retail-new-buy")),
        retail_new_sell: dollars(px(product, "retail-new-sell")),
      };
    case "coin":
    case "generic":
    default:
      // No documented card/comic/game mapping applies. Expose raw fields under
      // deliberately generic labels so nothing is misrepresented.
      return {
        ungraded_or_base: dollars(px(product, "loose-price")),
        secondary: dollars(px(product, "cib-price")),
        tertiary: dollars(px(product, "new-price")),
        graded_general: dollars(px(product, "graded-price")),
        high_grade_a: dollars(px(product, "box-only-price")),
        high_grade_b: dollars(px(product, "manual-only-price")),
        top_grade_bgs10_field: dollars(px(product, "bgs-10-price")),
        top_grade_c17_field: dollars(px(product, "condition-17-price")),
        top_grade_c18_field: dollars(px(product, "condition-18-price")),
      };
  }
}

/** Approx equality for float grades like 9, 9.0, 7.5. */
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const isOneOf = (g: number, opts: number[]) => opts.some((o) => eq(g, o));

interface FieldPick {
  field: string | null;
  meaning: string | null;
  companySpecific: boolean;
  /** Warning text specific to this pick (e.g. general-grade-9 caveat). */
  warnings: string[];
}

/** Resolve which card field a (company, grade) request maps to. */
function pickCardField(company: GradingCompany | undefined, grade: number): FieldPick {
  // Grade 10 is company-specific — never substitute across companies.
  if (eq(grade, 10)) {
    switch (company) {
      case "PSA":
        return { field: "manual-only-price", meaning: "PSA 10", companySpecific: true, warnings: [] };
      case "BGS":
        return { field: "bgs-10-price", meaning: "BGS 10", companySpecific: true, warnings: [] };
      case "CGC":
        return { field: "condition-17-price", meaning: "CGC 10", companySpecific: true, warnings: [] };
      case "SGC":
        return { field: "condition-18-price", meaning: "SGC 10", companySpecific: true, warnings: [] };
      default:
        return {
          field: null,
          meaning: null,
          companySpecific: false,
          warnings: [
            "Grade 10 is company-specific. Provide the grading company (PSA/BGS/CGC/SGC) to select the correct value. See nearby values.",
          ],
        };
    }
  }
  if (isOneOf(grade, [9, 9.0])) {
    return {
      field: "graded-price",
      meaning: "General Grade 9 market value",
      companySpecific: false,
      warnings: [
        "PriceCharting provides a general Grade 9 value, not a company-specific Grade 9 value. Do not treat this as a PSA/CGC/BGS/SGC-specific Grade 9.",
      ],
    };
  }
  if (isOneOf(grade, [9.5])) {
    return { field: "box-only-price", meaning: "General Grade 9.5 market value", companySpecific: false, warnings: [] };
  }
  if (isOneOf(grade, [8, 8.5])) {
    return { field: "new-price", meaning: "Grade 8 / 8.5 market value", companySpecific: false, warnings: [] };
  }
  if (isOneOf(grade, [7, 7.5])) {
    return { field: "cib-price", meaning: "Grade 7 / 7.5 market value", companySpecific: false, warnings: [] };
  }
  return { field: null, meaning: null, companySpecific: false, warnings: [] };
}

/** Resolve which comic field a numeric grade maps to. */
function pickComicField(grade: number): FieldPick {
  if (isOneOf(grade, [10, 10.0])) return { field: "bgs-10-price", meaning: "Comic Grade 10.0", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.8])) return { field: "manual-only-price", meaning: "Comic Grade 9.8", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.4])) return { field: "condition-17-price", meaning: "Comic Grade 9.4", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.2])) return { field: "box-only-price", meaning: "Comic Grade 9.2", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [8.0, 8.5])) return { field: "graded-price", meaning: "Comic Grade 8.0 / 8.5", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [6.0, 6.5])) return { field: "new-price", meaning: "Comic Grade 6.0 / 6.5", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [4.0, 4.5])) return { field: "cib-price", meaning: "Comic Grade 4.0 / 4.5", companySpecific: false, warnings: [] };
  return { field: null, meaning: null, companySpecific: false, warnings: [] };
}

/** Normalize a grade designation label to a canonical token. */
export function normalizeDesignation(gradeLabel: string | null | undefined): "pristine" | "gem_mint" | "perfect" | "black_label" | null {
  const l = (gradeLabel ?? "").toLowerCase();
  if (/black\s*label/.test(l)) return "black_label";
  if (l.includes("perfect")) return "perfect";
  if (l.includes("pristine")) return "pristine";
  if (l.includes("gem")) return "gem_mint";
  return null;
}

/**
 * The DISTINCT top-designation field for a (company, grade, designation), when
 * PriceCharting exposes one. These are separate columns from the ordinary
 * grade-10 field — CGC 10 Pristine (condition-19) is NOT CGC 10 (condition-17),
 * and BGS 10 Black Label (condition-20) is NOT BGS 10 (bgs-10). Returns null when
 * there is no distinct designation field (the caller then keeps the ordinary tier
 * as a clearly-labeled COMPATIBLE value, never an exact one).
 */
function designationFieldFor(
  company: GradingCompany | undefined,
  grade: number,
  designation: ReturnType<typeof normalizeDesignation>,
): string | null {
  if (!eq(grade, 10)) return null;
  if (company === "CGC" && designation === "pristine") return "condition-19-price";
  if (company === "BGS" && designation === "black_label") return "condition-20-price";
  return null;
}

/** Map a raw PriceCharting price field to a normalized card tier key. */
function fieldToCardTier(field: string | null): { key: string | null; label: string | null } {
  switch (field) {
    case "loose-price": return { key: "ungraded", label: "Ungraded" };
    case "cib-price": return { key: "grade_7_to_7_5", label: "Grade 7–7.5" };
    case "new-price": return { key: "grade_8_to_8_5", label: "Grade 8–8.5" };
    case "graded-price": return { key: "grade_9_general", label: "Grade 9 (general)" };
    case "box-only-price": return { key: "grade_9_5_general", label: "Grade 9.5 (general)" };
    case "manual-only-price": return { key: "psa_10", label: "PSA 10" };
    case "bgs-10-price": return { key: "bgs_10", label: "BGS 10" };
    case "condition-17-price": return { key: "cgc_10", label: "CGC 10" };
    case "condition-18-price": return { key: "sgc_10", label: "SGC 10" };
    case "condition-19-price": return { key: "cgc_10_pristine", label: "CGC 10 Pristine" };
    case "condition-20-price": return { key: "bgs_10_black_label", label: "BGS 10 Black Label" };
    case "condition-21-price": return { key: "tag_10", label: "TAG 10" };
    case "condition-22-price": return { key: "ace_10", label: "ACE 10" };
    default: return { key: null, label: null };
  }
}

/**
 * Does the returned tier genuinely represent the requested designation?
 *
 * When PriceCharting exposes the DISTINCT designation column, that column IS the
 * exact tier: condition-19-price is the exact CGC 10 Pristine tier, and
 * condition-20-price is the exact BGS 10 Black Label tier. The ordinary grade-10
 * columns carry no sub-designation, so condition-17-price (CGC 10) is exact for a
 * plain or Gem-Mint request but only COMPATIBLE for a Pristine/Perfect slab — it
 * is never promoted to the distinct designation tier.
 */
function isDesignationExact(field: string | null, designation: ReturnType<typeof normalizeDesignation>): boolean {
  if (designation === null) return true; // no special designation requested
  if (designation === "pristine" && field === "condition-19-price") return true; // exact CGC 10 Pristine
  if (designation === "black_label" && field === "condition-20-price") return true; // exact BGS 10 Black Label
  if (designation === "gem_mint" && field === "condition-17-price") return true; // CGC 10 == Gem Mint 10
  return false; // an ordinary grade-10 column never represents a distinct designation
}

/**
 * Look up the value for a requested grade. Returns `value = null` (never a
 * substituted grade) when PriceCharting does not provide the requested grade's
 * field. Nearby available grade values are always attached for context.
 *
 * Required core function #11.
 */
export function getValueForRequestedGrade(
  product: Product,
  gradingCompany: GradingCompany | undefined,
  grade: number | null | undefined,
  opts: { category?: PriceCategory; enableEstimation?: boolean; designation?: string | null } = {},
): GradeLookupResult {
  const category = opts.category ?? inferPriceCategoryFromProduct(product);
  const nearby = buildAvailableValues(product, category);
  const designation = normalizeDesignation(opts.designation);
  const designationLabel = opts.designation?.trim() || null;
  // Defaults for the tier fields; overridden per branch.
  const noTier = { selected_tier_key: null, selected_tier_label: null, designation_requested: designationLabel, designation_exact: false };

  // Ungraded request → loose-price (the base ungraded value) for card/comic/coin.
  // NB: a null grade here is a REFERENCE lookup of the ungraded tier, not a
  // judgement about a slab. The "a graded slab is never valued as raw" invariant
  // lives in the valuation layer (deriveValuationProvenance), which knows it is
  // pricing a specific graded specimen rather than answering a reference query.
  if (grade === null || grade === undefined) {
    const field = "loose-price";
    const pennies = px(product, field);
    return {
      value_pennies: pennies,
      value_dollars: dollars(pennies),
      field_used: pennies === null ? null : field,
      field_meaning: "Ungraded",
      company_specific: false,
      is_estimate: false,
      selected_tier_key: pennies === null ? null : "ungraded",
      selected_tier_label: "Ungraded",
      designation_requested: designationLabel,
      designation_exact: designation === null,
      warnings: pennies === null ? ["No ungraded value is available from the connected PriceCharting source for this product (null, not $0)."] : [],
      nearby_values: nearby,
    };
  }

  let pick: FieldPick;
  if (category === "card") {
    pick = pickCardField(gradingCompany, grade);
    // Designation UPGRADE: when the product actually carries the DISTINCT
    // top-designation column (CGC 10 Pristine = condition-19-price, BGS 10 Black
    // Label = condition-20-price), select it as the EXACT tier instead of the
    // ordinary grade-10 column. Absent → keep the ordinary column as a clearly
    // labeled COMPATIBLE value; a designation value is never fabricated.
    const desigField = designationFieldFor(gradingCompany, grade, designation);
    if (desigField && px(product, desigField) !== null) {
      const t = fieldToCardTier(desigField);
      pick = { field: desigField, meaning: t.label, companySpecific: true, warnings: [] };
    }
  } else if (category === "comic") pick = pickComicField(grade);
  else {
    // Coin / generic: no documented grade→field mapping. Never guess.
    return {
      value_pennies: null,
      value_dollars: null,
      field_used: null,
      field_meaning: null,
      company_specific: false,
      is_estimate: false,
      ...noTier,
      warnings: [
        `No documented PriceCharting grade mapping exists for category "${category}". The exact-grade value is null; see nearby values for available fields.`,
      ],
      nearby_values: nearby,
    };
  }

  if (pick.field === null) {
    // Grade not directly supported. Optionally interpolate, clearly labeled.
    if (opts.enableEstimation) {
      const est = interpolateGrade(product, category, grade);
      if (est) {
        return {
          value_pennies: est.pennies,
          value_dollars: dollars(est.pennies),
          field_used: null,
          field_meaning: `Interpolated estimate for grade ${grade} (between ${est.lowerLabel} and ${est.upperLabel})`,
          company_specific: false,
          is_estimate: true,
          ...noTier, // an interpolated estimate is never an exact tier
          warnings: [
            `Grade ${grade} is not a direct PriceCharting field. This is an INTERPOLATED ESTIMATE, not an official PriceCharting value.`,
          ],
          nearby_values: nearby,
        };
      }
    }
    return {
      value_pennies: null,
      value_dollars: null,
      field_used: null,
      field_meaning: null,
      company_specific: false,
      is_estimate: false,
      ...noTier,
      warnings: [
        `PriceCharting does not provide a direct value for grade ${grade}${gradingCompany ? ` (${gradingCompany})` : ""}. Value is null; see nearby available grades.`,
        ...pick.warnings,
      ],
      nearby_values: nearby,
    };
  }

  const pennies = px(product, pick.field);
  const tier = fieldToCardTier(pick.field);
  const designationExact = isDesignationExact(pick.field, designation);
  const warnings = [...pick.warnings];
  if (pennies === null) {
    warnings.push(
      `The ${pick.meaning ?? pick.field} value is unavailable from the connected PriceCharting source for this product ` +
        `(null, not $0) — not substituted from another grade. This means unavailable from the connected source, not that no such value exists anywhere.`,
    );
  }
  // A Pristine/Perfect slab whose value came from the ordinary tier must be told
  // it is NOT the exact designation tier — never silently promoted to Pristine.
  if (!designationExact && designationLabel) {
    warnings.push(
      `PriceCharting's ${tier.label ?? "tier"} does not distinguish "${designationLabel}". This is the ordinary ${tier.label ?? "grade"} value — a COMPATIBLE tier for your ${designationLabel} slab, not an exact ${designationLabel} price.`,
    );
  }
  return {
    value_pennies: pennies,
    value_dollars: dollars(pennies),
    field_used: pennies === null ? null : pick.field,
    field_meaning: pick.meaning,
    company_specific: pick.companySpecific,
    is_estimate: false,
    selected_tier_key: pennies === null ? null : tier.key,
    selected_tier_label: tier.label,
    designation_requested: designationLabel,
    designation_exact: pennies === null ? false : designationExact,
    warnings,
    nearby_values: nearby,
  };
}

/**
 * Conservative linear interpolation between the nearest bracketing graded
 * values. Only used when the caller explicitly enables estimation. Returns null
 * if no bracketing pair of real values exists.
 */
function interpolateGrade(
  product: Product,
  category: PriceCategory,
  grade: number,
): { pennies: Pennies; lowerLabel: string; upperLabel: string } | null {
  // Ordered anchor points (grade -> field) for the category.
  const anchors: Array<{ grade: number; field: string; label: string }> =
    category === "card"
      ? [
          { grade: 7, field: "cib-price", label: "Grade 7" },
          { grade: 8, field: "new-price", label: "Grade 8" },
          { grade: 9, field: "graded-price", label: "Grade 9" },
          { grade: 9.5, field: "box-only-price", label: "Grade 9.5" },
          { grade: 10, field: "manual-only-price", label: "Grade 10 (PSA)" },
        ]
      : category === "comic"
        ? [
            { grade: 4, field: "cib-price", label: "4.0" },
            { grade: 6, field: "new-price", label: "6.0" },
            { grade: 8, field: "graded-price", label: "8.0" },
            { grade: 9.2, field: "box-only-price", label: "9.2" },
            { grade: 9.4, field: "condition-17-price", label: "9.4" },
            { grade: 9.8, field: "manual-only-price", label: "9.8" },
            { grade: 10, field: "bgs-10-price", label: "10.0" },
          ]
        : [];

  const withValues = anchors
    .map((a) => ({ ...a, pennies: px(product, a.field) }))
    .filter((a): a is typeof a & { pennies: Pennies } => a.pennies !== null);

  let lower: (typeof withValues)[number] | null = null;
  let upper: (typeof withValues)[number] | null = null;
  for (const a of withValues) {
    if (a.grade <= grade && (!lower || a.grade > lower.grade)) lower = a;
    if (a.grade >= grade && (!upper || a.grade < upper.grade)) upper = a;
  }
  if (!lower || !upper || lower.grade === upper.grade) return null;

  const ratio = (grade - lower.grade) / (upper.grade - lower.grade);
  const pennies = Math.round(lower.pennies + ratio * (upper.pennies - lower.pennies));
  return { pennies, lowerLabel: lower.label, upperLabel: upper.label };
}
