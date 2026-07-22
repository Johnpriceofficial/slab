import { describe, it, expect } from "vitest";
import { fetchAllOffersForSku, validateOfferForSku, type OffersFetchImpl } from "../../../supabase/functions/_shared/ebay-offers";

const O = "https://api.ebay.com";
const SKU = "GCV000047";

const goodOffer = (over: Record<string, unknown> = {}) => ({
  offerId: "O1", sku: SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE",
  categoryId: "183454", merchantLocationKey: "LOC-A",
  listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" },
  pricingSummary: { price: { value: 199.99, currency: "USD" } }, availableQuantity: 1, listingDescription: "x", ...over,
});

// Discovery of a single-page response carrying `offers`; total defaults sensibly.
function discover(offers: unknown[], total = offers.length) {
  const impl: OffersFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ offers, total, size: offers.length }) });
  return fetchAllOffersForSku({ fetchImpl: impl, apiOrigin: O, accessToken: "AT", sku: SKU });
}

describe("validateOfferForSku — strict per-offer contract", () => {
  it("accepts a fully valid canonical-SKU offer (published or not)", () => {
    expect(validateOfferForSku(goodOffer(), SKU)).toBe(true);
    expect(validateOfferForSku(goodOffer({ listing: { listingId: "L1", listingOnHold: false } }), SKU)).toBe(true);
    expect(validateOfferForSku(goodOffer({ pricingSummary: { price: { value: "150.00", currency: "USD" } } }), SKU)).toBe(true);
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ["missing SKU", { sku: undefined }],
    ["empty SKU", { sku: "" }],
    ["wrong SKU", { sku: "GCV000099" }],
    ["missing marketplace", { marketplaceId: undefined }],
    ["malformed format", { format: 5 }],
    ["missing category", { categoryId: "" }],
    ["missing location", { merchantLocationKey: undefined }],
    ["malformed policies", { listingPolicies: "nope" }],
    ["missing fulfillment id", { listingPolicies: { paymentPolicyId: "P1", returnPolicyId: "R1" } }],
    ["missing payment id", { listingPolicies: { fulfillmentPolicyId: "F1", returnPolicyId: "R1" } }],
    ["missing return id", { listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1" } }],
    ["malformed price object", { pricingSummary: { price: "nope" } }],
    ["negative price", { pricingSummary: { price: { value: -1, currency: "USD" } } }],
    ["malformed currency", { pricingSummary: { price: { value: 1, currency: "" } } }],
    ["negative quantity", { availableQuantity: -1 }],
    ["fractional quantity", { availableQuantity: 1.5 }],
    ["missing quantity", { availableQuantity: undefined }],
    ["missing listingDescription", { listingDescription: undefined }],
    ["malformed listing object", { listing: "nope" }],
    ["malformed listingId", { listing: { listingId: { x: 1 } } }],
    ["malformed listingOnHold", { listing: { listingOnHold: "yes" } }],
  ];
  for (const [name, over] of bad) {
    it(`rejects: ${name}`, () => expect(validateOfferForSku(goodOffer(over), SKU)).toBe(false));
  }
  it("rejects a non-object", () => { expect(validateOfferForSku(null, SKU)).toBe(false); expect(validateOfferForSku([], SKU)).toBe(false); });
});

describe("fetchAllOffersForSku — a malformed/wrong-SKU offer fails the whole response closed", () => {
  it("a valid single offer → ok with that offer", async () => {
    const r = await discover([goodOffer()]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.offers.map((o) => o.offerId)).toEqual(["O1"]);
  });
  for (const [name, over] of [
    ["wrong SKU", { sku: "GCV000099" }],
    ["missing marketplace", { marketplaceId: undefined }],
    ["missing policy ids", { listingPolicies: {} }],
    ["negative price", { pricingSummary: { price: { value: -1, currency: "USD" } } }],
    ["fractional quantity", { availableQuantity: 2.5 }],
    ["missing listingDescription", { listingDescription: undefined }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`invalid_provider_response: ${name}`, async () => {
      const r = await discover([goodOffer(over)], 1);
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.errorCode).toBe("invalid_provider_response");
    });
  }
  it("total>0 with a wrong-SKU offer NEVER authorizes create — it is invalid_provider_response", async () => {
    const r = await discover([goodOffer({ sku: "GCV000099" })], 3);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errorCode).toBe("invalid_provider_response");
  });
});
