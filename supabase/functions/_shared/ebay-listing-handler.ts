// The REAL listing request-handling / authorization-gating / executor-binding for
// the `list_item` (PUBLISH) and `revise_item?action=reconcile` operations, behind
// INJECTED domain dependencies. This is the actual routing+binding the deployed
// Edge handler (handleEbay in ebay.ts) delegates to — extracted here, free of Deno
// globals and `npm:` imports, so the exact adapter is executable in tests with
// mocked dependencies (src/test/ebay/handler-adapter.test.ts). handleEbay is a thin
// wrapper: it builds realDeps() and calls handleListingOperation.

import { canonicalSkuFromInventoryNumber, hasFrontImage, orderedImagePaths } from "./ebay-listing-core.ts";
import { buildImageManifest, buildIntendedState, canonicalListingFingerprint, EBAY_TITLE_MAX, type ImageRole, LISTING_FINGERPRINT_VERSION, MAX_QUANTITY } from "./ebay-intended-state.ts";
import { type ExecResult, executePublish, executeReconcile, type PublishExecutorOps, type ReconcileOps } from "./ebay-publish-executor.ts";
import { EBAY_MUTATION_FLAGS } from "./ebay-mutation-flags.ts";

export interface ListingIntentBinding {
  accountId: string; slabId: string; sku: string; currency: string;
  priceCents: number; leaseToken: string; accessToken: string;
  inventoryPayload: unknown; offerPayload: unknown;
}
export interface ReconcileBinding { accountId: string; slabId: string; sku: string; currency: string; accessToken: string }

export interface ListingDeps {
  flagEnabled: (name: string) => boolean;
  loadAccessToken: (accountId: string) => Promise<{ ok: true; token: string } | { ok: false }>;
  loadSlabForListing: (slabId: string) => Promise<{ ok: true; slab: { inventoryNumber: number; frontImagePath: string | null; backImagePath: string | null } | null } | { ok: false }>;
  verifyListingOwnership: (a: { accountId: string; marketplaceId: string; merchantLocationKey: string; fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string }) => Promise<{ ok: true } | { ok: false; errorCode: string; httpStatus: number }>;
  signImageUrl: (path: string) => Promise<string | null>;
  hashImage: (path: string) => Promise<string | null>;
  leaseAcquire: (accountId: string, sku: string, token: string) => Promise<{ acquired: boolean; error: boolean }>;
  makePublishOps: (b: ListingIntentBinding) => PublishExecutorOps;
  makeReconcileOps: (b: ReconcileBinding) => ReconcileOps;
  uuid: () => string;
}

export interface HandlerResponse { body: Record<string, unknown>; httpStatus: number }
const resp = (body: Record<string, unknown>, httpStatus: number): HandlerResponse => ({ body, httpStatus });
const err = (errorCode: string, httpStatus: number, message?: string): HandlerResponse => resp({ status: "error", error_code: errorCode, ...(message ? { message } : {}) }, httpStatus);

// Map an executor result to a response body (snake_case fields the UI expects).
export function execBody(r: ExecResult): Record<string, unknown> {
  const b: Record<string, unknown> = { status: r.status };
  if (r.errorCode) b.error_code = r.errorCode;
  if (r.offerId) b.offer_id = r.offerId;
  if (r.listingId !== undefined && r.listingId !== null) b.listing_id = r.listingId;
  if (r.offerIds) b.offer_ids = r.offerIds;
  if (r.imageEvidence) b.image_evidence = r.imageEvidence;
  if (r.verificationMethod) b.verification_method = r.verificationMethod;
  if (r.reconciled) b.reconciled = r.reconciled;
  if (r.context) b.context = r.context;
  if (r.message) b.message = r.message;
  if (r.diagnosticUnpersisted) b.diagnostic_unpersisted = true;
  if (r.status === "success") b.listing_status = "published";
  return b;
}

export interface ListingHandlerArgs {
  body: Record<string, unknown>;
  accountId: string;
  accessToken: string;
  marketplaceId: string;
  categoryId: string;
  deps: ListingDeps;
}

/**
 * Route a listing operation, GATING the listing-mutation flag for list_item
 * PUBLISH BEFORE the seller access token is loaded/refreshed. A disabled publish
 * therefore makes ZERO OAuth token requests, zero credential access, zero provider
 * calls, and zero writes — and a confirmation phrase cannot bypass it. This is the
 * SAME routing the deployed handler delegates to (handleEbay is a thin wrapper).
 */
export async function routeListingWithToken(operation: "list_item" | "reconcile", body: Record<string, unknown>, accountId: string, marketplaceId: string, categoryId: string, deps: ListingDeps): Promise<HandlerResponse> {
  if (operation === "list_item" && !deps.flagEnabled(EBAY_MUTATION_FLAGS.listing)) {
    // Gate BEFORE the token — no credential access on a disabled publish.
    return resp({ status: "mutation_disabled", operation: "list_item", kind: "listing", message: "eBay listing mutations are disabled by server configuration." }, 403);
  }
  const tok = await deps.loadAccessToken(accountId);
  if (tok.ok === false) return resp({ status: "unavailable", operation, capability: "Connected eBay account", message: "eBay is not connected or the seller token could not be loaded." }, 503);
  const args = { body, accountId, accessToken: tok.token, marketplaceId, categoryId, deps };
  return operation === "list_item" ? handlePublish(args) : handleReconcile(args);
}

/** list_item PUBLISH: gate on the listing flag, validate, derive the canonical SKU,
 *  verify ownership, build the durable manifest + intended state + fingerprint,
 *  acquire the single-flight lease, then run the injected-ops executor. */
export async function handlePublish(args: ListingHandlerArgs): Promise<HandlerResponse> {
  const { body, accountId, accessToken, marketplaceId, categoryId, deps } = args;
  // A confirmation phrase can NEVER bypass a disabled server flag.
  if (!deps.flagEnabled(EBAY_MUTATION_FLAGS.listing)) return resp({ status: "mutation_disabled", operation: "list_item", kind: "listing", message: "eBay listing mutations are disabled by server configuration." }, 403);

  const slabId = String(body.slab_id ?? "");
  const clientSku = String(body.sku ?? "");
  const merchantLocationKey = String(body.merchant_location_key ?? "");
  const fulfillmentPolicyId = String(body.fulfillment_policy_id ?? "");
  const paymentPolicyId = String(body.payment_policy_id ?? "");
  const returnPolicyId = String(body.return_policy_id ?? "");
  const priceValue = Number(body.price_value);
  const currency = String(body.currency ?? "USD");
  const condition = String(body.condition ?? "").trim();
  const title = String(body.title ?? "").trim();
  const description = String(body.description ?? "").trim();
  const quantity = body.quantity === undefined ? 1 : Number(body.quantity);
  if (!slabId || !categoryId || !merchantLocationKey || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !condition || !title || title.length > EBAY_TITLE_MAX || !description || currency !== "USD" || !Number.isFinite(priceValue) || priceValue <= 0) {
    return err("INCOMPLETE_LISTING", 400, "Slab, category, location, all three policies, a non-empty condition, a 1–80 char title, a description, USD currency, and a positive price are all required.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return err("invalid_quantity", 400, `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`);

  const slabRes = await deps.loadSlabForListing(slabId);
  if (!slabRes.ok) return err("slab_lookup_failed", 500);
  if (!slabRes.slab) return err("slab_not_found", 404);
  const { inventoryNumber, frontImagePath, backImagePath } = slabRes.slab;
  if (!Number.isFinite(inventoryNumber)) return err("slab_missing_inventory_number", 500);
  const sku = canonicalSkuFromInventoryNumber(inventoryNumber);
  if (clientSku && clientSku !== sku) return err("canonical_sku_mismatch", 400, "The submitted SKU does not match the slab's canonical SKU.");
  if (!hasFrontImage(frontImagePath)) return err("front_image_required", 400, "A front image is required before publishing to eBay.");

  const own = await deps.verifyListingOwnership({ accountId, marketplaceId, merchantLocationKey, fulfillmentPolicyId, paymentPolicyId, returnPolicyId });
  if (own.ok === false) return err(own.errorCode, own.httpStatus);

  // Signed URLs for the eBay PUT + stable byte hashes for the DURABLE manifest.
  const orderedPaths = orderedImagePaths(frontImagePath, backImagePath);
  const imageUrls: string[] = [];
  const manifestImages: Array<{ role: ImageRole; path: string; sha256: string }> = [];
  const imageRoles: ImageRole[] = ["front", "back"];
  for (let i = 0; i < orderedPaths.length; i++) {
    const path = orderedPaths[i];
    const signedUrl = await deps.signImageUrl(path);
    if (!signedUrl) return err("image_url_generation_failed", 502, "Could not generate a signed image URL for the listing.");
    imageUrls.push(signedUrl);
    const sha256 = await deps.hashImage(path);
    if (!sha256) return err("image_manifest_failed", 502, "Could not read a listing image to build its durable manifest.");
    manifestImages.push({ role: imageRoles[i] ?? "back", path, sha256 });
  }
  if (imageUrls.length === 0) return err("front_image_required", 400);
  const manifest = buildImageManifest(manifestImages);
  if (!manifest) return err("image_manifest_failed", 500);

  const conditionDescription = String(body.condition_description ?? "");
  const aspects = (body.aspects && typeof body.aspects === "object" ? body.aspects : {}) as Record<string, unknown>;
  const intendedState = buildIntendedState({
    sku, marketplaceId, categoryId, merchantLocationKey, fulfillmentPolicyId, paymentPolicyId, returnPolicyId,
    price: priceValue, currency, availableQuantity: quantity, listingDescription: description,
    title, description, condition, conditionDescription, conditionDescriptors: [], aspects,
  });
  if (!intendedState) return err("INCOMPLETE_LISTING", 400, "The listing inputs are not complete/canonical.");
  const fingerprint = await canonicalListingFingerprint(intendedState, manifest);

  // RACE-SAFE single-flight lease (the executor releases it on every path).
  const leaseToken = deps.uuid();
  const acq = await deps.leaseAcquire(accountId, sku, leaseToken);
  if (acq.error) return err("lease_acquire_failed", 500);
  if (!acq.acquired) return resp({ status: "publish_in_progress", message: "Another publish for this SKU is already in progress." }, 409);

  const inventoryPayload = { availability: { shipToLocationAvailability: { quantity } }, condition, conditionDescription: conditionDescription || undefined, product: { title, description, aspects, imageUrls } };
  const offerPayload = { sku, marketplaceId, format: "FIXED_PRICE", availableQuantity: quantity, categoryId, merchantLocationKey, listingDescription: description, pricingSummary: { price: { currency, value: priceValue.toFixed(2) } }, listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId } };
  const ops = deps.makePublishOps({ accountId, slabId, sku, currency, priceCents: Math.round(priceValue * 100), leaseToken, accessToken, inventoryPayload, offerPayload });
  const result = await executePublish(ops, { intended: intendedState, manifest, fingerprint, fingerprintVersion: LISTING_FINGERPRINT_VERSION });
  return resp(execBody(result), result.httpStatus);
}

/** revise_item?action=reconcile: derive the canonical SKU, ignore request-body
 *  listing inputs, and run the SAME engine over the VERIFIED durable snapshot. */
export async function handleReconcile(args: ListingHandlerArgs): Promise<HandlerResponse> {
  const { body, accountId, accessToken, deps } = args;
  const slabId = String(body.slab_id ?? "");
  const clientSku = String(body.sku ?? "");
  if (!slabId) return err("MISSING_SLAB", 400, "slab_id is required to reconcile.");
  const slabRes = await deps.loadSlabForListing(slabId);
  if (!slabRes.ok) return err("slab_lookup_failed", 500);
  if (!slabRes.slab) return err("slab_not_found", 404);
  if (!Number.isFinite(slabRes.slab.inventoryNumber)) return err("slab_missing_inventory_number", 500);
  const sku = canonicalSkuFromInventoryNumber(slabRes.slab.inventoryNumber);
  if (clientSku && clientSku !== sku) return err("canonical_sku_mismatch", 400);
  const reconcileOps = deps.makeReconcileOps({ accountId, slabId, sku, currency: String(body.currency ?? "USD"), accessToken });
  const result = await executeReconcile(reconcileOps);
  return resp(execBody(result), result.httpStatus);
}
