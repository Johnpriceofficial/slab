import { describe, it, expect, vi } from "vitest";
import { handlePublish, handleReconcile, type ListingDeps, routeListingWithToken } from "../../../supabase/functions/_shared/ebay-listing-handler";
import { buildImageManifest, buildIntendedState, canonicalListingFingerprint, type IntendedStateInput } from "../../../supabase/functions/_shared/ebay-intended-state";
import type { PublishExecutorOps, ReconcileOps, StoredIntent } from "../../../supabase/functions/_shared/ebay-publish-executor";
import type { OffersDiscovery } from "../../../supabase/functions/_shared/ebay-offers";
import type { InventoryItemResult } from "../../../supabase/functions/_shared/ebay-inventory-item";
import { EBAY_MUTATION_FLAGS } from "../../../supabase/functions/_shared/ebay-mutation-flags";

const H1 = "a".repeat(64), H2 = "b".repeat(64);
const SKU = "GCV000047";
const input: IntendedStateInput = {
  sku: SKU, marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD",
  availableQuantity: 1, listingDescription: "Graded card.", title: "Charizard", description: "Graded card.",
  condition: "LIKE_NEW", conditionDescription: "", conditionDescriptors: [], aspects: {},
};
const intended = buildIntendedState(input)!;
const manifest = buildImageManifest([{ role: "front", path: "slabs/47/front.jpg", sha256: H1 }, { role: "back", path: "slabs/47/back.jpg", sha256: H2 }])!;
const FP = await canonicalListingFingerprint(intended, manifest);
const okDisc = (offers: unknown[] = []): OffersDiscovery => ({ ok: true, offers: offers as never, pagesFetched: 1, providerTotal: offers.length, providerSize: offers.length, deduplicatedCount: 0 });
const storedIntent = (over: Partial<StoredIntent> = {}): StoredIntent => {
  const s: StoredIntent = {
    id: "INTENT", status: "preparing", fingerprint: FP, fingerprintVersion: 3, offerId: null, listingId: null,
    intendedState: JSON.parse(JSON.stringify(intended)), imageManifest: JSON.parse(JSON.stringify(manifest)),
    imagesSubmittedAt: null, verificationMethod: null, providerImageEvidence: null, updatedAt: "2026-07-22T00:00:00Z", ...over,
  };
  if (s.imagesSubmittedAt && s.providerImageEvidence === null && !("providerImageEvidence" in over)) {
    s.providerImageEvidence = { method: "submitted_only", offer_id: s.offerId ?? undefined, listing_id: s.listingId };
  }
  return s;
};

const publishBody = (over: Record<string, unknown> = {}) => ({
  slab_id: "S1", category_id: "183454", merchant_location_key: "LOC-A",
  fulfillment_policy_id: "F1", payment_policy_id: "P1", return_policy_id: "R1",
  price_value: 199.99, currency: "USD", condition: "LIKE_NEW", title: "Charizard", description: "Graded card.",
  quantity: 1, confirmation: "PUBLISH", ...over,
});

interface DepsCfg {
  flagOn?: boolean;
  slab?: { inventoryNumber: number; frontImagePath: string | null; backImagePath: string | null } | null;
  slabOk?: boolean;
  ownershipOk?: boolean;
  hashes?: string[];            // per-image hash (defaults distinct)
  leaseAcquired?: boolean;
  publishOps?: () => PublishExecutorOps;
  reconcileOps?: () => ReconcileOps;
}

function mockDeps(cfg: DepsCfg = {}) {
  let hi = 0;
  const spies = {
    flagEnabled: vi.fn((name: string) => (cfg.flagOn ?? true) && name === EBAY_MUTATION_FLAGS.listing),
    loadAccessToken: vi.fn(async () => ({ ok: true as const, token: "AT" })),
    loadSlabForListing: vi.fn(async () => (cfg.slabOk === false ? { ok: false as const } : { ok: true as const, slab: cfg.slab === undefined ? { inventoryNumber: 47, frontImagePath: "slabs/47/front.jpg", backImagePath: "slabs/47/back.jpg" } : cfg.slab })),
    verifyListingOwnership: vi.fn(async () => (cfg.ownershipOk === false ? { ok: false as const, errorCode: "unknown_location", httpStatus: 400 } : { ok: true as const })),
    signImageUrl: vi.fn(async () => "https://signed/x.jpg"),
    hashImage: vi.fn(async () => (cfg.hashes ? cfg.hashes[Math.min(hi++, cfg.hashes.length - 1)] : [H1, H2][Math.min(hi++, 1)])),
    leaseAcquire: vi.fn(async () => ({ acquired: cfg.leaseAcquired ?? true, error: false })),
    makePublishOps: vi.fn(() => (cfg.publishOps ? cfg.publishOps() : defaultPublishOps())),
    makeReconcileOps: vi.fn(() => (cfg.reconcileOps ? cfg.reconcileOps() : defaultReconcileOps())),
    uuid: vi.fn(() => "lease-token"),
  };
  return { deps: spies as unknown as ListingDeps & typeof spies, spies };
}

function defaultPublishOps(over: Partial<Record<string, unknown>> = {}, intent: StoredIntent | null = null): PublishExecutorOps & Record<string, ReturnType<typeof vi.fn>> {
  const s = {
    loadIntent: vi.fn(async () => ({ ok: true as const, intent })),
    writePreparing: vi.fn(async () => ({ ok: true as const, intentId: "INTENT" })),
    recordStatus: vi.fn(async () => ({ ok: true as const })),
    recordOfferCreated: vi.fn(async () => ({ ok: true as const })),
    reconcileLocal: vi.fn(async () => ({ ok: true as const })),
    discoverOffers: vi.fn(async () => (over.disc as OffersDiscovery) ?? okDisc([])),
    fetchInventoryItem: vi.fn(async () => ({ ok: true, present: false } as InventoryItemResult)),
    assertLease: vi.fn(async () => true),
    putInventoryItem: vi.fn(async () => ({ ok: true })),
    createOffer: vi.fn(async () => ({ ok: true, offerId: "NEW" })),
    publishOffer: vi.fn(async () => ({ ok: true, listingId: "LID" })),
    recordApiRun: vi.fn(async () => ({ ok: true as const })),
    releaseLease: vi.fn(async () => ({ released: true })),
  };
  return s as unknown as PublishExecutorOps & Record<string, ReturnType<typeof vi.fn>>;
}
function defaultReconcileOps(): ReconcileOps & Record<string, ReturnType<typeof vi.fn>> {
  const s = {
    loadIntent: vi.fn(async () => ({ ok: true as const, intent: storedIntent({ status: "published_unmapped", offerId: "O1", listingId: "L9", imagesSubmittedAt: "t", verificationMethod: "submitted_only" }) })),
    recordStatus: vi.fn(async () => ({ ok: true as const })),
    reconcileLocal: vi.fn(async () => ({ ok: true as const })),
    recordApiRun: vi.fn(async () => ({ ok: true as const })),
    discoverOffers: vi.fn(async () => okDisc([{ offerId: "O1", sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE", listingId: "L9", categoryId: "183454", merchantLocationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: "199.99", currency: "USD", availableQuantity: 1, listingDescription: "Graded card.", listingOnHold: false }])),
    fetchInventoryItem: vi.fn(async () => ({ ok: true, present: true, item: { sku: SKU, condition: "LIKE_NEW", conditionDescription: "", conditionDescriptors: [], title: "Charizard", description: "Graded card.", aspects: {}, imageCount: 2, quantity: 1 } } as InventoryItemResult)),
  };
  return s as unknown as ReconcileOps & Record<string, ReturnType<typeof vi.fn>>;
}

const args = (body: Record<string, unknown>, deps: ListingDeps) => ({ body, accountId: "ACC", accessToken: "AT", marketplaceId: "EBAY_US", categoryId: "183454", deps });

describe("handler-adapter — the ACTUAL list_item/reconcile routing+binding (injected deps)", () => {
  it("1) listing flag disabled → mutation_disabled, ZERO downstream calls", async () => {
    const { deps, spies } = mockDeps({ flagOn: false });
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.body.status).toBe("mutation_disabled");
    expect(spies.loadSlabForListing).toHaveBeenCalledTimes(0);
    expect(spies.leaseAcquire).toHaveBeenCalledTimes(0);
    expect(spies.makePublishOps).toHaveBeenCalledTimes(0);
  });

  it("2) bad canonical SKU → canonical_sku_mismatch, no lease / executor", async () => {
    const { deps, spies } = mockDeps();
    const r = await handlePublish(args(publishBody({ sku: "GCV000099" }), deps));
    expect(r.body.error_code).toBe("canonical_sku_mismatch");
    expect(spies.leaseAcquire).toHaveBeenCalledTimes(0);
    expect(spies.makePublishOps).toHaveBeenCalledTimes(0);
  });

  it("3) invalid durable image manifest (duplicate hash) → no lease, no executor", async () => {
    const { deps, spies } = mockDeps({ hashes: [H1, H1] }); // dup hash → buildImageManifest null
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.body.error_code).toBe("image_manifest_failed");
    expect(spies.leaseAcquire).toHaveBeenCalledTimes(0);
    expect(spies.makePublishOps).toHaveBeenCalledTimes(0);
  });

  it("4) FORGED stored snapshot → executor blocks, ZERO provider reads/mutations", async () => {
    const ops = defaultPublishOps({}, storedIntent({ status: "offer_created", offerId: "O1", fingerprint: "f".repeat(64) }));
    const { deps } = mockDeps({ publishOps: () => ops });
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.body.status).toBe("existing_intent_missing_verified_snapshot");
    expect(ops.discoverOffers).toHaveBeenCalledTimes(0);
    expect(ops.putInventoryItem).toHaveBeenCalledTimes(0);
    expect(ops.createOffer).toHaveBeenCalledTimes(0);
    expect(ops.publishOffer).toHaveBeenCalledTimes(0);
  });

  it("5) malformed getOffers → executor binds but ZERO inventory PUT / offer POST / publish", async () => {
    const ops = defaultPublishOps({ disc: { ok: false, errorCode: "invalid_provider_response", httpStatus: 200, safeProviderErrorId: null, pagesFetched: 1 } });
    const { deps } = mockDeps({ publishOps: () => ops });
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.httpStatus).toBe(502);
    expect(ops.putInventoryItem).toHaveBeenCalledTimes(0);
    expect(ops.createOffer).toHaveBeenCalledTimes(0);
    expect(ops.publishOffer).toHaveBeenCalledTimes(0);
  });

  it("6) successful mocked create → 1 lease acquire, 1 PUT, 1 offer, 1 publish, 1 atomic reconcile, checked release", async () => {
    const ops = defaultPublishOps();
    const { deps, spies } = mockDeps({ publishOps: () => ops });
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.body.status).toBe("success");
    expect(spies.leaseAcquire).toHaveBeenCalledTimes(1);
    expect(ops.putInventoryItem).toHaveBeenCalledTimes(1);
    expect(ops.createOffer).toHaveBeenCalledTimes(1);
    expect(ops.publishOffer).toHaveBeenCalledTimes(1);
    expect(ops.reconcileLocal).toHaveBeenCalledTimes(1);
    expect(ops.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("7) reconcile → derives SKU from slab, ignores body listing inputs, runs getOffers+getInventoryItem, ZERO provider mutation, local RPC write", async () => {
    const ops = defaultReconcileOps();
    const { deps, spies } = mockDeps({ reconcileOps: () => ops });
    // Body carries BOGUS listing inputs that must be ignored (only slab_id is used).
    const r = await handleReconcile(args({ slab_id: "S1", title: "SHOULD-BE-IGNORED", price_value: 9 }, deps));
    expect(r.body.status).toBe("success");
    expect(r.body.reconciled).toBe(true);
    expect(spies.loadSlabForListing).toHaveBeenCalledTimes(1);
    expect(ops.discoverOffers).toHaveBeenCalledTimes(1);
    expect(ops.fetchInventoryItem).toHaveBeenCalledTimes(1);
    expect(ops.reconcileLocal).toHaveBeenCalledTimes(1);
  });

  it("8) recovery persistence failure → response does NOT falsely claim durable recovery", async () => {
    const ops = defaultPublishOps();
    ops.reconcileLocal = vi.fn(async () => ({ ok: false as const, errorCode: "reconcile_rpc_failed" as const }));
    // Only the recovery marker fails (the inventory_created write still succeeds).
    ops.recordStatus = vi.fn(async (_id: string, status: string) => (status === "published_unmapped" ? { ok: false as const, errorCode: "intent_update_failed" as const } : { ok: true as const }));
    const { deps } = mockDeps({ publishOps: () => ops });
    const r = await handlePublish(args(publishBody(), deps));
    expect(r.body.status).toBe("published_recovery_unpersisted");
    expect(ops.recordApiRun).toHaveBeenCalledWith("publish", "error", "published_unmapped_persist_failed");
  });

  it("P0-1) routeListingWithToken gates the flag BEFORE loading the seller token (zero credential access on a disabled publish)", async () => {
    const off = mockDeps({ flagOn: false });
    const r = await routeListingWithToken("list_item", publishBody(), "ACC", "EBAY_US", "183454", off.deps);
    expect(r.body.status).toBe("mutation_disabled");
    expect(off.spies.loadAccessToken).toHaveBeenCalledTimes(0); // token NEVER loaded
    expect(off.spies.loadSlabForListing).toHaveBeenCalledTimes(0);
    expect(off.spies.makePublishOps).toHaveBeenCalledTimes(0);
    // Enabled → the token IS loaded and the publish proceeds.
    const on = mockDeps({ flagOn: true, publishOps: () => defaultPublishOps() });
    await routeListingWithToken("list_item", publishBody(), "ACC", "EBAY_US", "183454", on.deps);
    expect(on.spies.loadAccessToken).toHaveBeenCalledTimes(1);
  });

  it("9) listing flag is independent + a confirmation phrase cannot bypass it", async () => {
    // Flag ON only for LISTING → publish proceeds past the gate (reaches slab lookup).
    const onlyListing = mockDeps({ flagOn: true });
    await handlePublish(args(publishBody(), onlyListing.deps));
    expect(onlyListing.spies.loadSlabForListing).toHaveBeenCalledTimes(1);
    // Flag OFF → mutation_disabled even WITH confirmation:"PUBLISH".
    const off = mockDeps({ flagOn: false });
    const r = await handlePublish(args(publishBody({ confirmation: "PUBLISH" }), off.deps));
    expect(r.body.status).toBe("mutation_disabled");
  });
});
