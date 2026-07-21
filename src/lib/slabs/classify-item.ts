/**
 * Deterministic raw-card vs graded-slab classification from analyze-slab output.
 *
 * This is the "AI auto-detect" step: rather than a second model call, it reads
 * the grading-company signals the vision model already extracted. A graded slab
 * carries a grader, a numeric grade, and a certification number on its holder
 * label; a raw card has none of these. The result is a SUGGESTION the capture
 * flow shows with a user override — never an irreversible routing decision.
 */

import type { AnalyzeResult } from "@/server/analyze-slab/handler";

export type ItemType = "graded_slab" | "raw_card";

export interface ItemClassification {
  type: ItemType;
  /** 0..1 — how strongly the evidence supports the suggested type. */
  confidence: number;
  /** The grading signals that were readable (empty ⇒ looks like a raw card). */
  signals: string[];
}

/** Grading-company fields that only appear on a graded slab's holder label. */
const GRADED_SIGNAL_FIELDS = ["grader", "grade", "certification_number"] as const;
/** Card-identity fields that read on ANY card, graded or raw. */
const IDENTITY_FIELDS = ["card_name", "set", "card_number"] as const;

export function classifyScannedItem(analysis: AnalyzeResult): ItemClassification {
  const signals: string[] = [];
  let confidenceSum = 0;
  for (const key of GRADED_SIGNAL_FIELDS) {
    const field = analysis.proposed[key];
    if (field?.readable && field.value) {
      signals.push(key);
      confidenceSum += field.confidence;
    }
  }

  if (signals.length > 0) {
    // Some grading evidence — a graded slab. Stronger with more signals present
    // and higher per-field confidence.
    const coverage = signals.length / GRADED_SIGNAL_FIELDS.length;
    const avgConfidence = confidenceSum / signals.length;
    return {
      type: "graded_slab",
      confidence: Math.min(1, 0.5 + 0.5 * coverage * avgConfidence + 0.15 * (signals.length - 1)),
      signals,
    };
  }

  // No grading evidence at all. Whether that's a CONFIDENT raw card or an
  // uncertain read depends on whether the photo was otherwise legible: a clearly
  // readable card with no grading label is strong evidence of a raw card; a
  // photo where nothing read at all is genuinely undecidable → surfaced for the
  // operator to choose (via the route threshold).
  const identityReadable = IDENTITY_FIELDS.some((key) => {
    const field = analysis.proposed[key];
    return field?.readable && field.value;
  });
  return { type: "raw_card", confidence: identityReadable ? 0.85 : 0.4, signals };
}
