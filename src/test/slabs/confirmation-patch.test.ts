import { describe, it, expect } from "vitest";
import { buildConfirmationPatch, confirmationEventType } from "@/lib/slabs/confirmation-patch";
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

  it("user_rejected → NEVER stamps product_confirmed_at, records the rejection + actor", () => {
    const p = buildConfirmationPatch({ ...base, visual_confirmation_status: "user_rejected", visual_rejection_reason: "different artwork" }, NOW, ACTOR);
    expect(p.product_confirmed_at).toBeNull(); // the fix: rejected ≠ confirmed
    expect(p.visual_confirmation_status).toBe("user_rejected");
    expect(p.visual_rejection_reason).toBe("different artwork");
    expect(p.visual_confirmation_by).toBe(ACTOR);
    expect(confirmationEventType("user_rejected")).toBe("visual_rejected");
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
