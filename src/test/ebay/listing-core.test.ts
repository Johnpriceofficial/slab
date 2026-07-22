import { describe, it, expect } from "vitest";
import { orderedImagePaths, hasFrontImage, listingFingerprint, resolvePublishAction, extractOfferIds, resolveOfferCreation, extractOfferSummaries, resolveExistingOffers, canonicalSkuFromInventoryNumber, type ListingIntentState } from "../../../supabase/functions/_shared/ebay-listing-core";
import { canonicalMarketplaceSku } from "../../lib/slabs/marketplace-sku";
import { EBAY_MUTATION_FLAGS, mutationEnabled } from "../../../supabase/functions/_shared/ebay-mutation-flags";

describe("canonicalSkuFromInventoryNumber (server derivation matches the frontend)", () => {
  it("produces GCV000047 for #47, identical to the frontend helper", () => {
    for (const n of [1, 47, 48, 123456]) {
      expect(canonicalSkuFromInventoryNumber(n)).toBe(canonicalMarketplaceSku({ inventory_number: n }));
    }
    expect(canonicalSkuFromInventoryNumber(48)).toBe("GCV000048");
  });
});

describe("resolveExistingOffers (full content-validated adoption)", () => {
  const intended = { sku: "GCV000047", marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD", availableQuantity: 1 };
  // A summary that fully MATCHES `intended`.
  const match = (over: Record<string, unknown> = {}) => ({ offerId: "O1", sku: "GCV000047", marketplaceId: "EBAY_US", format: "FIXED_PRICE", listingId: null, categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: "199.99", currency: "USD", availableQuantity: 1, listingDescription: "", listingOnHold: false, ...over });

  it("extracts full summaries from getOffers (policies, price, quantity, on-hold)", () => {
    const s = extractOfferSummaries({ offers: [{ offerId: "O1", sku: "GCV000047", marketplaceId: "EBAY_US", format: "FIXED_PRICE", categoryId: "183454", merchantLocationKey: "LOC-A", listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" }, pricingSummary: { price: { value: "199.99", currency: "USD" } }, availableQuantity: 1, listing: { listingId: "L1", listingOnHold: true } }] });
    expect(s[0]).toMatchObject({ offerId: "O1", fulfillmentPolicyId: "F1", price: "199.99", availableQuantity: 1, listingId: "L1", listingOnHold: true });
  });
  it("creates when there is no COMPATIBLE offer (ignores wrong marketplace / auction)", () => {
    expect(resolveExistingOffers([], intended).action).toBe("create");
    expect(resolveExistingOffers([match({ marketplaceId: "EBAY_GB" })], intended).action).toBe("create");
    expect(resolveExistingOffers([match({ format: "AUCTION" })], intended).action).toBe("create");
  });
  it("adopts a single compatible offer whose settings MATCH intent", () => {
    expect(resolveExistingOffers([match()], intended)).toEqual({ action: "adopt", offerId: "O1" });
  });
  it("an unpublished compatible offer with CHANGED settings → existing_offer_inputs_changed (no silent adopt)", () => {
    expect(resolveExistingOffers([match({ price: "150.00" })], intended)).toEqual({ action: "existing_offer_inputs_changed", offerId: "O1" });
    expect(resolveExistingOffers([match({ fulfillmentPolicyId: "F-OTHER" })], intended).action).toBe("existing_offer_inputs_changed");
    expect(resolveExistingOffers([match({ availableQuantity: 5 })], intended).action).toBe("existing_offer_inputs_changed");
  });
  it("a published compatible offer that matches → reconcile; changed → existing_listing_inputs_changed", () => {
    expect(resolveExistingOffers([match({ listingId: "L9" })], intended)).toEqual({ action: "reconcile_published", offerId: "O1", listingId: "L9" });
    expect(resolveExistingOffers([match({ listingId: "L9", price: "150.00" })], intended)).toEqual({ action: "existing_listing_inputs_changed", offerId: "O1", listingId: "L9" });
  });
  it("an on-hold listing → listing_on_hold (never republished)", () => {
    expect(resolveExistingOffers([match({ listingOnHold: true })], intended)).toEqual({ action: "listing_on_hold", offerId: "O1" });
  });
  it("refuses when multiple compatible offers exist", () => {
    expect(resolveExistingOffers([match({ offerId: "A" }), match({ offerId: "B" })], intended)).toEqual({ action: "duplicate_offer_ambiguity", offerIds: ["A", "B"] });
  });
});

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
  const base = { sku: "GCV000047", title: "T", description: "D", price_value: 10, currency: "USD", category_id: "1", merchant_location_key: "L", fulfillment_policy_id: "F", payment_policy_id: "P", return_policy_id: "R", condition: "USED_VERY_GOOD", condition_description: "graded", quantity: 1, front_image_path: "slabs/47/front.jpg", back_image_path: "slabs/47/back.jpg", aspects: { Grade: "10", Grader: "PSA" } };
  it("is versioned and deterministic for identical inputs (aspect key order irrelevant)", () => {
    expect(listingFingerprint(base)).toMatch(/^v2\|/);
    expect(listingFingerprint(base)).toBe(listingFingerprint({ ...base, aspects: { Grader: "PSA", Grade: "10" } }));
  });
  it("changes when the front image, an aspect value, quantity, or condition descriptor changes", () => {
    // Swapping the front image while keeping ONE image must change the fingerprint.
    expect(listingFingerprint({ ...base, front_image_path: "slabs/47/front-v2.jpg" })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, aspects: { Grade: "9", Grader: "PSA" } })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, quantity: 2 })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, condition_description: "graded gem" })).not.toBe(listingFingerprint(base));
    expect(listingFingerprint({ ...base, price_value: 11 })).not.toBe(listingFingerprint(base));
  });
});

describe("extractOfferIds / resolveOfferCreation (provider-side idempotency)", () => {
  it("extracts offer ids from the getOffers response", () => {
    expect(extractOfferIds({ offers: [{ offerId: "1" }, { offerId: "2" }, {}] })).toEqual(["1", "2"]);
    expect(extractOfferIds({})).toEqual([]);
    expect(extractOfferIds(null)).toEqual([]);
  });
  it("creates ONLY when a successful lookup proves no offer exists", () => {
    expect(resolveOfferCreation({ ok: true, offerIds: [] })).toEqual({ action: "create" });
  });
  it("adopts the single existing offer instead of creating a duplicate", () => {
    expect(resolveOfferCreation({ ok: true, offerIds: ["O1"] })).toEqual({ action: "adopt", offerId: "O1" });
  });
  it("refuses when multiple offers exist (ambiguous)", () => {
    expect(resolveOfferCreation({ ok: true, offerIds: ["O1", "O2"] })).toEqual({ action: "duplicate_offer_ambiguity", offerIds: ["O1", "O2"] });
  });
  it("a lookup failure NEVER creates — it is provider_lookup_failed (retries stay safe)", () => {
    expect(resolveOfferCreation({ ok: false, offerIds: [] })).toEqual({ action: "provider_lookup_failed" });
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
