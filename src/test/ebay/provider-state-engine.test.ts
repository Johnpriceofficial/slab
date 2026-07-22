import { describe, it, expect, vi } from "vitest";
import { evaluateImageEvidence, evaluateProviderState, type DurableLocal, type EngineContext, type EngineReadOps } from "../../../supabase/functions/_shared/ebay-provider-state-engine";
import { buildImageManifest, buildIntendedState, type IntendedStateInput } from "../../../supabase/functions/_shared/ebay-intended-state";
import type { OfferSummary } from "../../../supabase/functions/_shared/ebay-listing-core";
import type { OffersDiscovery } from "../../../supabase/functions/_shared/ebay-offers";
import type { InventoryItemResult, NormalizedInventoryItem } from "../../../supabase/functions/_shared/ebay-inventory-item";

const SKU = "GCV000047";
const H1 = "a".repeat(64), H2 = "b".repeat(64);
const input: IntendedStateInput = {
  sku: SKU, marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD",
  availableQuantity: 1, listingDescription: "Graded card.", title: "2016 Charizard PSA 10", description: "Graded.",
  condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [], aspects: { Grade: ["10"], Grader: ["PSA"] },
};
const intended = buildIntendedState(input)!;
const manifest = buildImageManifest([{ role: "front", path: "f.jpg", sha256: H1 }, { role: "back", path: "b.jpg", sha256: H2 }])!;
const FP = "FP-CURRENT";

const offer = (over: Partial<OfferSummary> = {}): OfferSummary => ({
  offerId: "O1", sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE", listingId: null,
  categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1",
  price: "199.99", currency: "USD", availableQuantity: 1, listingDescription: "Graded card.", listingOnHold: false, ...over,
});
const item = (over: Partial<NormalizedInventoryItem> = {}): NormalizedInventoryItem => ({
  sku: SKU, condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [],
  title: "2016 Charizard PSA 10", description: "Graded.", aspects: { Grade: ["10"], Grader: ["PSA"] }, imageCount: 2, quantity: 1, ...over,
});
const okDisc = (offers: OfferSummary[]): OffersDiscovery => ({ ok: true, offers, pagesFetched: 1, providerTotal: offers.length, providerSize: offers.length, deduplicatedCount: 0 });
const durable = (over: Partial<DurableLocal> = {}): DurableLocal => ({ status: "preparing", fingerprint: FP, offerId: "O1", listingId: null, manifest, providerVerified: true, ...over });

function ops(disc: OffersDiscovery, inv?: InventoryItemResult) {
  const discoverOffers = vi.fn(async () => disc);
  const fetchInventoryItem = vi.fn(async () => inv ?? ({ ok: true, present: false } as InventoryItemResult));
  const o: EngineReadOps = { discoverOffers, fetchInventoryItem };
  return { o, invCalls: () => fetchInventoryItem.mock.calls.length, discCalls: () => discoverOffers.mock.calls.length };
}
const ctx = (local: DurableLocal | null = null): EngineContext => ({ intended, manifest, fingerprint: FP, local });

describe("evaluateProviderState — a failed provider READ blocks with no second read", () => {
  for (const code of ["provider_lookup_failed", "invalid_provider_response", "provider_redirect_rejected", "pagination_loop", "pagination_limit_exceeded", "incomplete_provider_result", "inconsistent_provider_pagination", "unsafe_pagination_url", "invalid_api_origin"]) {
    it(`discovery ${code} → providerFailure block, inventory NOT fetched`, async () => {
      const t = ops({ ok: false, errorCode: code, httpStatus: null, safeProviderErrorId: null, pagesFetched: 0 });
      const r = await evaluateProviderState(t.o, ctx());
      expect(r.providerFailure).toBe(true);
      expect(r.providerErrorCode).toBe(code);
      expect(t.invCalls()).toBe(0);
    });
  }
});

describe("evaluateProviderState — offer-level decisions never fetch the inventory item", () => {
  it("proven-zero offers + no local artifact → create_new", async () => {
    const t = ops(okDisc([]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("create_new");
    expect(t.invCalls()).toBe(0);
  });
  it("proven-zero offers but a local offer id → local_provider_identity_conflict", async () => {
    const t = ops(okDisc([]));
    expect((await evaluateProviderState(t.o, ctx(durable({ offerId: "O1" })))).decision).toBe("local_provider_identity_conflict");
  });
  it("multiple compatible offers → duplicate_offer_ambiguity", async () => {
    const t = ops(okDisc([offer({ offerId: "A" }), offer({ offerId: "B" })]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("duplicate_offer_ambiguity");
    expect(t.invCalls()).toBe(0);
  });
  it("incompatible same-SKU offer → incompatible_offer_exists", async () => {
    const t = ops(okDisc([offer({ marketplaceId: "EBAY_GB" })]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("incompatible_offer_exists");
    expect(t.invCalls()).toBe(0);
  });
  it("on-hold offer → listing_on_hold", async () => {
    const t = ops(okDisc([offer({ listingOnHold: true })]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("listing_on_hold");
    expect(t.invCalls()).toBe(0);
  });
  it("compatible unpublished offer with a STALE description → existing_offer_inputs_changed", async () => {
    const t = ops(okDisc([offer({ listingDescription: "old" })]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("existing_offer_inputs_changed");
    expect(t.invCalls()).toBe(0);
  });
  it("compatible published offer with changed offer-level inputs → existing_listing_inputs_changed", async () => {
    const t = ops(okDisc([offer({ listingId: "L9", price: "150.00" })]));
    expect((await evaluateProviderState(t.o, ctx())).decision).toBe("existing_listing_inputs_changed");
    expect(t.invCalls()).toBe(0);
  });
});

describe("evaluateProviderState — adopt/reconcile require a verified inventory item", () => {
  it("offer matches but inventory lookup FAILS → providerFailure block", async () => {
    const t = ops(okDisc([offer()]), { ok: false, errorCode: "inventory_item_lookup_failed", httpStatus: 500 });
    const r = await evaluateProviderState(t.o, ctx(durable()));
    expect(r.providerFailure).toBe(true);
    expect(t.invCalls()).toBe(1);
  });
  it("offer matches but NO inventory item → inventory_item_lookup_failed (an offer implies an item)", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: false });
    expect((await evaluateProviderState(t.o, ctx(durable()))).decision).toBe("inventory_item_lookup_failed");
  });
  it("offer + item content mismatch (unpublished) → existing_offer_inputs_changed", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item({ title: "different" }) });
    expect((await evaluateProviderState(t.o, ctx(durable()))).decision).toBe("existing_offer_inputs_changed");
  });
  it("null provider quantity is NOT an exact match → existing_offer_inputs_changed", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item({ quantity: null }) });
    expect((await evaluateProviderState(t.o, ctx(durable()))).decision).toBe("existing_offer_inputs_changed");
  });
  it("our own unpublished offer, exact match + verified evidence → resume_local_exact", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(durable({ offerId: "O1", listingId: null })))).decision).toBe("resume_local_exact");
  });
  it("an EXTERNAL unpublished offer (no durable evidence) that matches → existing_offer_requires_review (never auto-adopted)", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item() });
    const r = await evaluateProviderState(t.o, ctx(null));
    expect(r.decision).toBe("existing_offer_requires_review");
    expect(r.imageEvidence).toBe("unverifiable");
  });
});

describe("evaluateProviderState — published reconcile", () => {
  it("published, content mismatch → existing_listing_inputs_changed", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item({ condition: "USED" }) });
    expect((await evaluateProviderState(t.o, ctx(durable({ offerId: "O1", listingId: "L9" })))).decision).toBe("existing_listing_inputs_changed");
  });
  it("published, image COUNT mismatch → existing_listing_inputs_changed (image mismatch cannot be reconciled)", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item({ imageCount: 1 }) });
    expect((await evaluateProviderState(t.o, ctx(durable({ offerId: "O1", listingId: "L9" })))).decision).toBe("existing_listing_inputs_changed");
  });
  it("published, exact match + verified evidence, local mapping missing → reconcile_exact_published", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(durable({ status: "preparing", offerId: "O1", listingId: "L9" })))).decision).toBe("reconcile_exact_published");
  });
  it("published, exact match, already mapped locally → already_published_exact", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(durable({ status: "published", offerId: "O1", listingId: "L9" })))).decision).toBe("already_published_exact");
  });
  it("published external offer (no durable evidence) → existing_offer_requires_review", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(null))).decision).toBe("existing_offer_requires_review");
  });
});

describe("evaluateImageEvidence — stable, durable-evidence based (never signed URLs / count alone)", () => {
  it("no durable local record → unverifiable", () => {
    expect(evaluateImageEvidence(ctx(null), 2, "O1", null)).toBe("unverifiable");
  });
  it("provider image count differs from the manifest → mismatch", () => {
    expect(evaluateImageEvidence(ctx(durable()), 1, "O1", null)).toBe("mismatch");
  });
  it("provider identity mismatch or not provider-verified → unverifiable", () => {
    expect(evaluateImageEvidence(ctx(durable({ offerId: "O1" })), 2, "OTHER", null)).toBe("unverifiable");
    expect(evaluateImageEvidence(ctx(durable({ providerVerified: false })), 2, "O1", null)).toBe("unverifiable");
  });
  it("fingerprint changed since recording → mismatch", () => {
    expect(evaluateImageEvidence(ctx(durable({ fingerprint: "OLD" })), 2, "O1", null)).toBe("mismatch");
  });
  it("exact identity + manifest + fingerprint + provider-verified → verified", () => {
    expect(evaluateImageEvidence(ctx(durable()), 2, "O1", null)).toBe("verified");
  });
});
