import { describe, it, expect } from "vitest";
import { buildConfirmationPatch, confirmationEventType, isRetryableConfirmationError } from "@/lib/slabs/confirmation-patch";
import type { PricechartingConfirmation } from "@/lib/slabs/data";

const NOW = "2026-07-13T12:00:00.000Z";
const ACTOR = "user-123";

const base: PricechartingConfirmation = {
  product_id: "5427932",
  candidate_image_url: "https://storage.googleapis.com/x/240.jpg",
  candidate_image_source: "marketplace_offer",
  candidate_image_type: "marketplace_offer_image",
  candidate_image_available: true,
  visual_confirmation_status: "user_confirmed",
  visual_confirmation_method: "side_by_side",
  visual_rejection_reason: null,
  visual_rejection_note: null,
  product_confirmation_source: "search_manual",
  scoring_version: 2,
};

describe("§4 confirmation patch — a rejected product is never confirmed", () => {
  it("user_confirmed → product stamped confirmed, actor recorded", () => {
    const p = buildConfirmationPatch(base, NOW, ACTOR);
    expect(p.product_confirmed_at).toBe(NOW);
    expect(p.visual_confirmation_status).toBe("user_confirmed");
    expect(p.visual_confirmation_by).toBe(ACTOR);
    expect(p.visual_confirmation_at).toBe(NOW);
    expect(confirmationEventType("user_confirmed")).toBe("visual_confirmed");
  });

  it("user_rejected → NEVER stamps product_confirmed_at, records the structured reason + note + actor", () => {
    const p = buildConfirmationPatch(
      { ...base, visual_confirmation_status: "user_rejected", visual_rejection_reason: "wrong_character", visual_rejection_note: "different Pokémon" },
      NOW,
      ACTOR,
    );
    expect(p.product_confirmed_at).toBeNull(); // the fix: rejected ≠ confirmed
    expect(p.visual_confirmation_status).toBe("user_rejected");
    expect(p.visual_rejection_reason).toBe("wrong_character");
    expect(p.visual_rejection_note).toBe("different Pokémon");
    expect(p.visual_confirmation_by).toBe(ACTOR);
    expect(confirmationEventType("user_rejected")).toBe("visual_rejected");
  });

  it("confirmed → the rejection reason/note are cleared (a confirmation carries no rejection)", () => {
    const p = buildConfirmationPatch({ ...base, visual_rejection_reason: "wrong_set", visual_rejection_note: "stale" }, NOW, ACTOR);
    expect(p.visual_rejection_reason).toBeNull();
    expect(p.visual_rejection_note).toBeNull();
  });

  it("metadata_auto_confirmed → stamped confirmed, but NOT a user visual review", () => {
    const p = buildConfirmationPatch({ ...base, visual_confirmation_status: "metadata_auto_confirmed", candidate_image_url: null, candidate_image_available: false }, NOW, ACTOR);
    expect(p.product_confirmed_at).toBe(NOW);
    expect(p.visual_confirmation_status).toBe("metadata_auto_confirmed");
    expect(p.visual_confirmation_by).toBeNull(); // never attributed to a user review
    expect(p.visual_confirmation_at).toBeNull();
    expect(confirmationEventType("metadata_auto_confirmed")).toBe("product_confirmed");
  });
});

describe("§2 confirmation-write error classification", () => {
  it("treats deterministic failures (constraint / auth / not-found) as NON-retryable", () => {
    expect(isRetryableConfirmationError("new row violates check constraint")).toBe(false);
    expect(isRetryableConfirmationError("not authorized to record a PriceCharting confirmation")).toBe(false);
    expect(isRetryableConfirmationError("slab abc not found")).toBe(false);
    expect(isRetryableConfirmationError("duplicate key value")).toBe(false);
  });
  it("treats transient failures (network / timeout) as retryable", () => {
    expect(isRetryableConfirmationError("Failed to fetch")).toBe(true);
    expect(isRetryableConfirmationError("network error")).toBe(true);
    expect(isRetryableConfirmationError(null)).toBe(true);
  });
});
