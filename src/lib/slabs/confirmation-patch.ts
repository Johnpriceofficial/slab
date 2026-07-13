/**
 * Pure builder for the §4 confirmation patch written to a slab. Extracted so the
 * critical rule — a visually REJECTED product is never stamped as confirmed —
 * is unit-testable without Supabase.
 */

import type { Slab } from "./types";
import type { PricechartingConfirmation } from "./data";

export function buildConfirmationPatch(
  c: PricechartingConfirmation,
  now: string,
  actor: string | null,
): Partial<Slab> {
  const rejected = c.visual_confirmation_status === "user_rejected";
  const isUser = c.visual_confirmation_status === "user_confirmed" || rejected;
  return {
    candidate_image_url: c.candidate_image_url,
    candidate_image_source: c.candidate_image_source,
    candidate_image_type: c.candidate_image_type,
    candidate_image_retrieved_at: c.candidate_image_url ? now : null,
    candidate_image_available: c.candidate_image_available,
    visual_confirmation_status: c.visual_confirmation_status,
    visual_confirmation_method: isUser ? c.visual_confirmation_method : null,
    visual_confirmation_at: isUser ? now : null,
    visual_confirmation_by: isUser ? actor : null,
    visual_rejection_reason: rejected ? c.visual_rejection_reason : null,
    visual_rejection_note: rejected ? c.visual_rejection_note : null,
    product_confirmation_source: c.product_confirmation_source,
    // A rejected product is NOT a confirmed product — never stamp a confirmation.
    product_confirmed_at: c.product_id && !rejected ? now : null,
    scoring_version: c.scoring_version,
  };
}

/** The audit event type implied by the confirmation status. */
export function confirmationEventType(status: string): string {
  return status === "user_confirmed" ? "visual_confirmed" : status === "user_rejected" ? "visual_rejected" : "product_confirmed";
}

/**
 * Is a confirmation-write failure worth retrying? A constraint violation, an auth
 * failure, or a missing slab is deterministic and will fail again identically — no
 * point retrying. Anything else (network, timeout, transient) is retryable.
 */
export function isRetryableConfirmationError(message: string | null | undefined): boolean {
  return !/violates|not authorized|not found|check constraint|duplicate key|invalid input/i.test(message ?? "");
}
