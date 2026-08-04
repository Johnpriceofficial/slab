import { describe, it, expect } from "vitest";
import {
  MAX_LISTING_FEE_OFFERS,
  parseListingFeesInput,
  sanitizeListingFees,
} from "../../../supabase/functions/_shared/ebay-listing-fees-core";

describe("parseListingFeesInput", () => {
  it("requires account_id", () => {
    expect(parseListingFeesInput({ offer_ids: ["1"] })).toMatchObject({
      ok: false,
      errorCode: "MISSING_ACCOUNT",
    });
  });

  it("requires a non-empty offer_ids array", () => {
    expect(parseListingFeesInput({ account_id: "A" })).toMatchObject({
      ok: false,
      errorCode: "MISSING_OFFER_IDS",
    });
    expect(parseListingFeesInput({ account_id: "A", offer_ids: [] })).toMatchObject({
      ok: false,
      errorCode: "MISSING_OFFER_IDS",
    });
    expect(parseListingFeesInput({ account_id: "A", offer_ids: ["", "   "] })).toMatchObject({
      ok: false,
      errorCode: "MISSING_OFFER_IDS",
    });
  });

  it("trims and de-duplicates offer ids", () => {
    expect(parseListingFeesInput({ account_id: " A ", offer_ids: [" o1 ", "o1", "o2"] })).toEqual({
      ok: true,
      input: { accountId: "A", offerIds: ["o1", "o2"] },
    });
  });

  it("caps the number of offer ids", () => {
    const ids = Array.from({ length: MAX_LISTING_FEE_OFFERS + 1 }, (_, i) => `o${i}`);
    expect(parseListingFeesInput({ account_id: "A", offer_ids: ids })).toMatchObject({
      ok: false,
      errorCode: "TOO_MANY_OFFER_IDS",
    });
  });

  it("drops oversized ids rather than trusting unbounded input", () => {
    expect(
      parseListingFeesInput({ account_id: "A", offer_ids: ["x".repeat(65), "ok"] }),
    ).toEqual({ ok: true, input: { accountId: "A", offerIds: ["ok"] } });
  });
});

describe("sanitizeListingFees", () => {
  it("allowlists only the known fee fields", () => {
    const raw = {
      feeSummaries: [
        {
          offerId: "o1",
          marketplaceId: "EBAY_US",
          fees: [{ feeType: "INSERTION", amount: { value: "0.35", currency: "USD" } }],
        },
      ],
    };
    expect(sanitizeListingFees(raw)).toEqual({
      feeSummaries: [
        {
          offerId: "o1",
          marketplaceId: "EBAY_US",
          fees: [{ feeType: "INSERTION", amount: { value: "0.35", currency: "USD" } }],
        },
      ],
    });
  });

  it("drops unexpected and secret-shaped provider fields", () => {
    const raw = {
      extra: "ignored",
      feeSummaries: [
        {
          offerId: "o1",
          marketplaceId: "EBAY_US",
          refresh_token: "should-never-be-copied",
          fees: [{ feeType: "FVF", amount: { value: "1.00", currency: "USD" }, secret: "x" }],
        },
      ],
    };
    const out = sanitizeListingFees(raw);
    const serialized = JSON.stringify(out);
    // Pure allowlisting: unknown keys (and their values) are never copied.
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("should-never-be-copied");
    expect(serialized).not.toContain("secret");
    expect(out.feeSummaries[0].fees[0]).toEqual({
      feeType: "FVF",
      amount: { value: "1.00", currency: "USD" },
    });
  });

  it("fails safe on malformed input", () => {
    expect(sanitizeListingFees(null)).toEqual({ feeSummaries: [] });
    expect(sanitizeListingFees({})).toEqual({ feeSummaries: [] });
    expect(sanitizeListingFees({ feeSummaries: "nope" })).toEqual({ feeSummaries: [] });
    expect(sanitizeListingFees({ feeSummaries: [null, 3, "x"] })).toEqual({ feeSummaries: [] });
  });
});
