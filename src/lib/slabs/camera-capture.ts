/**
 * Hand-off buffer for a universal-scanner capture on its way to an intake screen.
 *
 * The scanner captures once, analyzes once, and classifies the item. For a
 * graded slab it stages the captured front image AND the analysis here, then
 * navigates to /slabs/new — which consumes both on mount, so the photo lands in
 * the Front slot and the AI proposal is shown WITHOUT a second analysis call.
 *
 * Because both live in the same SPA bundle, a client-side navigate() preserves
 * this module's state — nothing is serialized, no query-string payload, no
 * duplicate upload. The staged image is the very same SlabImageState a manual
 * upload produces, so exactly one slab and one set of images are written on save.
 *
 * The buffer holds at most one capture. Staging a second releases the first
 * (an operator who re-scans before reaching the form must not leak its preview
 * URL), and consuming clears the slot so a later visit starts empty.
 */

import { releaseSlabImageState, type SlabImageState } from "./image-state";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";

export interface StagedCapture {
  image: SlabImageState;
  /** Optional back image captured during front/back intake. */
  back: SlabImageState | null;
  /** The analysis computed at capture time, so the intake screen needn't re-run it. */
  analysis: AnalyzeResult | null;
}

let staged: StagedCapture | null = null;

/** Stage a capture (front, optional back, optional analysis) for the next mount. */
export function stageCameraCapture(
  image: SlabImageState,
  back: SlabImageState | null = null,
  analysis: AnalyzeResult | null = null,
): void {
  if (staged) {
    if (staged.image !== image) releaseSlabImageState(staged.image);
    if (staged.back && staged.back !== back) releaseSlabImageState(staged.back);
  }
  staged = { image, back, analysis };
}

/**
 * Return the staged capture and clear the slot, so it hydrates the form exactly
 * once. Ownership of the preview URL transfers to the caller.
 */
export function consumeCameraCapture(): StagedCapture | null {
  const value = staged;
  staged = null;
  return value;
}

/** Read the staged capture without consuming it (tests/diagnostics). */
export function peekCameraCapture(): StagedCapture | null {
  return staged;
}

/** Discard a staged capture that will never be consumed, releasing its URLs. */
export function clearCameraCapture(): void {
  if (staged) {
    releaseSlabImageState(staged.image);
    releaseSlabImageState(staged.back);
  }
  staged = null;
}
