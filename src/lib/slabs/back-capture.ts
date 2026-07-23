/**
 * Decides how strongly to suggest a supplemental back photo for a graded slab.
 *
 * Product rule: the slab front is the primary identity and valuation surface for
 * PSA, CGC, and Beckett Pokemon slabs. A missing back image may justify a helpful
 * suggestion, but it must never block routing, analysis, certification lookup,
 * valuation, result display, or inventory creation.
 *
 * "required" remains in the exported union for backward compatibility with older
 * callers and persisted analytics, but this function never returns it and
 * canSkipBack always permits the operator to continue.
 */

import type { AnalyzeResult } from "@/server/analyze-slab/handler";

export type BackRequirement = "required" | "recommended" | "optional";

/** Below this overall confidence, a slab capture recommends supplemental evidence. */
export const BACK_CONFIDENCE_THRESHOLD = 0.7;

function readable(analysis: AnalyzeResult, key: keyof AnalyzeResult["proposed"]): boolean {
  const f = analysis.proposed[key];
  return !!(f?.readable && f.value);
}

export interface BackRequirementResult {
  requirement: BackRequirement;
  reason: string;
}

export function slabBackRequirement(
  analysis: AnalyzeResult,
  threshold: number = BACK_CONFIDENCE_THRESHOLD,
): BackRequirementResult {
  const certUnreadable = !readable(analysis, "certification_number");
  const disagreement = analysis.warnings.some((w) => /disagree|needs review|could not be verified|inconsistent/i.test(w));

  if (certUnreadable) {
    return {
      requirement: "recommended",
      reason:
        "The certification number was not readable on the front. Retake a sharper front-label photo or enter it manually; the back image remains optional supplemental evidence.",
    };
  }
  if (disagreement) {
    return {
      requirement: "recommended",
      reason:
        "The front analysis contains conflicting evidence. Review the front label or enter the correct value manually; adding the back is optional and cannot be required to continue.",
    };
  }
  if (analysis.overall_confidence < threshold || !readable(analysis, "grader")) {
    return {
      requirement: "recommended",
      reason:
        "The front read has lower confidence. Review or retake the front image; the back may add documentation but is not required.",
    };
  }
  return {
    requirement: "optional",
    reason: "The front captured the primary slab identity. The back is optional supplemental documentation.",
  };
}

/** A graded-slab workflow may always continue without a back image. */
export function canSkipBack(_requirement: BackRequirement): boolean {
  return true;
}
