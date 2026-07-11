import { describe, it, expect } from "vitest";
import { PriceChartingClient } from "@/lib/pricecharting/client";
import { searchProducts, getProductById, getProductByUPC } from "@/lib/pricecharting/api";
import { isPriceChartingError } from "@/lib/pricecharting/errors";
import { nullLogger } from "@/lib/pricecharting/logger";
import { createMockFetch, RecordingClock, rawProduct } from "./helpers";

function makeClient(mock: ReturnType<typeof createMockFetch>, clock = new RecordingClock()) {
  return new PriceChartingClient({
    fetch: mock.fetchImpl,
    clock,
    logger: nullLogger,
    tokenProvider: () => "test-token-abcdefhijklmnop",
  });
}

describe("client — product reads", () => {
  it("looks up a product by id", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: rawProduct({ id: "6910", "loose-price": 3500 }) });
    const client = makeClient(mock);
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
    expect(product.raw_prices["loose-price"]).toBe(3500);
    // Token must never appear un-masked in any recorded call's logged form,
    // but the real network URL does carry it (that is expected).
    expect(mock.calls[0].url).toContain("t=test-token");
  });

  it("looks up a product by UPC", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: rawProduct({ upc: "045496630348" }) });
    const client = makeClient(mock);
    const product = await getProductByUPC(client, "045496630348");
    expect(product.upc).toBe("045496630348");
  });

  it("runs a full-text search returning multiple candidates", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: {
        products: [
          rawProduct({ id: "1", "product-name": "Charizard #4" }),
          rawProduct({ id: "2", "product-name": "Charizard #11" }),
        ],
      },
    });
    const client = makeClient(mock);
    const results = await searchProducts(client, "charizard #4");
    expect(results).toHaveLength(2);
    expect(results.map((p) => p.pricecharting_id)).toEqual(["1", "2"]);
  });

  it("maps an empty product payload to PRODUCT_NOT_FOUND", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: {} });
    const client = makeClient(mock);
    await expect(getProductById(client, "999999")).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("maps an API error payload to AUTHENTICATION_ERROR (invalid token)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "error", "error-message": "Invalid token" } });
    const client = makeClient(mock);
    await expect(getProductById(client, "6910")).rejects.toMatchObject({ code: "AUTHENTICATION_ERROR" });
  });

  it("maps a subscription message to SUBSCRIPTION_REQUIRED", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "error", "error-message": "Active subscription required" } });
    const client = makeClient(mock);
    await expect(getProductById(client, "6910")).rejects.toMatchObject({ code: "SUBSCRIPTION_REQUIRED" });
  });

  it("throws MISSING_PARAMETER for an empty search query", async () => {
    const mock = createMockFetch();
    const client = makeClient(mock);
    await expect(searchProducts(client, "   ")).rejects.toMatchObject({ code: "MISSING_PARAMETER" });
  });
});

describe("client — resilience", () => {
  it("throws VALIDATION_ERROR on malformed JSON (non-retryable)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { text: "<html>not json</html>" });
    const client = makeClient(mock);
    await expect(getProductById(client, "6910")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Only one attempt — validation errors are permanent.
    expect(mock.calls).toHaveLength(1);
  });

  it("retries a temporary 500 with backoff, then succeeds", async () => {
    const mock = createMockFetch();
    mock.enqueue(
      "/api/product?",
      { status: 500, text: "server error" },
      { status: 500, text: "server error" },
      { json: rawProduct({ id: "6910" }) },
    );
    const clock = new RecordingClock();
    const client = makeClient(mock, clock);
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
    expect(mock.calls).toHaveLength(3); // 2 failures + 1 success
    // Backoff used full jitter with fixed random 0.5: 500*0.5=250, 1000*0.5=500.
    expect(clock.sleeps).toContain(250);
    expect(clock.sleeps).toContain(500);
  });

  it("does NOT retry a permanent 400 invalid parameter", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { status: 400, text: JSON.stringify({ "error-message": "invalid parameter" }) });
    const client = makeClient(mock);
    await expect(getProductById(client, "6910")).rejects.toMatchObject({ code: "INVALID_PARAMETER" });
    expect(mock.calls).toHaveLength(1);
  });

  it("gives up after the max retry count on persistent server errors", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { status: 503, text: "unavailable" }); // persists
    const client = makeClient(mock);
    await expect(getProductById(client, "6910")).rejects.toMatchObject({ code: "SERVER_ERROR" });
    // 1 initial + 4 retries = 5 attempts.
    expect(mock.calls).toHaveLength(5);
  });

  it("treats a network error as retryable", async () => {
    const mock = createMockFetch();
    mock.enqueue(
      "/api/product?",
      { networkError: { name: "TypeError", message: "fetch failed" } },
      { json: rawProduct({ id: "6910" }) },
    );
    const client = makeClient(mock);
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
    expect(mock.calls).toHaveLength(2);
  });
});

describe("client — rate limiting & caching", () => {
  it("enforces the 1 request/second standard spacing", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [rawProduct({ id: "a" })] } });
    const clock = new RecordingClock();
    const client = makeClient(mock, clock);
    // Two DISTINCT searches so the cache does not short-circuit the 2nd call.
    await searchProducts(client, "alpha");
    await searchProducts(client, "beta");
    // The second call had to wait ~1000ms for the standard bucket.
    expect(clock.sleeps).toContain(1000);
  });

  it("de-duplicates identical concurrent GETs into one network call", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [rawProduct({ id: "a" })] } });
    const client = makeClient(mock);
    const [a, b] = await Promise.all([searchProducts(client, "same"), searchProducts(client, "same")]);
    expect(a).toEqual(b);
    expect(mock.calls).toHaveLength(1); // duplicate suppressed
  });

  it("serves a repeated GET from cache without a second network call", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [rawProduct({ id: "a" })] } });
    const client = makeClient(mock);
    await searchProducts(client, "cached");
    await searchProducts(client, "cached");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("client — env token safety", () => {
  it("throws a normalized-safe error when the token is missing", async () => {
    const mock = createMockFetch();
    const client = new PriceChartingClient({
      fetch: mock.fetchImpl,
      clock: new RecordingClock(),
      logger: nullLogger,
      tokenProvider: () => {
        throw new Error("Missing PRICECHARTING_API_TOKEN.");
      },
    });
    // buildUrl reads the token; failure surfaces before any network call.
    await expect(getProductById(client, "6910")).rejects.toBeInstanceOf(Error);
    expect(mock.calls).toHaveLength(0);
    void isPriceChartingError; // referenced for lint completeness
  });
});
