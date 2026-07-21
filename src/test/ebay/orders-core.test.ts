import { describe, it, expect } from "vitest";
import {
  moneyCents,
  shapeEbayOrders,
  skusFromOrders,
  shapeEbayFinanceTransactions,
} from "../../../supabase/functions/_shared/ebay-orders-core";

describe("moneyCents", () => {
  it("parses eBay money objects to integer cents and rejects non-money", () => {
    expect(moneyCents({ value: "12.34", currency: "USD" })).toBe(1234);
    expect(moneyCents({ value: "0", currency: "USD" })).toBe(0);
    expect(moneyCents(null)).toBeNull();
    expect(moneyCents("12.34")).toBeNull();
    expect(moneyCents({ currency: "USD" })).toBeNull(); // no numeric value
  });
});

const ORDERS = [
  {
    orderId: "ORD-1",
    orderFulfillmentStatus: "FULFILLED",
    creationDate: "2026-07-20T10:00:00.000Z",
    buyer: { username: "buyer1" },
    pricingSummary: { total: { value: "20.00", currency: "USD" } },
    lineItems: [
      { lineItemId: "LI-1", sku: "GCV000047", legacyItemId: "111", quantity: 1, lineItemCost: { value: "18.00", currency: "USD" } },
      { lineItemId: "LI-2", sku: "UNMAPPED", quantity: 1, lineItemCost: { value: "2.00", currency: "USD" } },
    ],
  },
  {
    orderId: "ORD-2",
    orderPaymentStatus: "PAID",
    lineItems: [{ lineItemId: "LI-3", sku: "GCV000048" }], // mapped but no price → not a proposed sale
  },
  { orderId: "", lineItems: [{ lineItemId: "X", sku: "Y" }] }, // dropped: no orderId
];

describe("skusFromOrders", () => {
  it("returns the distinct non-empty SKUs across all line items", () => {
    expect(skusFromOrders(ORDERS).sort()).toEqual(["GCV000047", "GCV000048", "UNMAPPED", "Y"].sort());
    expect(skusFromOrders(null)).toEqual([]);
  });
});

describe("shapeEbayOrders", () => {
  const mapping = new Map<string, string>([
    ["GCV000047", "slab-uuid-47"],
    ["GCV000048", "slab-uuid-48"],
  ]);

  it("shapes orders, resolves slab mappings, and proposes ONLY mapped+priced line items", () => {
    const { shaped, proposed_sales, order_count, line_item_count } = shapeEbayOrders(ORDERS, mapping);
    expect(order_count).toBe(2); // empty-orderId order dropped
    expect(line_item_count).toBe(3);

    // Exactly one proposed sale: GCV000047 (mapped AND priced). GCV000048 is
    // mapped but unpriced; UNMAPPED is priced but not ours.
    expect(proposed_sales).toEqual([
      { order_id: "ORD-1", line_item_id: "LI-1", slab_id: "slab-uuid-47", sku: "GCV000047", sold_price_cents: 1800, currency: "USD" },
    ]);

    const li1 = shaped[0].line_items[0];
    expect(li1).toMatchObject({ slab_id: "slab-uuid-47", sold_price_cents: 1800, currency: "USD", external_sale_id: "ORD-1:LI-1", listing_id: "111", sold_at: "2026-07-20T10:00:00.000Z" });
    const li2 = shaped[0].line_items[1];
    expect(li2.slab_id).toBeNull(); // UNMAPPED sku → not ours
    expect(shaped[0].order_status).toBe("FULFILLED");
    expect(shaped[1].order_status).toBe("PAID");
    expect(shaped[1].line_items[0].sold_price_cents).toBeNull(); // no lineItemCost
  });

  it("marks nothing sold when no SKU maps to a slab", () => {
    const { proposed_sales } = shapeEbayOrders(ORDERS, new Map());
    expect(proposed_sales).toEqual([]);
  });

  it("skips line items with no lineItemId and orders with no orderId", () => {
    const { shaped, line_item_count } = shapeEbayOrders(
      [{ orderId: "O", lineItems: [{ sku: "S", lineItemCost: { value: "1.00" } }, { lineItemId: "OK", sku: "S2" }] }],
      new Map(),
    );
    expect(line_item_count).toBe(1); // the no-lineItemId one is dropped
    expect(shaped[0].line_items[0].line_item_id).toBe("OK");
  });
});

describe("shapeEbayFinanceTransactions", () => {
  it("shapes transactions, preserves raw, and drops rows with no transactionId", () => {
    const shaped = shapeEbayFinanceTransactions([
      { transactionId: "TX-1", orderId: "ORD-1", transactionType: "SALE", transactionStatus: "FUNDS_AVAILABLE", amount: { value: "18.00", currency: "USD" }, totalFeeBasisAmount: { value: "18.00" }, transactionDate: "2026-07-20T11:00:00.000Z" },
      { transactionType: "REFUND" }, // no transactionId → dropped
      { transactionId: "TX-3" }, // minimal → defaults
    ]);
    expect(shaped).toHaveLength(2);
    expect(shaped[0]).toMatchObject({ transaction_id: "TX-1", order_id: "ORD-1", transaction_type: "SALE", transaction_status: "FUNDS_AVAILABLE", occurred_at: "2026-07-20T11:00:00.000Z" });
    expect(shaped[0].amount).toEqual({ value: "18.00", currency: "USD" });
    expect(shaped[0].raw_response.transactionId).toBe("TX-1"); // raw preserved
    expect(shaped[1]).toMatchObject({ transaction_id: "TX-3", order_id: null, transaction_type: "UNKNOWN", transaction_status: "UNKNOWN", amount: null, occurred_at: null });
  });
});
