import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import { createMockFetch, RecordingClock } from "../pricecharting/helpers";

const TOKEN = "SECRET-pricecharting-token-DO-NOT-LEAK-1234567890";

function deps(mock: ReturnType<typeof createMockFetch>): HandlerDeps {
  return { fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => TOKEN };
}

describe("handler — offer_image (seller listing photo for visual confirmation)", () => {
  it("returns the first available seller photo (absolute URL) and the listing count", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", {
      json: {
        offers: [
          { "offer-id": "o1", status: "available", price: 6995, "image-url": "https://storage.googleapis.com/images.pricecharting.com/abc/240.jpg" },
          { "offer-id": "o2", status: "available", price: 7100 },
        ],
      },
    });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "6910" }, deps(mock));
    expect(res.statusCode).toBe(200);
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBe("https://storage.googleapis.com/images.pricecharting.com/abc/240.jpg");
      expect(res.body.offer_listing_count).toBe(2);
      // The label must make clear this is not proof of identity.
      expect(res.body.warnings[0]).toMatch(/not proof this is your exact card/i);
    } else {
      throw new Error("expected an offer_image success body");
    }
  });

  it("absolute-izes a site-relative image-url against the PriceCharting host", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", {
      json: { offers: [{ "offer-id": "o1", status: "available", "image-url": "/offer-images/x.jpg" }] },
    });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "6910" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBe("https://www.pricecharting.com/offer-images/x.jpg");
    } else {
      throw new Error("expected an offer_image success body");
    }
  });

  it("returns a null image (NOT an error) when offers exist but none carry a photo", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [{ "offer-id": "o1", status: "available", price: 6995 }] } });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "6910" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBeNull();
      expect(res.body.offer_listing_count).toBe(1);
    } else {
      throw new Error("expected an offer_image success body");
    }
  });

  it("returns null image + zero count when nobody is selling the product (the common case)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "6910" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBeNull();
      expect(res.body.offer_listing_count).toBe(0);
    } else {
      throw new Error("expected an offer_image success body");
    }
  });

  it("does not scrape a product page when Marketplace API offers have no photo", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "11302479" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBeNull();
      expect(res.body.image_source).toBe("none");
      expect(res.body.warnings.join(" ")).toMatch(/No independent reference artwork/i);
    } else {
      throw new Error("expected offer_image success body");
    }
  });

  it("400s when product_id is missing", async () => {
    const mock = createMockFetch();
    const res = await handlePriceChartingRequest({ action: "offer_image" }, deps(mock));
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("error");
    expect(mock.calls.length).toBe(0); // never contacted PriceCharting
  });
});
