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
// Our OWN recorded listing (durable identity present): images_submitted, unchanged manifest+fp.
const ours = (over: Partial<DurableLocal> = {}): DurableLocal => ({ status: "offer_created", fingerprint: FP, offerId: "O1", listingId: null, manifest, imagesSubmittedAt: "2026-07-22T00:00:00Z", verificationMethod: "submitted_only", ...over });

function ops(disc: OffersDiscovery, inv?: InventoryItemResult) {
  const discoverOffers = vi.fn(async () => disc);
  const fetchInventoryItem = vi.fn(async () => inv ?? ({ ok: true, present: false } as InventoryItemResult));
  const o: EngineReadOps = { discoverOffers, fetchInventoryItem };
  return { o, invCalls: () => fetchInventoryItem.mock.calls.length };
}
const ctx = (local: DurableLocal | null = null): EngineContext => ({ intended, manifest, fingerprint: FP, local });

describe("evaluateImageEvidence — HONEST (never `verified` from count/identity/timestamp)", () => {
  it("no durable record → unverifiable/unverifiable", () => {
    expect(evaluateImageEvidence(ctx(null), 2, "O1", null)).toEqual({ evidence: "unverifiable", method: "unverifiable" });
  });
  it("provider count differs → mismatch", () => {
    expect(evaluateImageEvidence(ctx(ours()), 1, "O1", null).evidence).toBe("mismatch");
  });
  it("identity mismatch → unverifiable (not verified)", () => {
    expect(evaluateImageEvidence(ctx(ours()), 2, "OTHER", null)).toEqual({ evidence: "unverifiable", method: "unverifiable" });
  });
  it("our unchanged listing → unverifiable with provider_reference_match (NEVER verified)", () => {
    const r = evaluateImageEvidence(ctx(ours()), 2, "O1", null);
    expect(r).toEqual({ evidence: "unverifiable", method: "provider_reference_match" });
    expect(r.evidence).not.toBe("verified"); // current eBay API exposes no content hash
  });
  it("local fingerprint changed → mismatch", () => {
    expect(evaluateImageEvidence(ctx(ours({ fingerprint: "OLD" })), 2, "O1", null).evidence).toBe("mismatch");
  });
});

describe("evaluateProviderState — offer-level decisions, no second read", () => {
  for (const code of ["provider_lookup_failed", "invalid_provider_response", "provider_redirect_rejected", "provider_timeout"]) {
    it(`discovery ${code} → providerFailure, inventory NOT fetched`, async () => {
      const t = ops({ ok: false, errorCode: code, httpStatus: null, safeProviderErrorId: null, pagesFetched: 0 });
      const r = await evaluateProviderState(t.o, ctx());
      expect(r.providerFailure).toBe(true);
      expect(t.invCalls()).toBe(0);
    });
  }
  it("proven-zero + no local artifact → create_new (method submitted_only)", async () => {
    const t = ops(okDisc([]));
    const r = await evaluateProviderState(t.o, ctx());
    expect(r.decision).toBe("create_new");
    expect(r.verificationMethod).toBe("submitted_only");
  });
  it("proven-zero + local offer id → local_provider_identity_conflict", async () => {
    expect((await evaluateProviderState(ops(okDisc([])).o, ctx(ours()))).decision).toBe("local_provider_identity_conflict");
  });
  it("incompatible / duplicate / on-hold / stale-desc / changed-published → block, no inventory fetch", async () => {
    for (const [disc, expected] of [
      [okDisc([offer({ marketplaceId: "EBAY_GB" })]), "incompatible_offer_exists"],
      [okDisc([offer({ offerId: "A" }), offer({ offerId: "B" })]), "duplicate_offer_ambiguity"],
      [okDisc([offer({ listingOnHold: true })]), "listing_on_hold"],
      [okDisc([offer({ listingDescription: "old" })]), "existing_offer_inputs_changed"],
      [okDisc([offer({ listingId: "L9", price: "150.00" })]), "existing_listing_inputs_changed"],
    ] as Array<[OffersDiscovery, string]>) {
      const t = ops(disc);
      expect((await evaluateProviderState(t.o, ctx())).decision).toBe(expected);
      expect(t.invCalls()).toBe(0);
    }
  });
});

describe("evaluateProviderState — adopt/reconcile use identity + content, NOT image 'verified'", () => {
  it("our own unpublished offer, exact content, unchanged images → resume_local_exact (method provider_reference_match)", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item() });
    const r = await evaluateProviderState(t.o, ctx(ours()));
    expect(r.decision).toBe("resume_local_exact");
    expect(r.verificationMethod).toBe("provider_reference_match");
    expect(r.imageEvidence).not.toBe("verified");
  });
  it("EXTERNAL unpublished offer (no durable identity) → existing_offer_requires_review", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(null))).decision).toBe("existing_offer_requires_review");
  });
  it("content mismatch → existing_offer_inputs_changed", async () => {
    const t = ops(okDisc([offer()]), { ok: true, present: true, item: item({ title: "different" }) });
    expect((await evaluateProviderState(t.o, ctx(ours()))).decision).toBe("existing_offer_inputs_changed");
  });
  it("published: our own exact match → reconcile_exact_published; already-mapped → already_published_exact", async () => {
    const t1 = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t1.o, ctx(ours({ status: "published_unmapped", listingId: "L9" })))).decision).toBe("reconcile_exact_published");
    const t2 = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t2.o, ctx(ours({ status: "published", listingId: "L9" })))).decision).toBe("already_published_exact");
  });
  it("published: image COUNT mismatch → existing_listing_inputs_changed", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item({ imageCount: 1 }) });
    expect((await evaluateProviderState(t.o, ctx(ours({ status: "published_unmapped", listingId: "L9" })))).decision).toBe("existing_listing_inputs_changed");
  });
  it("published EXTERNAL offer → existing_offer_requires_review", async () => {
    const t = ops(okDisc([offer({ listingId: "L9" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(null))).decision).toBe("existing_offer_requires_review");
  });
  it("recorded local offer id disagreeing with provider → local_provider_identity_conflict", async () => {
    const t = ops(okDisc([offer({ offerId: "O2" })]), { ok: true, present: true, item: item() });
    expect((await evaluateProviderState(t.o, ctx(ours({ offerId: "O1" })))).decision).toBe("local_provider_identity_conflict");
  });
});
