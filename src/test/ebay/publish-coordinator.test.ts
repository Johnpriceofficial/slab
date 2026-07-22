import { describe, it, expect, vi } from "vitest";
import { planPublish, compareInventoryItem, type IntendedListing, type PublishOps } from "../../../supabase/functions/_shared/ebay-publish-coordinator";
import { fetchInventoryItemForSku, type InventoryFetchImpl } from "../../../supabase/functions/_shared/ebay-inventory-item";
import type { OffersDiscovery } from "../../../supabase/functions/_shared/ebay-offers";
import type { OfferSummary } from "../../../supabase/functions/_shared/ebay-listing-core";
import type { NormalizedInventoryItem, InventoryItemResult } from "../../../supabase/functions/_shared/ebay-inventory-item";

const SKU = "GCV000047";
const intended: IntendedListing = {
  sku: SKU, marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD", availableQuantity: 1,
  title: "2016 XY Evolutions Charizard 11 PSA Gem Mt 10", description: "Graded card.",
  condition: "LIKE_NEW", conditionDescription: "Graded", conditionDescriptors: [], aspects: { Grade: "10" }, imageCount: 2, fingerprint: "fp",
};
// An offer that fully MATCHES intended (compatibility + content).
const matchingOffer = (over: Partial<OfferSummary> = {}): OfferSummary => ({
  offerId: "O1", sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE", listingId: null,
  categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1",
  price: "199.99", currency: "USD", availableQuantity: 1, listingDescription: "Graded card.", listingOnHold: false, ...over,
});
const matchingItem = (over: Partial<NormalizedInventoryItem> = {}): NormalizedInventoryItem => ({
  sku: SKU, condition: "LIKE_NEW", conditionDescription: "Graded", conditionDescriptors: [],
  title: intended.title, description: "Graded card.", aspects: { Grade: "10" }, imageCount: 2, quantity: 1, ...over,
});

// ops with call-tracking so we can PROVE reads/mutations are skipped.
function ops(disc: OffersDiscovery, inv?: InventoryItemResult): PublishOps & { discCalls: () => number; invCalls: () => number } {
  const discoverOffers = vi.fn(async () => disc);
  const fetchInventoryItem = vi.fn(async () => inv ?? { ok: true, present: false } as InventoryItemResult);
  return { discoverOffers, fetchInventoryItem, discCalls: () => discoverOffers.mock.calls.length, invCalls: () => fetchInventoryItem.mock.calls.length };
}
const okDisc = (offers: OfferSummary[]): OffersDiscovery => ({ ok: true, offers, pagesFetched: 1, providerTotal: offers.length, providerSize: offers.length, deduplicatedCount: 0 });

describe("planPublish — never plans a mutation after a failed read", () => {
  for (const code of ["provider_lookup_failed", "invalid_provider_response", "provider_redirect_rejected", "pagination_loop", "pagination_limit_exceeded", "incomplete_provider_result", "inconsistent_provider_pagination", "unsafe_pagination_url", "invalid_api_origin"]) {
    it(`discovery ${code} → block, and the inventory item is NOT fetched`, async () => {
      const o = ops({ ok: false, errorCode: code, httpStatus: null, safeProviderErrorId: null, pagesFetched: 0 });
      const plan = await planPublish(o, intended, null);
      expect(plan).toEqual({ action: "block", errorCode: code });
      expect(o.invCalls()).toBe(0); // no second read, certainly no mutation
    });
  }

  it("zero compatible offers → put_create_publish (the only auto-publish path)", async () => {
    const o = ops(okDisc([]));
    expect(await planPublish(o, intended, null)).toEqual({ action: "put_create_publish" });
    expect(o.invCalls()).toBe(0);
  });
  it("multiple compatible offers → block duplicate_offer_ambiguity", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer({ offerId: "A" }), matchingOffer({ offerId: "B" })])), intended, null);
    expect(plan.action).toBe("block");
    if (plan.action === "block") expect(plan.errorCode).toBe("duplicate_offer_ambiguity");
  });
  it("an on-hold listing → block listing_on_hold", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer({ listingOnHold: true })])), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("listing_on_hold");
  });
});

describe("planPublish — requires the inventory item to be verified", () => {
  it("adopt path: inventory-item lookup failure → block inventory_item_lookup_failed (no mutation)", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer()]), { ok: false, errorCode: "inventory_item_lookup_failed", httpStatus: 500 }), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("inventory_item_lookup_failed");
  });
  it("adopt path: offer exists but inventory item absent → block inventory_item_lookup_failed", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer()]), { ok: true, present: false }), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("inventory_item_lookup_failed");
  });
  it("unpublished exact offer + item, but image identity unverifiable → existing_offer_requires_review (never auto-publishes)", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer()]), { ok: true, present: true, item: matchingItem() }), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("existing_offer_requires_review");
  });
  it("unpublished offer, inventory item CONTENT changed → existing_offer_inputs_changed", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer()]), { ok: true, present: true, item: matchingItem({ title: "different" }) }), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("existing_offer_inputs_changed");
  });
  it("published exact offer + item match → reconcile_local_only (no re-publish)", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer({ listingId: "L9" })]), { ok: true, present: true, item: matchingItem() }), intended, null);
    expect(plan).toEqual({ action: "reconcile_local_only", offerId: "O1", listingId: "L9" });
  });
  it("published offer, inventory content changed → existing_listing_inputs_changed", async () => {
    const plan = await planPublish(ops(okDisc([matchingOffer({ listingId: "L9" })]), { ok: true, present: true, item: matchingItem({ condition: "USED" }) }), intended, null);
    expect(plan.action === "block" && plan.errorCode).toBe("existing_listing_inputs_changed");
  });
});

describe("compareInventoryItem", () => {
  it("matches on identical content; image identity for an external item is unverifiable", () => {
    expect(compareInventoryItem(matchingItem(), intended)).toEqual({ match: true, imageEvidence: "unverifiable" });
  });
  it("differing image count → mismatch; differing content → no match", () => {
    expect(compareInventoryItem(matchingItem({ imageCount: 1 }), intended).imageEvidence).toBe("mismatch");
    expect(compareInventoryItem(matchingItem({ description: "x" }), intended).match).toBe(false);
  });
});

// ── inventory-item discovery (mocked fetch) ──────────────────────────────────
const O = "https://api.ebay.com";
function invMock(res: { status: number; body: unknown } | "throw" | "abort"): InventoryFetchImpl {
  return async () => {
    if (res === "throw") throw new Error("network");
    if (res === "abort") { const e = new Error("aborted"); (e as { name: string }).name = "AbortError"; throw e; }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body };
  };
}
const runInv = (res: Parameters<typeof invMock>[0], origin = O) =>
  fetchInventoryItemForSku({ fetchImpl: invMock(res), apiOrigin: origin, accessToken: "AT", sku: SKU });

describe("fetchInventoryItemForSku", () => {
  it("normalizes a valid 2xx item", async () => {
    const r = await runInv({ status: 200, body: { condition: "LIKE_NEW", product: { title: "T", description: "D", imageUrls: ["a", "b"] }, availability: { shipToLocationAvailability: { quantity: 1 } } } });
    expect(r).toMatchObject({ ok: true, present: true, item: { condition: "LIKE_NEW", title: "T", imageCount: 2, quantity: 1 } });
  });
  it("documented 25710 404 → present:false; arbitrary 404 → inventory_item_lookup_failed", async () => {
    expect(await runInv({ status: 404, body: { errors: [{ errorId: 25710 }] } })).toMatchObject({ ok: true, present: false });
    expect(await runInv({ status: 404, body: { errors: [{ errorId: 99999 }] } })).toMatchObject({ ok: false, errorCode: "inventory_item_lookup_failed" });
  });
  it("3xx → provider_redirect_rejected; abort → provider_timeout; network → lookup_failed", async () => {
    expect(await runInv({ status: 302, body: {} })).toMatchObject({ ok: false, errorCode: "provider_redirect_rejected" });
    expect(await runInv("abort")).toMatchObject({ ok: false, errorCode: "provider_timeout" });
    expect(await runInv("throw")).toMatchObject({ ok: false, errorCode: "inventory_item_lookup_failed" });
  });
  it("malformed 2xx (bad types) → invalid_provider_response; bad apiOrigin → invalid_api_origin", async () => {
    expect(await runInv({ status: 200, body: { product: { imageUrls: "nope" } } })).toMatchObject({ ok: false, errorCode: "invalid_provider_response" });
    expect(await runInv({ status: 200, body: {} }, "https://evil.example.com")).toMatchObject({ ok: false, errorCode: "invalid_api_origin" });
  });
});
