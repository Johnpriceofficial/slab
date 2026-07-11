/**
 * Slab save flow — the reliability-critical path, written against a
 * `SlabDataAccess` interface so it is fully unit-testable without Supabase.
 *
 * Guarantees:
 *  - Sequential, race-safe inventory numbers come from the DB (create_slab RPC),
 *    never from browser state.
 *  - Duplicate certification numbers are rejected server-side (atomic) — two
 *    rows with the same certification can never exist.
 *  - The row is created atomically WITH its number and deterministic image
 *    paths, THEN images are uploaded. If any upload fails, the row and any
 *    uploaded object are removed (compensating cleanup) so no incomplete
 *    inventory record persists.
 */

import type { Slab, SlabInput } from "./types";
import { normalizeImageExt } from "./constants";

export interface SlabImageUpload {
  blob: Blob;
  ext: string;
}

export interface SlabDataError {
  code?: string;
  message: string;
  /** Present when code === "DUPLICATE_CERTIFICATION". */
  existing_inventory_number?: number;
}

export interface SlabDataAccess {
  /**
   * Live duplicate lookup for the intake UI. Grader-scoped: a certification
   * number is only a duplicate within the SAME grading company.
   */
  checkCertification(
    grader: string | null | undefined,
    cert: string,
  ): Promise<{ id: string; inventory_number: number } | null>;
  /** Atomic RPC: assigns the next number + inserts, or errors (e.g. duplicate). */
  createSlabRow(
    input: SlabInput,
    frontExt: string,
    backExt: string,
  ): Promise<{ data: Slab | null; error: SlabDataError | null }>;
  uploadImage(path: string, blob: Blob): Promise<{ error: SlabDataError | null }>;
  deleteImages(paths: string[]): Promise<void>;
  deleteSlabRow(id: string): Promise<void>;
}

export type SaveSlabResult =
  | { status: "success"; slab: Slab }
  | { status: "duplicate"; existing_inventory_number: number }
  | { status: "validation_error"; errors: string[] }
  | { status: "error"; message: string };

/** Required-field validation shared by the form and the save flow. */
export function validateSlabInput(input: SlabInput, hasFront: boolean, hasBack: boolean): string[] {
  const errors: string[] = [];
  if (!input.card_name || !input.card_name.trim()) errors.push("Card name is required.");
  if (!input.grader || !input.grader.trim()) errors.push("Grader is required.");
  if (!input.grade || !String(input.grade).trim()) errors.push("Grade is required.");
  if (!input.certification_number || !input.certification_number.trim()) {
    errors.push("Certification number is required.");
  }
  if (!hasFront) errors.push("Front image is required.");
  if (!hasBack) errors.push("Back image is required.");
  return errors;
}

/**
 * Persist one slab. `acknowledgedDuplicate` has no effect on the DB guarantee —
 * a genuine duplicate certification is always rejected — it only exists so the
 * UI can distinguish an intentional retry from a first attempt.
 */
export async function saveSlab(
  input: SlabInput,
  front: SlabImageUpload | null,
  back: SlabImageUpload | null,
  dao: SlabDataAccess,
): Promise<SaveSlabResult> {
  const errors = validateSlabInput(input, !!front, !!back);
  if (errors.length > 0) return { status: "validation_error", errors };

  // Validate image extensions client-side too (the DB's valid_image_ext is the
  // authority; this gives a fast, clear error and normalizes the stored path).
  const frontExt = normalizeImageExt(front!.ext);
  const backExt = normalizeImageExt(back!.ext);
  if (!frontExt || !backExt) {
    return { status: "validation_error", errors: ["Unsupported image type. Use JPG, JPEG, PNG, WEBP, HEIC, or HEIF."] };
  }

  // 1. Atomic: assign next inventory number + insert the row (server-side dup
  //    recheck happens here). No images have been uploaded yet, so an insert
  //    failure leaves nothing to clean up.
  const { data: slab, error } = await dao.createSlabRow(input, frontExt, backExt);
  if (error) {
    if (error.code === "DUPLICATE_CERTIFICATION") {
      return { status: "duplicate", existing_inventory_number: error.existing_inventory_number ?? -1 };
    }
    return { status: "error", message: error.message };
  }
  if (!slab) return { status: "error", message: "Slab row was not returned by the database." };

  const frontPath = slab.front_image_path;
  const backPath = slab.back_image_path;
  if (!frontPath || !backPath) {
    await safeCleanup(dao, slab.id, []);
    return { status: "error", message: "Database did not return image paths." };
  }

  // 2. Upload both images to the deterministic, number-based paths.
  const frontUp = await dao.uploadImage(frontPath, front!.blob);
  if (frontUp.error) {
    await safeCleanup(dao, slab.id, [frontPath]);
    return { status: "error", message: `Front image upload failed: ${frontUp.error.message}` };
  }
  const backUp = await dao.uploadImage(backPath, back!.blob);
  if (backUp.error) {
    await safeCleanup(dao, slab.id, [frontPath, backPath]);
    return { status: "error", message: `Back image upload failed: ${backUp.error.message}` };
  }

  return { status: "success", slab };
}

/** Best-effort compensating cleanup; never throws. */
async function safeCleanup(dao: SlabDataAccess, slabId: string, paths: string[]): Promise<void> {
  try {
    if (paths.length > 0) await dao.deleteImages(paths);
  } catch {
    /* ignore — cleanup is best-effort */
  }
  try {
    await dao.deleteSlabRow(slabId);
  } catch {
    /* ignore — cleanup is best-effort */
  }
}
