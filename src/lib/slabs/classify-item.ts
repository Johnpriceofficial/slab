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

  if (signals.length === 0) {
    // No grading evidence at all — looks like a raw card. Confidence scales with
    // how sure the model was that the fields it DID read are complete; absent a
    // better signal, a moderate default.
    return { type: "raw_card", confidence: 0.6, signals };
  }

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
