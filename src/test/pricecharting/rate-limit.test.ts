/**
 * Durable rate-limit hook. The DB spacing algorithm (reserve_api_request_slot)
 * is proven by the live integration test in Phase 10; here we prove the client
 * contract: the injected `beforeRequest` reserver is awaited before EVERY
 * network attempt, so retries reserve fresh slots too.
 */

import { describe, it, expect } from "vitest";
import { PriceChartingClient } from "@/lib/pricecharting/client";
import { getProductById } from "@/lib/pricecharting/api";
import { nullLogger } from "@/lib/pricecharting/logger";
import { createMockFetch, RecordingClock, rawProduct } from "./helpers";

describe("durable rate-limit reserver hook", () => {
  it("reserves a slot before the request", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: rawProduct({ id: "6910" }) });
    const reserved: string[] = [];
    const client = new PriceChartingClient({
      fetch: mock.fetchImpl,
      clock: new RecordingClock(),
      logger: nullLogger,
      tokenProvider: () => "test-token-abcdefghijklmnop",
      beforeRequest: async (endpoint) => {
        reserved.push(endpoint);
      },
    });
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
    expect(reserved).toEqual(["product"]);
  });

  it("reserves a NEW slot for each retry attempt", async () => {
    const mock = createMockFetch();
    // First attempt fails transiently (network error → retryable), second succeeds.
    mock.enqueue(
      "/api/product?",
      { networkError: { name: "TypeError", message: "boom" } },
      { json: rawProduct({ id: "6910" }) },
    );
    const reserved: string[] = [];
    const client = new PriceChartingClient({
      fetch: mock.fetchImpl,
      clock: new RecordingClock(),
      logger: nullLogger,
      tokenProvider: () => "test-token-abcdefghijklmnop",
      beforeRequest: async (endpoint) => {
        reserved.push(endpoint);
      },
    });
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
    expect(mock.calls.length).toBe(2); // failed then retried
    expect(reserved).toEqual(["product", "product"]); // reserved once per attempt
  });

  it("FAILS CLOSED when the reserver throws: no upstream call, non-retryable error", async () => {
    const mock = createMockFetch();
    // Enqueue a would-be success — it must NEVER be consumed.
    mock.enqueue("/api/product?", { json: rawProduct({ id: "6910" }) });
    const client = new PriceChartingClient({
      fetch: mock.fetchImpl,
      clock: new RecordingClock(),
      logger: nullLogger,
      tokenProvider: () => "test-token-abcdefghijklmnop",
      beforeRequest: async () => {
        throw new Error("reservation db down");
      },
    });
    await expect(getProductById(client, "6910")).rejects.toMatchObject({
      code: "RATE_LIMIT_RESERVATION_UNAVAILABLE",
      retryable: false,
    });
    // The whole point: PriceCharting was never contacted.
    expect(mock.calls.length).toBe(0);
  });

  it("works unchanged when no reserver is injected (Node/tests)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: rawProduct({ id: "6910" }) });
    const client = new PriceChartingClient({
      fetch: mock.fetchImpl,
      clock: new RecordingClock(),
      logger: nullLogger,
      tokenProvider: () => "test-token-abcdefghijklmnop",
    });
    const product = await getProductById(client, "6910");
    expect(product.pricecharting_id).toBe("6910");
  });
});
