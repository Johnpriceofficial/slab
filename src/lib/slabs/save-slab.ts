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
 *
 * Front image is required (it's what identity/valuation is built from). Back
 * image is OPTIONAL — some slabs (promos, certain label layouts) carry every
 * field needed for identification and valuation on the front label alone, and
 * requiring a back photo in that case is pure friction with no data benefit.
 */

import type { Slab, SlabInput } from "./types";
import type { SlabPricingWrite } from "./pricing-tiers";
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
  /**
   * Atomic RPC: assigns the next number + inserts, or errors (e.g. duplicate).
   * `backExt` is null when no back image was provided — the row is created
   * with a null back_image_path and no back upload is attempted.
   */
  createSlabRow(
    input: SlabInput,
    frontExt: string,
    backExt: string | null,
  ): Promise<{ data: Slab | null; error: SlabDataError | null }>;
  uploadImage(path: string, blob: Blob): Promise<{ error: SlabDataError | null }>;
  deleteImages(paths: string[]): Promise<void>;
  deleteSlabRow(id: string): Promise<void>;
  /**
   * Persist the confirmed PriceCharting tier table (stale-write guarded in the
   * DB). The slab remains valid if this enrichment fails, but the failure is
   * returned as a structured retryable warning and must not be hidden.
   * Resolves to whether the write was applied (false when stale-rejected).
   */
  applySlabPricing?(slabId: string, pricing: SlabPricingWrite): Promise<boolean>;
}

export type SaveSlabResult =
  | { status: "success"; slab: Slab; warnings: SaveWarning[] }
  | { status: "duplicate"; existing_inventory_number: number }
  | { status: "validation_error"; errors: string[] }
  | { status: "error"; message: string; slab_id?: string; warnings: SaveWarning[] };

export type SaveWarningCode =
  | "pricing_persistence_failed"
  | "pricing_stale"
  | "image_cleanup_failed"
  | "row_cleanup_failed";

export interface SaveWarning {
  code: SaveWarningCode;
  message: string;
  retryable: boolean;
  orphaned_paths?: string[];
}

export type RequiredConfirmationResult =
  | { status: "success"; attempts: number }
  | { status: "error"; attempts: number; message: string; retryable: boolean };

/** Retry a required confirmation/audit write without losing the created slab id. */
export async function persistRequiredConfirmation<T>(
  slabId: string,
  payload: T,
  writer: (id: string, value: T) => Promise<{ status: "success" } | { status: "error"; message: string; retryable: boolean }>,
  maxRetries = 2,
): Promise<RequiredConfirmationResult> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await writer(slabId, payload);
    if (result.status === "success") return { status: "success", attempts };
    if (!result.retryable || attempts > maxRetries) {
      return { status: "error", attempts, message: result.message, retryable: result.retryable };
    }
  }
}

/**
 * Two save modes:
 *  - "draft":    an unverified draft. Only the front image is required; the cert,
 *                grader, grade, and PriceCharting confirmation MAY be unresolved.
 *                Its unresolved requirements are stored (verification_status) and
 *                displayed so it can be completed later.
 *  - "verified": a verified record. Requires grader, grade, certification number,
 *                and the front image, with all blockers resolved.
 */
export type SaveMode = "draft" | "verified";

/**
 * The identity fields a VERIFIED record requires, as short field names. Returned
 * empty when a record is ready to verify. Shared by the save flow, the intake
 * disabled-reason UI, and the detail page's "to verify" list so all three agree.
 */
export function verifiedBlockers(
  input: {
    card_name?: string | null;
    grader?: string | null;
    grade?: string | number | null;
    certification_number?: string | null;
  },
  hasFront: boolean,
): string[] {
  const b: string[] = [];
  if (!input.card_name || !input.card_name.trim()) b.push("Card name");
  if (!input.grader || !String(input.grader).trim()) b.push("Grader");
  if (!input.grade || !String(input.grade).trim()) b.push("Grade");
  if (!input.certification_number || !String(input.certification_number).trim()) b.push("Certification number");
  if (!hasFront) b.push("Front image");
  return b;
}

/**
 * Required-field validation shared by the form and the save flow. The front image
 * is ALWAYS required (see module doc); the remaining fields are required only for
 * a "verified" save. The back image is always optional.
 */
export function validateSlabInput(
  input: SlabInput,
  hasFront: boolean,
  _hasBack: boolean,
  mode: SaveMode = "verified",
): string[] {
  const errors: string[] = [];
  if (!hasFront) errors.push("Front image is required.");
  if (mode === "verified") {
    if (!input.card_name || !input.card_name.trim()) errors.push("Card name is required.");
    if (!input.grader || !input.grader.trim()) errors.push("Grader is required.");
    if (!input.grade || !String(input.grade).trim()) errors.push("Grade is required.");
    if (!input.certification_number || !input.certification_number.trim()) {
      errors.push("Certification number is required.");
    }
  }
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
  pricing?: SlabPricingWrite | null,
  mode: SaveMode = "verified",
): Promise<SaveSlabResult> {
  const errors = validateSlabInput(input, !!front, !!back, mode);
  if (errors.length > 0) return { status: "validation_error", errors };

  // Validate image extensions client-side too (the DB's valid_image_ext is the
  // authority; this gives a fast, clear error and normalizes the stored path).
  const frontExt = normalizeImageExt(front!.ext);
  if (!frontExt) {
    return { status: "validation_error", errors: ["Unsupported image type. Use JPG, JPEG, PNG, WEBP, HEIC, or HEIF."] };
  }
  let backExt: string | null = null;
  if (back) {
    backExt = normalizeImageExt(back.ext);
    if (!backExt) {
      return { status: "validation_error", errors: ["Unsupported image type. Use JPG, JPEG, PNG, WEBP, HEIC, or HEIF."] };
    }
  }

  // 1. Atomic: assign next inventory number + insert the row (server-side dup
  //    recheck happens here). No images have been uploaded yet, so an insert
  //    failure leaves nothing to clean up.
  const { data: slab, error } = await dao.createSlabRow(input, frontExt, backExt);
  if (error) {
    if (error.code === "DUPLICATE_CERTIFICATION") {
      return { status: "duplicate", existing_inventory_number: error.existing_inventory_number ?? -1 };
    }
    return { status: "error", message: error.message, warnings: [] };
  }
  if (!slab) return { status: "error", message: "Slab row was not returned by the database.", warnings: [] };

  const frontPath = slab.front_image_path;
  const backPath = slab.back_image_path;
  if (!frontPath) {
    const warnings = await safeCleanup(dao, slab.id, []);
    return { status: "error", message: "Database did not return the front image path.", slab_id: slab.id, warnings };
  }
  if (back && !backPath) {
    const warnings = await safeCleanup(dao, slab.id, [frontPath]);
    return { status: "error", message: "Database did not return the back image path.", slab_id: slab.id, warnings };
  }

  // 2. Upload the front image (always) and the back image (only if provided).
  const frontUp = await dao.uploadImage(frontPath, front!.blob);
  if (frontUp.error) {
    const warnings = await safeCleanup(dao, slab.id, [frontPath]);
    return { status: "error", message: `Front image upload failed: ${frontUp.error.message}`, slab_id: slab.id, warnings };
  }
  if (back && backPath) {
    const backUp = await dao.uploadImage(backPath, back.blob);
    if (backUp.error) {
      const warnings = await safeCleanup(dao, slab.id, [frontPath, backPath]);
      return { status: "error", message: `Back image upload failed: ${backUp.error.message}`, slab_id: slab.id, warnings };
    }
  }

  // 3. Persist the confirmed PriceCharting tier table. A failure does not destroy
  //    the valid slab, but is returned explicitly so the UI can keep recovery.
  const warnings: SaveWarning[] = [];
  if (pricing && dao.applySlabPricing) {
    try {
      const applied = await dao.applySlabPricing(slab.id, pricing);
      if (!applied) {
        warnings.push({
          code: "pricing_stale",
          message: "Pricing enrichment was not applied because a newer pricing write already exists.",
          retryable: true,
        });
      }
    } catch (error) {
      warnings.push({
        code: "pricing_persistence_failed",
        message: error instanceof Error ? error.message : "Pricing enrichment failed.",
        retryable: true,
      });
    }
  }

  return { status: "success", slab, warnings };
}

/** Compensating cleanup with explicit orphan warnings; never throws. */
async function safeCleanup(dao: SlabDataAccess, slabId: string, paths: string[]): Promise<SaveWarning[]> {
  const warnings: SaveWarning[] = [];
  try {
    if (paths.length > 0) await dao.deleteImages(paths);
  } catch (error) {
    warnings.push({
      code: "image_cleanup_failed",
      message: error instanceof Error ? error.message : "Image cleanup failed.",
      retryable: true,
      orphaned_paths: [...paths],
    });
  }
  try {
    await dao.deleteSlabRow(slabId);
  } catch (error) {
    warnings.push({
      code: "row_cleanup_failed",
      message: error instanceof Error ? error.message : "Slab-row cleanup failed.",
      retryable: true,
    });
  }
  return warnings;
}
