import { describe, it, expect } from "vitest";
import { PriceChartingClient } from "@/lib/pricecharting/client";
import {
  listMarketplaceOffers,
  listSoldMarketplaceOffers,
  getOfferDetails,
  publishOffer,
  markOfferShipped,
  leaveOfferFeedback,
  endOffer,
  refundOffer,
} from "@/lib/pricecharting/marketplace";
import { sanitizeSensitiveData, maskToken } from "@/lib/pricecharting/logger";
import { nullLogger } from "@/lib/pricecharting/logger";
import { createMockFetch, RecordingClock } from "./helpers";

function client(mock: ReturnType<typeof createMockFetch>) {
  return new PriceChartingClient({
    fetch: mock.fetchImpl,
    clock: new RecordingClock(),
    logger: nullLogger,
    tokenProvider: () => "tok-abcdefghijklmnop",
  });
}
function isErr(r: unknown): r is { status: "error"; error_code: string } {
  return (r as { status?: string }).status === "error";
}

describe("marketplace — reads", () => {
  it("lists available offers", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", {
      json: { offers: [{ "offer-id": "o1", "product-name": "Charizard #4", price: 12500, status: "available" }] },
    });
    const r = await listMarketplaceOffers(client(mock), { status: "available" });
    expect(Array.isArray(r)).toBe(true);
    if (Array.isArray(r)) {
      expect(r[0].offer_id).toBe("o1");
      expect(r[0].price_dollars).toBe(125);
    }
  });

  it("lists sold offers with status=sold", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [{ "offer-id": "s1", status: "sold", "sale-price": 5000 }] } });
    await listSoldMarketplaceOffers(client(mock));
    expect(mock.calls.some((c) => c.url.includes("status=sold"))).toBe(true);
  });

  it("rejects an invalid condition-id filter", async () => {
    const mock = createMockFetch();
    const r = await listMarketplaceOffers(client(mock), { "condition-id": 99 });
    expect(isErr(r) && r.error_code).toBe("INVALID_CONDITION");
  });

  it("returns offer details including private buyer data", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offer-details?", {
      json: {
        "offer-id": "o1",
        sold: true,
        "sale-price": 12500,
        "buyer-name": "Jane Doe",
        "buyer-email": "jane@example.com",
        "shipping-address": "123 Main St",
        "tracking-number": "1Z9999W99999999999",
      },
    });
    const r = await getOfferDetails(client(mock), "o1");
    if (!isErr(r)) {
      expect(r.sold).toBe(true);
      expect(r.sale_price_pennies).toBe(12500);
      expect(r.buyer?.email).toBe("jane@example.com");
    }
  });
});

describe("marketplace — writes require confirmation", () => {
  it("publishOffer refuses without confirm: true", async () => {
    const mock = createMockFetch();
    const r = await publishOffer(client(mock), { product: "6910" });
    expect(isErr(r) && r.error_code).toBe("CONFIRMATION_REQUIRED");
    expect(mock.calls).toHaveLength(0);
  });

  it("publishOffer creates a listing when confirmed", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offer-publish?", { json: { status: "success", "offer-id": "new1" } });
    const r = await publishOffer(client(mock), { product: "6910", price_max_dollars: 100, confirm: true });
    if (!isErr(r)) expect(r.offer_id).toBe("new1");
  });

  it("publishOffer rejects a description over 300 characters", async () => {
    const mock = createMockFetch();
    const r = await publishOffer(client(mock), { product: "6910", description: "x".repeat(301), confirm: true });
    expect(isErr(r) && r.error_code).toBe("VALIDATION_ERROR");
  });

  it("publishOffer rejects an invalid condition-id", async () => {
    const mock = createMockFetch();
    const r = await publishOffer(client(mock), { product: "6910", condition_id: 99, confirm: true });
    expect(isErr(r) && r.error_code).toBe("INVALID_CONDITION");
  });

  it("publishOffer rejects a duplicate active SKU", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [{ "offer-id": "existing", sku: "ABC123" }] } });
    const r = await publishOffer(client(mock), { product: "6910", sku: "ABC123", confirm: true });
    expect(isErr(r) && r.error_code).toBe("VALIDATION_ERROR");
  });

  it("publishOffer rejects a non-alphanumeric SKU", async () => {
    const mock = createMockFetch();
    const r = await publishOffer(client(mock), { product: "6910", sku: "ABC-123!", confirm: true });
    expect(isErr(r) && r.error_code).toBe("VALIDATION_ERROR");
  });

  it("publishOffer rejects two product identifiers", async () => {
    const mock = createMockFetch();
    const r = await publishOffer(client(mock), { product: "6910", upc: "045496630348", confirm: true });
    expect(isErr(r) && r.error_code).toBe("INVALID_PARAMETER");
  });

  it("markOfferShipped requires confirm and records tracking", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offer-ship?", { json: { status: "success" } });
    const blocked = await markOfferShipped(client(mock), "o1", "1Z999");
    expect(isErr(blocked) && blocked.error_code).toBe("CONFIRMATION_REQUIRED");

    const mock2 = createMockFetch();
    mock2.enqueue("/api/offer-ship?", { json: { status: "success" } });
    const ok = await markOfferShipped(client(mock2), "o1", "1Z999", true);
    expect(isErr(ok)).toBe(false);
  });

  it("leaveOfferFeedback validates the rating", async () => {
    const mock = createMockFetch();
    // @ts-expect-error deliberately invalid rating for the test
    const r = await leaveOfferFeedback(client(mock), "o1", 5, "great");
    expect(isErr(r) && r.error_code).toBe("INVALID_PARAMETER");
  });

  it("endOffer requires confirmation", async () => {
    const mock = createMockFetch();
    const r = await endOffer(client(mock), "o1", { confirm: false });
    expect(isErr(r) && r.error_code).toBe("CONFIRMATION_REQUIRED");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("marketplace — refunds are doubly guarded", () => {
  it("refuses a refund without confirm_refund", async () => {
    const mock = createMockFetch();
    const r = await refundOffer(client(mock), "o1", { confirm_refund: false });
    expect(isErr(r) && r.error_code).toBe("CONFIRMATION_REQUIRED");
    expect(mock.calls).toHaveLength(0); // never even contacts the API
  });

  it("maps an already-refunded response to OFFER_ALREADY_REFUNDED (no retry)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offer-refund?", { json: { status: "error", "error-message": "Offer already refunded" } });
    const r = await refundOffer(client(mock), "o1", { confirm_refund: true });
    expect(isErr(r) && r.error_code).toBe("OFFER_ALREADY_REFUNDED");
    expect(mock.calls).toHaveLength(1); // permanent error, single attempt
  });

  it("processes a confirmed refund", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offer-refund?", { json: { status: "success" } });
    const r = await refundOffer(client(mock), "o1", { confirm_refund: true });
    expect(isErr(r)).toBe(false);
  });
});

describe("privacy — sensitive data masking", () => {
  it("masks tokens, buyer email, address, and tracking numbers", () => {
    const masked = sanitizeSensitiveData({
      t: "supersecrettoken1234567890",
      buyer_email: "jane@example.com",
      shipping_address: "123 Main Street",
      tracking_number: "1Z9999W99999999999",
      product_name: "Charizard #4",
    }) as Record<string, string>;
    expect(masked.t).not.toContain("supersecrettoken");
    expect(masked.buyer_email).toBe("j***@example.com");
    expect(masked.tracking_number).toMatch(/\*/);
    // Non-sensitive fields pass through.
    expect(masked.product_name).toBe("Charizard #4");
  });

  it("maskToken keeps only a short prefix/suffix", () => {
    const t = maskToken("abcd1234567890wxyz");
    expect(t.startsWith("abcd")).toBe(true);
    expect(t.endsWith("wxyz")).toBe(true);
    expect(t).toContain("*");
  });
});
