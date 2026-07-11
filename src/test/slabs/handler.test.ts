import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import { createMockFetch, RecordingClock } from "../pricecharting/helpers";
import type { Logger } from "@/lib/pricecharting/logger";

const TOKEN = "SECRET-pricecharting-token-DO-NOT-LEAK-1234567890";

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string, c?: Record<string, unknown>) => lines.push(`${m} ${c ? JSON.stringify(c) : ""}`);
  return {
    lines,
    logger: { debug: push, info: push, warn: push, error: push },
  };
}

function deps(mock: ReturnType<typeof createMockFetch>, logger?: Logger): HandlerDeps {
  return { fetch: mock.fetchImpl, clock: new RecordingClock(), logger, tokenProvider: () => TOKEN };
}

const CARD_ROW = (over: Record<string, unknown>) => ({
  id: "6910",
  "product-name": "Charizard #4",
  "console-name": "Pokemon Base Set",
  "release-date": "1999-01-09",
  "graded-price": 12500,
  "manual-only-price": 50000,
  ...over,
});

describe("handler — durable rate-limit fail-closed", () => {
  it("returns 503 and makes no upstream call when the reservation is unavailable", async () => {
    const mock = createMockFetch();
    // Would succeed if reached — it must not be.
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({})] } });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", grader: "PSA", grade: 9 },
      { ...deps(mock), beforeRequest: async () => { throw new Error("reservation unavailable"); } },
    );
    expect(res.statusCode).toBe(503);
    if (res.body.status !== "error") throw new Error("expected error body");
    expect(res.body.error_code).toBe("RATE_LIMIT_RESERVATION_UNAVAILABLE");
    expect(res.body.retryable).toBe(false);
    expect(mock.calls.length).toBe(0); // PriceCharting never contacted
  });
});

describe("handler — search", () => {
  it("returns candidates with guide values in integer cents", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({})] } });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", card_number: "4", set: "Base Set", year: 1999, grader: "PSA", grade: 9 },
      deps(mock),
    );
    expect(res.statusCode).toBe(200);
    if (res.body.status === "success" && res.body.action === "search") {
      expect(res.body.candidates[0].product_id).toBe("6910");
      expect(res.body.candidates[0].grade_field).toBe("graded-price");
      expect(res.body.candidates[0].guide_value_cents).toBe(12500); // integer cents
    }
  });

  it("requires manual confirmation and never auto-confirms on low confidence", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: {
        products: [
          CARD_ROW({ id: "1" }),
          CARD_ROW({ id: "2" }), // identical → ambiguous
        ],
      },
    });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", card_number: "4", set: "Base Set", year: 1999, grader: "PSA", grade: 9 },
      deps(mock),
    );
    if (res.body.status === "success" && res.body.action === "search") {
      expect(res.body.requires_confirmation).toBe(true);
      expect(res.body.auto_confirmed_product_id).toBeNull();
    }
  });

  it("hard-rejects a conflicting card number (separate from selectable candidates)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({ id: "9", "product-name": "Charizard #11" })] } });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", card_number: "4", set: "Base Set", year: 1999, grader: "PSA", grade: 9 },
      deps(mock),
    );
    if (res.body.status === "success" && res.body.action === "search") {
      // The wrong number is NOT a selectable candidate — it's rejected.
      expect(res.body.candidates.map((c) => c.product_id)).not.toContain("9");
      const rej = res.body.rejected_candidates[0];
      expect(rej.product_id).toBe("9");
      expect(rej.rejected).toBe(true);
      expect(rej.match_status).toBe("no_match");
      expect(rej.conflicts.join(" ")).toMatch(/mismatch/i);
      expect(res.body.auto_confirmed_product_id).toBeNull();
    }
  });

  it("labels values as the current guide value (not eBay/last-sold)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({})] } });
    const res = await handlePriceChartingRequest({ action: "search", card_name: "Charizard", card_number: "4" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "search") {
      expect(res.body.warnings.join(" ")).toMatch(/Current PriceCharting Guide Value/i);
      expect(res.body.warnings.join(" ")).not.toMatch(/last-sold result\b(?!.*not)/i);
    }
  });
});

describe("handler — value", () => {
  it("values one confirmed product and reads sales volume", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: CARD_ROW({ "sales-volume": 42 }) });
    const res = await handlePriceChartingRequest({ action: "value", product_id: "6910", grader: "PSA", grade: 10 }, deps(mock));
    if (res.body.status === "success" && res.body.action === "value") {
      expect(res.body.grade_field).toBe("manual-only-price");
      expect(res.body.guide_value_cents).toBe(50000);
      expect(res.body.sales_volume).toBe(42);
    }
  });

  it("errors without a product id", async () => {
    const mock = createMockFetch();
    const res = await handlePriceChartingRequest({ action: "value" }, deps(mock));
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("error");
  });
});

describe("handler — token safety", () => {
  it("never includes the API token in the response body", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({})] } });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", card_number: "4", grader: "PSA", grade: 9 },
      deps(mock),
    );
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it("never writes the token to logs (URLs are masked)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [CARD_ROW({})] } });
    const { logger, lines } = recordingLogger();
    await handlePriceChartingRequest(
      { action: "search", card_name: "Charizard", card_number: "4", grader: "PSA", grade: 9 },
      deps(mock, logger),
    );
    expect(lines.join("\n")).not.toContain(TOKEN);
    // The token IS sent on the wire (expected) but only in masked form in logs.
    expect(mock.calls[0].url).toContain(TOKEN);
  });

  it("does not leak the token even on an upstream error", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { status: "error", "error-message": "Invalid token" } });
    const res = await handlePriceChartingRequest({ action: "search", card_name: "Charizard", card_number: "4" }, deps(mock));
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.body.status).toBe("error");
  });
});
