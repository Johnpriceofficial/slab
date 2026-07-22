import { describe, it, expect, vi } from "vitest";
import { executePublish, executeReconcile, type PublishContext, type PublishExecutorOps, type ReconcileOps, type StoredIntent } from "../../../supabase/functions/_shared/ebay-publish-executor";
import { buildImageManifest, buildIntendedState, canonicalListingFingerprint, type IntendedStateInput } from "../../../supabase/functions/_shared/ebay-intended-state";
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
const FP = await canonicalListingFingerprint(intended, manifest); // the REAL fingerprint of the stored snapshot
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
  intendedState: JSON.parse(JSON.stringify(intended)), imageManifest: JSON.parse(JSON.stringify(manifest)),
  imagesSubmittedAt: null, verificationMethod: null, ...over,
});

interface Cfg {
  intent?: StoredIntent | null; loadOk?: boolean; disc?: OffersDiscovery; inv?: InventoryItemResult;
  assertLease?: boolean[]; writePreparingOk?: boolean; failRecordStatuses?: string[];
  recordOfferCreatedOk?: boolean; reconcileOk?: boolean; apiRunOk?: boolean;
  createOfferOk?: boolean; publishOk?: boolean; putOk?: boolean;
}
const persist = (ok: boolean) => (ok ? { ok: true as const } : { ok: false as const, errorCode: "intent_update_failed" as const });

function mk(cfg: Cfg = {}) {
  const lease = cfg.assertLease ?? [true, true, true, true];
  let li = 0;
  const spies = {
    loadIntent: vi.fn(async () => (cfg.loadOk === false ? { ok: false as const } : { ok: true as const, intent: cfg.intent ?? null })),
    writePreparing: vi.fn(async () => (cfg.writePreparingOk === false ? { ok: false as const } : { ok: true as const, intentId: "INTENT" })),
    recordStatus: vi.fn(async (_id: string, status: string) => persist(!cfg.failRecordStatuses?.includes(status))),
    recordOfferCreated: vi.fn(async () => persist(cfg.recordOfferCreatedOk ?? true)),
    reconcileLocal: vi.fn(async () => (cfg.reconcileOk === false ? { ok: false as const, errorCode: "reconcile_rpc_failed" as const } : { ok: true as const })),
    discoverOffers: vi.fn(async () => cfg.disc ?? okDisc([])),
    fetchInventoryItem: vi.fn(async () => cfg.inv ?? ({ ok: true, present: false } as InventoryItemResult)),
    assertLease: vi.fn(async () => lease[Math.min(li++, lease.length - 1)]),
    putInventoryItem: vi.fn(async () => ({ ok: cfg.putOk ?? true })),
    createOffer: vi.fn(async () => ({ ok: cfg.createOfferOk ?? true, offerId: (cfg.createOfferOk ?? true) ? "NEW" : null })),
    publishOffer: vi.fn(async (_o: string) => ({ ok: cfg.publishOk ?? true, listingId: (cfg.publishOk ?? true) ? "LID" : null })),
    recordApiRun: vi.fn(async () => (cfg.apiRunOk === false ? { ok: false as const, errorCode: "api_run_persist_failed" as const } : { ok: true as const })),
    releaseLease: vi.fn(async () => ({ released: true })),
  };
  const ops = spies as unknown as PublishExecutorOps & typeof spies;
  const providerMutations = () => spies.putInventoryItem.mock.calls.length + spies.createOffer.mock.calls.length + spies.publishOffer.mock.calls.length;
  return { ops, spies, providerMutations };
}
const noMut = (label: string, cfg: Cfg) => it(`${label} → zero provider mutation`, async () => {
  const { ops, spies, providerMutations } = mk(cfg);
  await executePublish(ops, ctx);
  expect(providerMutations()).toBe(0);
  expect(spies.releaseLease).toHaveBeenCalledTimes(1);
});

describe("executePublish — NO mutation after block/verification/failure/lease-loss", () => {
  noMut("malformed getOffers", { disc: failDisc("invalid_provider_response") });
  noMut("pagination failure", { disc: failDisc("pagination_loop") });
  noMut("redirect", { disc: failDisc("provider_redirect_rejected") });
  noMut("timeout (inventory)", { disc: okDisc([offer()]), inv: { ok: false, errorCode: "provider_timeout", httpStatus: null }, intent: storedIntent({ status: "offer_created", offerId: "O1", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
  noMut("malformed inventory", { disc: okDisc([offer()]), inv: { ok: false, errorCode: "invalid_provider_response", httpStatus: 200 }, intent: storedIntent({ status: "offer_created", offerId: "O1", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
  noMut("local fingerprint mismatch (published)", { intent: storedIntent({ status: "published", offerId: "O1", listingId: "L9", fingerprint: "OLDFP" }) });
  noMut("provider identity conflict", { disc: okDisc([]), intent: storedIntent({ status: "offer_created", offerId: "O1", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
  noMut("incompatible offer", { disc: okDisc([offer({ marketplaceId: "EBAY_GB" })]) });
  noMut("duplicate offers", { disc: okDisc([offer({ offerId: "A" }), offer({ offerId: "B" })]) });
  noMut("listing on hold", { disc: okDisc([offer({ listingOnHold: true })]) });
  noMut("stale description", { disc: okDisc([offer({ listingDescription: "old" })]) });
  noMut("changed condition", { disc: okDisc([offer()]), inv: { ok: true, present: true, item: item({ condition: "USED" }) }, intent: storedIntent({ status: "offer_created", offerId: "O1", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
  noMut("image count mismatch (published)", { disc: okDisc([offer({ listingId: "L9" })]), inv: { ok: true, present: true, item: item({ imageCount: 1 }) }, intent: storedIntent({ status: "published_unmapped", offerId: "O1", listingId: "L9", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
  noMut("failed preparing persistence", { writePreparingOk: false });
  noMut("lease lost before PUT", { disc: okDisc([]), assertLease: [false] });

  it("FORGED stored snapshot (fingerprint mismatch) → block BEFORE any provider read", async () => {
    const { ops, spies } = mk({ intent: storedIntent({ status: "offer_created", offerId: "O1", fingerprint: "f".repeat(64) }) });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("fingerprint_mismatch");
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("failed preparing persistence → NO provider reads", async () => {
    const { spies } = { ...mk({ writePreparingOk: false }) };
    await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("external unverifiable offer → requires_review + zero mutation", async () => {
    const { ops, spies, providerMutations } = mk({ disc: okDisc([offer()]), inv: { ok: true, present: true, item: item() }, intent: null });
    const r = await executePublish(ops, ctx);
    expect(r.status).toBe("existing_offer_requires_review");
    expect(providerMutations()).toBe(0);
    expect(spies.recordStatus).toHaveBeenCalledWith("INTENT", "requires_review", "existing_offer_requires_review");
  });
  it("lease lost before offer POST → no offer POST / publish", async () => {
    const { spies } = mk({ disc: okDisc([]), assertLease: [true, false] });
    await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(spies.createOffer).toHaveBeenCalledTimes(0);
    expect(spies.publishOffer).toHaveBeenCalledTimes(0);
  });
  it("lease lost before publish → no publish", async () => {
    const { spies } = mk({ disc: okDisc([]), assertLease: [true, true, false] });
    await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(spies.createOffer).toHaveBeenCalledTimes(1);
    expect(spies.publishOffer).toHaveBeenCalledTimes(0);
  });
});

describe("executePublish — authorized paths + ATOMIC reconcile + HONEST recovery", () => {
  it("create_new → 1 PUT, 1 offer, 1 publish, 1 atomic reconcileLocal", async () => {
    const { spies } = mk({ disc: okDisc([]), intent: null });
    const r = await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(r.status).toBe("success");
    expect(spies.putInventoryItem).toHaveBeenCalledTimes(1);
    expect(spies.createOffer).toHaveBeenCalledTimes(1);
    expect(spies.publishOffer).toHaveBeenCalledTimes(1);
    expect(spies.reconcileLocal).toHaveBeenCalledTimes(1);
  });
  it("retry of our own persisted offer → resume (no duplicate offer)", async () => {
    const { spies } = mk({ disc: okDisc([offer()]), inv: { ok: true, present: true, item: item() }, intent: storedIntent({ status: "offer_created", offerId: "O1", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
    const r = await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(r.status).toBe("success");
    expect(spies.createOffer).toHaveBeenCalledTimes(0);
    expect(spies.publishOffer).toHaveBeenCalledTimes(1);
  });
  it("published_unmapped reconcile → local-only atomic write, ZERO provider mutation", async () => {
    const { spies, providerMutations } = mk({ disc: okDisc([offer({ listingId: "L9" })]), inv: { ok: true, present: true, item: item() }, intent: storedIntent({ status: "published_unmapped", offerId: "O1", listingId: "L9", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) });
    const r = await executePublish((spies as unknown) as PublishExecutorOps, ctx);
    expect(r.status).toBe("success");
    expect(spies.reconcileLocal).toHaveBeenCalledTimes(1);
    expect(providerMutations()).toBe(0);
  });
  it("no offer id → offer_creation_failed (recorded) / recovery_persist_failed (unrecorded)", async () => {
    expect((await executePublish((mk({ disc: okDisc([]), createOfferOk: false }).spies as unknown) as PublishExecutorOps, ctx)).status).toBe("error");
    const r = await executePublish((mk({ disc: okDisc([]), createOfferOk: false, failRecordStatuses: ["failed"] }).spies as unknown) as PublishExecutorOps, ctx);
    expect(r.errorCode).toBe("recovery_persist_failed");
  });
  it("recordOfferCreated fails → offer_created_unpersisted; if recovery also fails → offer_created_recovery_unpersisted", async () => {
    expect((await executePublish((mk({ disc: okDisc([]), recordOfferCreatedOk: false }).spies as unknown) as PublishExecutorOps, ctx)).status).toBe("offer_created_unpersisted");
    const r = await executePublish((mk({ disc: okDisc([]), recordOfferCreatedOk: false, failRecordStatuses: ["offer_created_unpersisted"] }).spies as unknown) as PublishExecutorOps, ctx);
    expect(r.status).toBe("offer_created_recovery_unpersisted");
  });
  it("atomic reconcile fails after publish → published_unmapped; if marker also fails → published_recovery_unpersisted + api-run diagnostic", async () => {
    expect((await executePublish((mk({ disc: okDisc([]), reconcileOk: false }).spies as unknown) as PublishExecutorOps, ctx)).status).toBe("published_unmapped");
    const t = mk({ disc: okDisc([]), reconcileOk: false, failRecordStatuses: ["published_unmapped"] });
    const r = await executePublish((t.spies as unknown) as PublishExecutorOps, ctx);
    expect(r.status).toBe("published_recovery_unpersisted");
    expect(t.spies.recordApiRun).toHaveBeenCalledWith("publish", "error", "published_unmapped_persist_failed");
  });
});

const reconcileOps = (cfg: Cfg) => {
  const p = mk(cfg);
  const ro = { loadIntent: p.spies.loadIntent, recordStatus: p.spies.recordStatus, reconcileLocal: p.spies.reconcileLocal, recordApiRun: p.spies.recordApiRun, discoverOffers: p.spies.discoverOffers, fetchInventoryItem: p.spies.fetchInventoryItem } as unknown as ReconcileOps;
  return { ro, spies: p.spies };
};

describe("executeReconcile — verified snapshot required, atomic local write only", () => {
  it("missing snapshot → reconcile_requires_intended_state, zero reads/writes", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ intendedState: null, imageManifest: null }) });
    const r = await executeReconcile(ro);
    expect(r.status).toBe("reconcile_requires_intended_state");
    expect(spies.reconcileLocal).toHaveBeenCalledTimes(0);
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("FORGED snapshot → reconcile_requires_intended_state (fingerprint_mismatch), zero reads", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ fingerprint: "f".repeat(64) }) });
    expect((await executeReconcile(ro)).status).toBe("reconcile_requires_intended_state");
    expect(spies.discoverOffers).toHaveBeenCalledTimes(0);
  });
  it("exact published reconcile → atomic local write, uses inventory item (full engine)", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ status: "published_unmapped", offerId: "O1", listingId: "L9", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }), disc: okDisc([offer({ listingId: "L9" })]), inv: { ok: true, present: true, item: item() } });
    const r = await executeReconcile(ro);
    expect(r.status).toBe("success");
    expect(spies.reconcileLocal).toHaveBeenCalledTimes(1);
    expect(spies.fetchInventoryItem).toHaveBeenCalledTimes(1);
  });
  it("provider proves no offer → no_live_offer, no write", async () => {
    const { ro, spies } = reconcileOps({ intent: storedIntent({ status: "preparing" }), disc: okDisc([]) });
    expect((await executeReconcile(ro)).status).toBe("no_live_offer");
    expect(spies.reconcileLocal).toHaveBeenCalledTimes(0);
  });
});
