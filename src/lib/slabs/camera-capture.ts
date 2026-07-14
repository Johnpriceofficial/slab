/**
 * Hand-off buffer for a camera capture on its way to the Add a Slab screen.
 *
 * `CardScanner` stages the captured front image here, stops the camera, and
 * navigates to /slabs/new; `NewSlab` consumes it once on mount and drops it
 * into the Front image slot. Because both live in the same SPA bundle, a
 * client-side `navigate()` preserves this module's state — the image never has
 * to be serialized.
 *
 * Deliberately NOT a query-string base64 payload and NOT a second upload:
 *   - a base64 data URL of a 1800px JPEG blows past practical URL limits and
 *     would be re-decoded on arrival, and
 *   - re-uploading the capture would create a second stored object (and, in the
 *     old scan flow, a separate /cards inventory row) for one physical slab.
 * The staged value is the very same `SlabImageState` — the same File objects and
 * the same preview object URL — that a manual upload produces, so exactly one
 * slab and one set of images are written on save.
 *
 * The buffer holds at most one capture. Staging a second one releases the first
 * (an operator who re-scans before reaching the form must not leak its preview
 * URL), and consuming clears the slot so a later visit to /slabs/new starts
 * empty instead of re-hydrating a stale photo.
 */

import { releaseSlabImageState, type SlabImageState } from "./image-state";

let staged: SlabImageState | null = null;

/** Stages the capture for the next /slabs/new mount, replacing any prior one. */
export function stageCameraCapture(image: SlabImageState): void {
  if (staged && staged !== image) releaseSlabImageState(staged);
  staged = image;
}

/**
 * Returns the staged capture and clears the slot, so it hydrates the form
 * exactly once. Ownership of the preview URL transfers to the caller.
 */
export function consumeCameraCapture(): SlabImageState | null {
  const image = staged;
  staged = null;
  return image;
}

/** Reads the staged capture without consuming it (tests/diagnostics). */
export function peekCameraCapture(): SlabImageState | null {
  return staged;
}

/** Discards a staged capture that will never be consumed, releasing its URL. */
export function clearCameraCapture(): void {
  releaseSlabImageState(staged);
  staged = null;
}
