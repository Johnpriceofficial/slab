import { describe, it, expect } from "vitest";
import { buildIdentity } from "@/lib/identity/identity";
import { buildMarketIntelligence, deriveSourceState } from "@/server/market-intelligence/engine";
import { buildProvenance } from "@/lib/market/provenance";
import type { AdapterResult, AdapterError } from "@/lib/market/adapters";

const AT = "2026-07-15T00:00:00Z";

function res(source: AdapterResult["source"], opts: { candidates?: AdapterResult["candidates"]; error?: AdapterError | null; query?: string }): AdapterResult {
  const candidates = opts.candidates ?? [];
  return {
    source,
    candidates,
    provenance: buildProvenance({ source, query: opts.query ?? "q", retrieved_at: AT, candidate_count: candidates.length, exact_count: 0 }),
    error: opts.error ?? null,
  };
}

describe("per-provider source status", () => {
  it("distinguishes no-results from provider failure", () => {
    const empty = deriveSourceState(res("ebay_active", {}), 0);
    expect(empty.status).toBe("no_results");
    expect(empty.retryable).toBe(false);

    const failed = deriveSourceState(res("ebay_active", { error: { source: "ebay_active", code: "provider_error", message: "boom", retryable: false } }), 0);
    expect(failed.status).toBe("provider_error");
  });

  it("surfaces rate limiting as retryable", () => {
    const s = deriveSourceState(res("pricecharting", { error: { source: "pricecharting", code: "rate_limited", message: "429", retryable: true } }), 0);
    expect(s.status).toBe("rate_limited");
    expect(s.retryable).toBe(true);
  });

  it("maps not_configured and does not throw", () => {
    const s = deriveSourceState(res("ebay_active", { error: { source: "ebay_active", code: "not_configured", message: "no creds", retryable: false } }), 0);
    expect(s.status).toBe("not_configured");
    expect(s.retryable).toBe(false);
  });

  it("treats a 404/not_found as no_results, not a failure", () => {
    const s = deriveSourceState(res("ebay_active", { error: { source: "ebay_active", code: "not_found", message: "404", retryable: false } }), 0);
    expect(s.status).toBe("no_results");
  });

  it("NEVER echoes a raw provider error that could carry a token or URL", () => {
    const leaky: AdapterError = {
      source: "ebay_active",
      code: "network_error",
      message: "error sending request for url (https://api.ebay.com/x?token=SUPERSECRET_TOKEN_ABC123) Bearer sk-leak-999",
      retryable: true,
    };
    const s = deriveSourceState(res("ebay_active", { error: leaky }), 0);
    expect(s.message).not.toMatch(/SUPERSECRET_TOKEN_ABC123/);
    expect(s.message).not.toMatch(/sk-leak-999/);
    expect(s.message).not.toMatch(/https?:\/\//);
  });

  it("reports every provider in the assembled object, incl. an honest connected-seller", async () => {
    const identity = await buildIdentity({ card_name: "Charizard", set: "Base Set", card_number: "4/102", grader: "PSA", grade: "10" });
    const results: AdapterResult[] = [
      res("pricecharting", { error: { source: "pricecharting", code: "not_configured", message: "x", retryable: false } }),
      res("ebay_active", { error: { source: "ebay_active", code: "not_configured", message: "x", retryable: false } }),
      // Connected-seller is honestly reported as not_configured — NOT a fake empty success.
      res("ebay_sold", { error: { source: "ebay_sold", code: "not_configured", message: "x", retryable: false } }),
    ];
    const mi = buildMarketIntelligence(identity, "grade_10", results, AT);

    const bySource = Object.fromEntries(mi.sources.map((s) => [s.source, s]));
    expect(bySource["ebay_sold"].status).toBe("not_configured");
    // Honest, not a zero-sales result masquerading as success.
    expect(bySource["ebay_sold"].status).not.toBe("success");
    expect(mi.verified_sales).toEqual([]);
    // And no source message leaks anything token-shaped.
    for (const s of mi.sources) expect(s.message).not.toMatch(/https?:\/\/|token|Bearer|sk-/i);
  });
});
