/**
 * Decides whether a back photo is needed for a graded-slab capture, from the
 * front analysis. Pure and deterministic so the front/back flow is testable
 * without a camera.
 *
 * "required"    — the front left a save-critical gap the back may resolve, or the
 *                 front/back reads disagree; the operator shouldn't skip.
 * "recommended" — some uncertainty the back would likely improve; skippable.
 * "optional"    — the front is sufficient.
 */

import type { AnalyzeResult } from "@/server/analyze-slab/handler";

export type BackRequirement = "required" | "recommended" | "optional";

/** Below this overall confidence, a slab capture recommends the back. */
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
  // A disagreement/needs-review warning means an independent read conflicted —
  // the back label is the tiebreaker.
  const disagreement = analysis.warnings.some((w) => /disagree|needs review|could not be verified|inconsistent/i.test(w));

  if (certUnreadable) {
    return { requirement: "required", reason: "The certification number wasn't readable on the front — it's often clearer on the back barcode." };
  }
  if (disagreement) {
    return { requirement: "required", reason: "Independent reads of the front disagreed — capture the back to reconcile." };
  }
  if (analysis.overall_confidence < threshold || !readable(analysis, "grader")) {
    return { requirement: "recommended", reason: "The front read with low confidence — the back may improve identification." };
  }
  return { requirement: "optional", reason: "The front captured everything needed. The back is optional." };
}

/** Whether the operator may skip the back given the requirement. */
export function canSkipBack(requirement: BackRequirement): boolean {
  return requirement !== "required";
}
