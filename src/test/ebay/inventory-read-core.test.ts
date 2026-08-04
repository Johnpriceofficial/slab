import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVENTORY_READ_LIMIT,
  MAX_INVENTORY_READ_LIMIT,
  MAX_OFFERS_PER_SKU,
  parseInventoryReadInput,
  sanitizeInventoryRead,
} from "../../../supabase/functions/_shared/ebay-inventory-read-core";

describe("parseInventoryReadInput", () => {
  it("requires a bounded account_id", () => {
    expect(parseInventoryReadInput({})).toMatchObject({
      ok: false,
      errorCode: "MISSING_ACCOUNT",
    });
    expect(parseInventoryReadInput({ account_id: "x".repeat(65) })).toMatchObject({
      ok: false,
      errorCode: "MISSING_ACCOUNT",
    });
  });

  it("trims account_id and defaults pagination", () => {
    expect(parseInventoryReadInput({ account_id: " account-1 " })).toEqual({
      ok: true,
      input: {
        accountId: "account-1",
        limit: DEFAULT_INVENTORY_READ_LIMIT,
        offset: 0,
      },
    });
  });

  it("accepts bounded integer pagination", () => {
    expect(
      parseInventoryReadInput({
        account_id: "account-1",
        limit: MAX_INVENTORY_READ_LIMIT,
        offset: 250,
      }),
    ).toEqual({
      ok: true,
      input: {
        accountId: "account-1",
        limit: MAX_INVENTORY_READ_LIMIT,
        offset: 250,
      },
    });
  });

  it("rejects invalid limit values", () => {
    for (const limit of [0, MAX_INVENTORY_READ_LIMIT + 1, 1.5, "10"]) {
      expect(parseInventoryReadInput({ account_id: "A", limit })).toMatchObject({
        ok: false,
        errorCode: "INVALID_LIMIT",
      });
    }
  });

  it("rejects invalid offset values", () => {
    for (const offset of [-1, 1.5, "0", 100_001]) {
      expect(parseInventoryReadInput({ account_id: "A", offset })).toMatchObject({
        ok: false,
        errorCode: "INVALID_OFFSET",
      });
    }
  });
});

describe("sanitizeInventoryRead", () => {
  it("allowlists inventory and offer fields", () => {
    const result = sanitizeInventoryRead(
      {
        total: 1,
        inventoryItems: [
{
  sku: "SKU-1",
  condition: "NEW",
  product: { title: "Charizard", subtitle: "ignored" },
  availability: {
    shipToLocationAvailability: { quantity: 3, allocationByFormat: "ignored" },
  },
  refresh_token: "never-copy",
},
        ],
      },
      {
        "SKU-1": {
offers: [
  {
    offerId: "offer-1",
    status: "PUBLISHED",
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    pricingSummary: { price: { value: "12.50", currency: "USD", secret: "x" } },
    listing: { listingId: "listing-1", listingUri: "ignored" },
    access_token: "never-copy",
  },
],
        },
      },
      { limit: 25, offset: 0 },
    );

    expect(result).toEqual({
      items: [
        {
sku: "SKU-1",
title: "Charizard",
condition: "NEW",
qty: 3,
offers: [
  {
    offerId: "offer-1",
    status: "PUBLISHED",
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    price: { value: "12.50", currency: "USD" },
    listingId: "listing-1",
  },
],
        },
      ],
      pagination: { limit: 25, offset: 0, total: 1, size: 1 },
    });
  });

  it("drops unknown and secret-shaped provider fields", () => {
    const result = sanitizeInventoryRead(
      {
        inventoryItems: [
{
  sku: "SKU-1",
  product: { title: "Card" },
  availability: { shipToLocationAvailability: { quantity: "2" } },
  encrypted_credential: "ciphertext-never-copy",
},
        ],
      },
      {
        "SKU-1": {
offers: [
  {
    offerId: "offer-1",
    token: "provider-token-never-copy",
    pricingSummary: { price: { value: 9.99, currency: "USD" } },
  },
],
        },
      },
      { limit: 1, offset: 0 },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("encrypted_credential");
    expect(serialized).not.toContain("ciphertext-never-copy");
    expect(serialized).not.toContain("provider-token-never-copy");
    expect(result.items[0].qty).toBe(2);
    expect(result.items[0].offers[0].price.value).toBe("9.99");
  });

  it("fails safe on malformed provider input", () => {
    expect(sanitizeInventoryRead(null, {}, { limit: 5, offset: 10 })).toEqual({
      items: [],
      pagination: { limit: 5, offset: 10, total: null, size: 0 },
    });
    expect(
      sanitizeInventoryRead(
        { total: "nope", inventoryItems: [null, 7, { sku: "" }] },
        {},
        { limit: 5, offset: 10 },
      ),
    ).toEqual({
      items: [],
      pagination: { limit: 5, offset: 10, total: null, size: 0 },
    });
  });

  it("caps items and offers at the validated bounds", () => {
    const inventoryItems = Array.from(
      { length: MAX_INVENTORY_READ_LIMIT + 2 },
      (_, index) => ({ sku: `SKU-${index}` }),
    );
    const offers = Array.from({ length: MAX_OFFERS_PER_SKU + 2 }, (_, index) => ({
      offerId: `offer-${index}`,
    }));
    const result = sanitizeInventoryRead(
      { inventoryItems },
      { "SKU-0": { offers } },
      { limit: MAX_INVENTORY_READ_LIMIT, offset: 0 },
    );
    expect(result.items).toHaveLength(MAX_INVENTORY_READ_LIMIT);
    expect(result.items[0].offers).toHaveLength(MAX_OFFERS_PER_SKU);
  });
});
