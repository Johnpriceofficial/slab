import { describe, it, expect } from "vitest";
import { orderedImagePaths, hasFrontImage, listingFingerprint, resolvePublishAction, type ListingIntentState } from "../../../supabase/functions/_shared/ebay-listing-core";
import { EBAY_MUTATION_FLAGS, mutationEnabled } from "../../../supabase/functions/_shared/ebay-mutation-flags";

describe("orderedImagePaths", () => {
  it("returns front then back, dropping empties", () => {
    expect(orderedImagePaths("front.jpg", "back.jpg")).toEqual(["front.jpg", "back.jpg"]);
    expect(orderedImagePaths("front.jpg", null)).toEqual(["front.jpg"]);
    expect(orderedImagePaths("front.jpg", "  ")).toEqual(["front.jpg"]);
    expect(orderedImagePaths("", "back.jpg")).toEqual(["back.jpg"]); // front missing → only back
  });
  it("returns [] when there are no images", () => {
    expect(orderedImagePaths(null, null)).toEqual([]);
    expect(orderedImagePaths("", "")).toEqual([]);
  });
});

describe("hasFrontImage", () => {
  it("is the pre-publish front-image gate", () => {
    expect(hasFrontImage("f.jpg")).toBe(true);
    expect(hasFrontImage("")).toBe(false);
    expect(hasFrontImage("   ")).toBe(false);
    expect(hasFrontImage(null)).toBe(false);
    expect(hasFrontImage(undefined)).toBe(false);
  });
});

describe("listingFingerprint", () => {
  const base = { sku: "GCV000047", title: "T", description: "D", price_value: 10, currency: "USD", category_id: "1", merchant_location_key: "L", fulfillment_policy_id: "F", payment_policy_id: "P", return_policy_id: "R", condition: "GRADED", image_count: 2 };
  it("is deterministic for identical inputs", () => {
    expect(listingFingerprint(base)).toBe(listingFingerprint({ ...base }));
  });
  it("changes when any listing input changes", () => {
    expect(listingFingerprint({ ...base, price_value: 11 })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, title: "T2" })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, image_count: 1 })).not.toBe(listingFingerprint(base));
  });
});

describe("resolvePublishAction (fingerprint enforcement)", () => {
  const fp = "FP-CURRENT";
  const intent = (over: Partial<ListingIntentState>): ListingIntentState => ({ status: "preparing", offer_id: null, listing_id: null, fingerprint: fp, ...over });

  it("no existing intent → proceed", () => {
    expect(resolvePublishAction(null, fp)).toEqual({ action: "proceed" });
  });
  it("published + identical inputs → reconciled (return existing, no re-publish)", () => {
    expect(resolvePublishAction(intent({ status: "published", offer_id: "O1", listing_id: "L1" }), fp).action).toBe("reconciled_existing");
  });
  it("published + CHANGED inputs → listing_inputs_changed (never silent re-publish)", () => {
    expect(resolvePublishAction(intent({ status: "published", offer_id: "O1", listing_id: "L1", fingerprint: "OLD" }), fp).action).toBe("listing_inputs_changed");
  });
  it("in-flight offer + identical inputs → resume that offer (no duplicate)", () => {
    expect(resolvePublishAction(intent({ status: "offer_created", offer_id: "O9", fingerprint: fp }), fp)).toEqual({ action: "resume", offerId: "O9" });
  });
  it("in-flight offer + CHANGED inputs → listing_inputs_changed (no stale reuse)", () => {
    expect(resolvePublishAction(intent({ status: "offer_created", offer_id: "O9", fingerprint: "OLD" }), fp).action).toBe("listing_inputs_changed");
  });
  it("unpersisted prior offer → must reconcile before another publish", () => {
    expect(resolvePublishAction(intent({ status: "offer_created_unpersisted", fingerprint: "OLD" }), fp).action).toBe("offer_created_unpersisted");
  });
  it("preparing intent with no offer yet → proceed", () => {
    expect(resolvePublishAction(intent({ status: "preparing", offer_id: null }), fp).action).toBe("proceed");
  });
});

describe("mutationEnabled (kill switches)", () => {
  it("names all four mutation flags", () => {
    expect(EBAY_MUTATION_FLAGS).toEqual({
      listing: "EBAY_LISTING_MUTATIONS_ENABLED",
      fulfillment: "EBAY_FULFILLMENT_MUTATIONS_ENABLED",
      financial: "EBAY_FINANCIAL_MUTATIONS_ENABLED",
      applySales: "EBAY_APPLY_SALES_ENABLED",
    });
  });

  it("defaults OFF: only the exact value \"true\" enables a mutation", () => {
    expect(mutationEnabled(undefined)).toBe(false); // unset → off
    expect(mutationEnabled(null)).toBe(false);
    expect(mutationEnabled("")).toBe(false);
    expect(mutationEnabled("false")).toBe(false);
    expect(mutationEnabled("1")).toBe(false);
    expect(mutationEnabled("yes")).toBe(false);
    expect(mutationEnabled("true")).toBe(true);
    expect(mutationEnabled(" TRUE ")).toBe(true); // trimmed + case-insensitive
  });

  it("takes ONLY the flag value — no confirmation phrase is a parameter, so a phrase cannot bypass a disabled flag", () => {
    // The function's sole input is the env value; there is no argument a request
    // body / confirmation phrase could supply to flip a disabled flag on.
    expect(mutationEnabled.length).toBe(1);
    expect(mutationEnabled("false")).toBe(false);
  });
});
