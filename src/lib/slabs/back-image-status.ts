/**
 * A saved slab's back-image gap.
 *
 * The back photo is OPTIONAL to SAVE a slab (see image-sufficiency.ts — a front
 * label that carries every required field is enough). But its ABSENCE is a real
 * verification gap that should be surfaced, not silently omitted: the back of the
 * label (cert barcode, grade designation) can't be cross-checked, and any
 * back-side condition/defect is unseen. This is pure display logic — it does not
 * change what counts as "verified" (that gating lives in verifiedBlockers and is
 * a separate product-policy decision).
 */
export interface BackImageStatus {
  present: boolean;
  /** Short label for a verification/evidence row. */
  label: string;
  /** Actionable note when the back image is missing (null when present). */
  note: string | null;
}

export function backImageStatus(backImagePath: string | null | undefined): BackImageStatus {
  const present = !!(backImagePath && backImagePath.trim());
  return {
    present,
    label: present ? "On file" : "Missing",
    note: present
      ? null
      : "No back image on file — add one to complete verification. The back label and any back-side condition can't be checked without it.",
  };
}
