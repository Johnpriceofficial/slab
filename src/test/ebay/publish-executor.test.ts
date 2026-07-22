import { describe, it, expect, vi } from "vitest";
import { executePublish, executeReconcile, type PublishContext, type PublishExecutorOps, type ReconcileOps, type StoredIntent } from "../../../supabase/functions/_shared/ebay-publish-executor";
import { buildImageManifest, buildIntendedState, type IntendedStateInput } from "../../../supabase/functions/_shared/ebay-intended-state";
import type { OfferSummary } from "../../../supabase/functions/_shared/ebay-listing-core";
import type { OffersDiscovery } from "../../../supabase/functions/_shared/ebay-offers";
import type { InventoryItemResult, NormalizedInventoryItem } from "../../../supabase/functions/_shared/ebay-inventory-item";

const SKU = "GCV000047";
const H1 = "a".repeat(64), H2 = "b".repeat(64);
const input: IntendedStateInput = {
  sku: SKU, marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD",
  availableQuantity: 1, listingDescription: "Graded card.", title: "Charizard", description: "Graded.",
  condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [], aspects: { Grade: ["10"] },
};
const intended = buildIntendedState(input)!;
const manifest = buildImageManifest([{ role: "front", path: "f.jpg", sha256: H1 }, { role: "back", path: "b.jpg", sha256: H2 }])!;
const FP = "FP-CURRENT";
const ctx: PublishContext = { intended, manifest, fingerprint: FP, fingerprintVersion: 3 };

const offer = (over: Partial<OfferSummary> = {}): OfferSummary => ({
  offerId: "O1", sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE", listingId: null,
  categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1",
  price: "199.99", currency: "USD", availableQuantity: 1, listingDescription: "Graded card.", listingOnHold: false, ...over,
});
const item = (over: Partial<NormalizedInventoryItem> = {}): NormalizedInventoryItem => ({
  sku: SKU, condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [],
  title: "Charizard", description: "Graded.", aspects: { Grade: ["10"] }, imageCount: 2, quantity: 1, ...over,
});
const okDisc = (offers: OfferSummary[]): OffersDiscovery => ({ ok: true, offers, pagesFetched: 1, providerTotal: offers.length, providerSize: offers.length, deduplicatedCount: 0 });
const failDisc = (errorCode: string): OffersDiscovery => ({ ok: false, errorCode, httpStatus: null, safeProviderErrorId: null, pagesFetched: 0 });
const storedIntent = (over: Partial<StoredIntent> = {}): StoredIntent => ({
  id: "INTENT", status: "preparing", fingerprint: FP, fingerprintVersion: 3, offerId: null, listingId: null,
  intendedState: JSON.parse(JSON.stringify(intended)), imageManifest: JSON.parse(JSON.stringify(manifest)), providerVerified: false, ...over,
});

interface Cfg {
  intent?: StoredIntent | null;
  loadOk?: boolean;
  disc?: OffersDiscovery;
  inv?: InventoryItemResult;
  assertLease?: boolean[];   // sequenced lease-held answers
  writePreparingOk?: boolean;
  recordStatusOk?: boolean;
  failRecordStatuses?: string[];   // recordStatus returns false only for these statuses
  recordOfferCreatedOk?: boolean;
  setVerifiedOk?: boolean;
  mappingOk?: boolean;
  createOfferOk?: boolean;
  publishOk?: boolean;
  putOk?: boolean;
}

function mk(cfg: Cfg = {}) {
  const leaseAnswers = cfg.assertLease ?? [true, true, true, true];
  let leaseIdx = 0;
  const spies = {
    loadIntent: vi.fn(async () => (cfg.loadOk === false ? { ok: false as const } : { ok: true as const, intent: cfg.intent ?? null })),
    writePreparing: vi.fn(async () => (cfg.writePreparingOk === false ? { ok: false as const } : { ok: true as const, intentId: "INTENT" })),
    recordStatus: vi.fn(async (_id: string, status: string) => (cfg.failRecordStatuses?.includes(status) ? false : (cfg.recordStatusOk ?? true))),
    recordOfferCreated: vi.fn(async () => cfg.recordOfferCreatedOk ?? true),
    setProviderVerified: vi.fn(async () => cfg.setVerifiedOk ?? true),
    upsertMapping: vi.fn(async () => cfg.mappingOk ?? true),
    discoverOffers: vi.fn(async () => cfg.disc ?? okDisc([])),
    fetchInventoryItem: vi.fn(async () => cfg.inv ?? ({ ok: true, present: false } as InventoryItemResult)),
    assertLease: vi.fn(async () => leaseAnswers[Math.min(leaseIdx++, leaseAnswers.length - 1)]),
    putInventoryItem: vi.fn(async () => ({ ok: cfg.putOk ?? true })),
    createOffer: vi.fn(async () => ({ ok: cfg.createOfferOk ?? true, offerId: (cfg.createOfferOk ?? true) ? "NEW" : null })),
    publishOffer: vi.fn(async (_o: string) => ({ ok: cfg.publishOk ?? true, listingId: (cfg.publishOk ?? true) ? "LID" : null })),
    recordApiRun: vi.fn(async () => true),
    releaseLease: vi.fn(async () => ({ released: true })),
  };
  const ops = spies as unknown as PublishExecutorOps & typeof spies;
  const providerMutations = () => spies.putInventoryItem.mock.calls.length + spies.createOffer.mock.calls.length + spies.publishOffer.mock.calls.length;
  return { ops, spies, providerMutations };
}

const noMutation = async (label: string, cfg: Cfg) => {
  it(`${label} → zero provider mutation`, async () => {
    const { ops, spies, providerMutations } = mk(cfg);
    await executePublish(ops, ctx);
    expect(providerMutations()).toBe(0);
    expect(spies.releaseLease).toHaveBeenCalledTimes(1); // always released
  });
};

describe("executePublish — NO provider mutation after any block/failure", () => {
  noMutation("malformed getOffers", { disc: failDisc("invalid_provider_response") });
  noMutation("wrong-SKU (invalid_provider_response)", { disc: failDisc("invalid_provider_response") });
  noMutation("pagination failure", { disc: failDisc("pagination_loop") });
  noMutation("redirect", { disc: failDisc("provider_redirect_rejected") });
  noMutation("timeout (inventory)", { disc: okDisc([offer()]), inv: { ok: false, errorCode: "provider_timeout", httpStatus: null }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("malformed inventory item", { disc: okDisc([offer()]), inv: { ok: false, errorCode: "invalid_provider_response", httpStatus: 200 }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("local fingerprint mismatch (published)", { intent: storedIntent({ status: "published", offerId: "O1", listingId: "L9", fingerprint: "OLD" }) });
  noMutation("provider identity conflict", { disc: okDisc([]), intent: storedIntent({ status: "offer_created", offerId: "O1" }) });
  noMutation("incompatible offer", { disc: okDisc([offer({ marketplaceId: "EBAY_GB" })]) });
  noMutation("duplicate offers", { disc: okDisc([offer({ offerId: "A" }), offer({ offerId: "B" })]) });
  noMutation("listing on hold", { disc: okDisc([offer({ listingOnHold: true })]) });
  noMutation("stale listing description", { disc: okDisc([offer({ listingDescription: "old" })]) });
  noMutation("changed condition", { disc: okDisc([offer()]), inv: { ok: true, present: true, item: item({ condition: "USED" }) }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("changed descriptors", { disc: okDisc([offer()]), inv: { ok: true, present: true, item: item({ conditionDescriptors: ["Corners=A"] }) }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("changed aspects", { disc: okDisc([offer()]), inv: { ok: true, present: true, item: item({ aspects: { Grade: ["9"] } }) }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("changed quantity", { disc: okDisc([offer()]), inv: { ok: true, present: true, item: item({ quantity: 5 }) }, intent: storedIntent({ offerId: "O1" }) });
  noMutation("image mismatch (published)", { disc: okDisc([offer({ listingId: "L9" })]), inv: { ok: true, present: true, item: item({ imageCount: 1 }) }, intent: storedIntent({ status: "published", offerId: "O1", listingId: "L9" }) });
  noMutation("failed preparing persistence", { writePreparingOk: false });
  noMutation("lease lost before PUT", { disc: okDisc([]), assertLease: [false] });

  it("unverifiable external offer → requires_review + zero provider mutation", async () => {
    const { ops, spies, providerMutations } = mk({ disc: okDisc([offer()]), inv: { ok: true, present: true, item: item() }, intent: null });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("existing_offer_requires_review");
    expect(providerMutations()).toBe(0);
    expect(spies.recordStatus).toHaveBeenCalledWith("INTENT", "requires_review", "existing_offer_requires_review");
  });
  it("failed preparing persistence → NO provider reads either", async () => {
    const { ops, spies } = mk({ writePreparingOk: false });
    await executePublish(ops, ctx);
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("failed status persistence on a block → intent_persist_failed, no later mutation", async () => {
    const { ops, providerMutations } = mk({ disc: okDisc([offer({ offerId: "A" }), offer({ offerId: "B" })]), recordStatusOk: false });
    const r = await executePublish(ops, ctx);
    expect(r.errorCode).toBe("intent_persist_failed");
    expect(providerMutations()).toBe(0);
  });
  it("lease lost before offer POST → PUT may have run but NO offer POST or publish", async () => {
    const { ops, spies } = mk({ disc: okDisc([]), assertLease: [true, false] });
    await executePublish(ops, ctx);
    expect(spies.createOffer).toHaveBeenCalledTimes(0);
    expect(spies.publishOffer).toHaveBeenCalledTimes(0);
  });
  it("lease lost before publish → NO publish", async () => {
    const { ops, spies } = mk({ disc: okDisc([]), assertLease: [true, true, false] });
    await executePublish(ops, ctx);
    expect(spies.createOffer).toHaveBeenCalledTimes(1);
    expect(spies.publishOffer).toHaveBeenCalledTimes(0);
  });
});

describe("executePublish — authorized paths", () => {
  it("create_new → exactly one PUT, one offer POST, one publish, one mapping, verified", async () => {
    const { ops, spies } = mk({ disc: okDisc([]), intent: null });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("success");
    expect(spies.putInventoryItem).toHaveBeenCalledTimes(1);
    expect(spies.createOffer).toHaveBeenCalledTimes(1);
    expect(spies.publishOffer).toHaveBeenCalledTimes(1);
    expect(spies.upsertMapping).toHaveBeenCalledTimes(1);
    expect(spies.setProviderVerified).toHaveBeenCalledTimes(1);
  });
  it("retry of our own exact persisted offer → resume (NO duplicate offer creation)", async () => {
    const { ops, spies } = mk({ disc: okDisc([offer()]), inv: { ok: true, present: true, item: item() }, intent: storedIntent({ status: "offer_created", offerId: "O1", providerVerified: true }) });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("success");
    expect(spies.createOffer).toHaveBeenCalledTimes(0);   // no duplicate
    expect(spies.publishOffer).toHaveBeenCalledTimes(1);
  });
  it("mapping failure after publish → durable published_unmapped recovery", async () => {
    const { ops, spies } = mk({ disc: okDisc([]), intent: null, mappingOk: false });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("published_unmapped");
    expect(spies.recordStatus).toHaveBeenCalledWith("INTENT", "published_unmapped", "local_persist_failed");
  });
  it("failure to persist published_unmapped is reported honestly (api-run diagnostic, no false claim)", async () => {
    const { ops, spies } = mk({ disc: okDisc([]), intent: null, mappingOk: false, failRecordStatuses: ["published_unmapped"] });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("published_unmapped");
    expect(spies.recordApiRun).toHaveBeenCalledWith("publish", "error", "published_unmapped_persist_failed");
  });
});

// ---- Reconcile shares the SAME engine ----
const reconcileOps = (cfg: Cfg) => {
  const p = mk(cfg);
  const ro = {
    loadIntent: p.spies.loadIntent, recordStatus: p.spies.recordStatus, setProviderVerified: p.spies.setProviderVerified,
    upsertMapping: p.spies.upsertMapping, discoverOffers: p.spies.discoverOffers, fetchInventoryItem: p.spies.fetchInventoryItem,
  } as unknown as ReconcileOps;
  return { ro, spies: p.spies };
};

describe("executeReconcile — full engine, durable snapshot required, local writes only", () => {
  it("missing intended snapshot → reconcile_requires_intended_state, zero mapping writes", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ intendedState: null, imageManifest: null }) });
    const r = await executeReconcile(ro);
    expect(r.status).toBe("reconcile_requires_intended_state");
    expect(spies.upsertMapping).toHaveBeenCalledTimes(0);
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("no intent → no_listing_intent", async () => {
    const { ro } = reconcileOps({ intent: null });
    expect((await executeReconcile(ro)).status).toBe("error");
  });
  it("exact published reconcile → local writes only (mapping + verified, NO provider mutation), USING the inventory item (same engine)", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ status: "published_unmapped", offerId: "O1", listingId: "L9", providerVerified: true }), disc: okDisc([offer({ listingId: "L9" })]), inv: { ok: true, present: true, item: item() } });
    const r = await executeReconcile(ro);
    expect(r.status).toBe("success");
    expect(r.reconciled).toBe(true);
    expect(spies.upsertMapping).toHaveBeenCalledTimes(1);
    expect(spies.setProviderVerified).toHaveBeenCalledTimes(1);
    expect(spies.fetchInventoryItem).toHaveBeenCalledTimes(1); // proves the FULL engine ran, not getOffers-only
  });
  it("does NOT write a mapping merely because getOffers returned one offer (content must match)", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ status: "published", offerId: "O1", listingId: "L9", providerVerified: true }), disc: okDisc([offer({ listingId: "L9", price: "150.00" })]) });
    const r = await executeReconcile(ro);
    expect(r.status).toBe("existing_listing_inputs_changed");
    expect(spies.upsertMapping).toHaveBeenCalledTimes(0);
  });
  it("provider proves no offer → no_live_offer (nothing to reconcile)", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ status: "preparing", offerId: null }), disc: okDisc([]) });
    expect((await executeReconcile(ro)).status).toBe("no_live_offer");
    expect(spies.upsertMapping).toHaveBeenCalledTimes(0);
  });
});
