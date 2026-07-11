/**
 * Pure dashboard-statistics computation. Every figure derives from stored slab
 * values in integer cents. Used by both /dashboard and the Excel Summary sheet
 * so the two can never disagree.
 */

import type { DashboardStats, Slab } from "./types";
import {
  DUPLICATE_ATTEMPT_VALUES,
  LABEL_ERROR_VERIFICATION_VALUE,
  NEEDS_CLEARER_IMAGES_VALUE,
  POSSIBLE_LABEL_ERROR_ACCURACY_VALUE,
} from "./constants";

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Integer median of a list of cents (average of the two middle values). */
function medianCents(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function bump(map: Record<string, number>, key: string | null | undefined): void {
  const k = key && key.trim() ? key : "(unspecified)";
  map[k] = (map[k] ?? 0) + 1;
}

export function computeDashboardStats(slabs: Slab[]): DashboardStats {
  const finalValues = slabs.map((s) => s.final_value_cents).filter((v): v is number => v !== null && v !== undefined);

  const totalFinal = sum(finalValues);
  const totalQuick = sum(slabs.map((s) => s.quick_sale_value_cents ?? 0));
  const totalReplacement = sum(slabs.map((s) => s.replacement_value_cents ?? 0));

  const byGrader: Record<string, number> = {};
  const byGrade: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};

  let needsClearer = 0;
  let possibleLabelErrors = 0;
  let duplicateAttempts = 0;
  let highest: DashboardStats["highest_value_slab"] = null;

  for (const s of slabs) {
    bump(byGrader, s.grader);
    bump(byGrade, s.grade);
    bump(byLanguage, s.language);
    bump(byConfidence, s.valuation_confidence);

    if (s.verification_status === NEEDS_CLEARER_IMAGES_VALUE) needsClearer += 1;
    if (
      s.verification_status === LABEL_ERROR_VERIFICATION_VALUE ||
      s.label_accuracy === POSSIBLE_LABEL_ERROR_ACCURACY_VALUE
    ) {
      possibleLabelErrors += 1;
    }
    if (s.duplicate_status && DUPLICATE_ATTEMPT_VALUES.includes(s.duplicate_status)) duplicateAttempts += 1;

    const fv = s.final_value_cents;
    if (fv !== null && fv !== undefined && (!highest || fv > highest.final_value_cents)) {
      highest = { inventory_number: s.inventory_number, card_name: s.card_name, final_value_cents: fv };
    }
  }

  return {
    total_slabs: slabs.length,
    total_final_value_cents: totalFinal,
    total_quick_sale_value_cents: totalQuick,
    total_replacement_value_cents: totalReplacement,
    average_value_cents: finalValues.length ? Math.round(totalFinal / finalValues.length) : null,
    median_value_cents: medianCents(finalValues),
    highest_value_slab: highest,
    count_by_grader: byGrader,
    count_by_grade: byGrade,
    count_by_language: byLanguage,
    count_by_confidence: byConfidence,
    count_needs_clearer_images: needsClearer,
    count_possible_label_errors: possibleLabelErrors,
    count_duplicate_attempts: duplicateAttempts,
  };
}

/** Price variance % between a chosen final value and the PriceCharting guide. */
export function priceVariancePercent(finalCents: number | null, guideCents: number | null): number | null {
  if (finalCents === null || guideCents === null || guideCents === 0) return null;
  return Math.round(((finalCents - guideCents) / guideCents) * 10000) / 100;
}
