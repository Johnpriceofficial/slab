/**
 * Universal-scanner routing decision.
 *
 * Turns a classification into one of three outcomes the "Scan Item" flow acts on:
 *   - "slab"   → route the capture into the graded-slab intake (/slabs/new)
 *   - "raw"    → route the capture into the raw-card inventory
 *   - "choose" → the model couldn't decide confidently; ask the operator
 *                (Raw Card / Slab / Retake)
 *
 * Pure and deterministic so the decision is unit-tested independently of the UI.
 */

import type { ItemClassification } from "./classify-item";

export type IntakeRoute = "slab" | "raw" | "choose";

/** Below this confidence, the suggestion is offered for confirmation, not auto-taken. */
export const DEFAULT_ROUTE_CONFIDENCE = 0.75;

export function decideIntakeRoute(
  classification: ItemClassification,
  threshold: number = DEFAULT_ROUTE_CONFIDENCE,
): IntakeRoute {
  if (classification.confidence < threshold) return "choose";
  return classification.type === "graded_slab" ? "slab" : "raw";
}

/** Human-facing label for the detected type, used in the scanner overlay. */
export function routeLabel(route: IntakeRoute): string {
  switch (route) {
    case "slab":
      return "Graded slab detected";
    case "raw":
      return "Raw card detected";
    case "choose":
      return "Couldn't determine — choose the item type";
  }
}
