/**
 * Consolidated resilience coverage for MarketIntelligencePanel, replacing the
 * narrower PR-specific test files from the two independently-fixed branches
 * (#38's isWellFormedMarketIntelligence gate and #42's per-field defaults).
 * The shipped implementation uses #42's per-field defensive normalization
 * (?? [] / ?? 0 / a complete-identity default), which is strictly more
 * graceful than a binary "well-formed or show a banner" gate: a payload
 * missing ONE field still renders every other section correctly instead of
 * hiding all of them.
 *
 * Root cause this guards against: the market-intelligence Edge Function's
 * Deno.serve handler has no top-level try/catch, so a malformed-but-200
 * response (partial body, stale cached shape, schema drift) reaches the
 * client with no `error` field. Before this fix, the panel read
 * `data.summary.count` and five `.map()`s unconditionally, which threw
 * during render and — with no boundary around this section at the time —
 * blanked the entire slab detail page.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketIntelligencePanel } from "@/components/market/MarketIntelligencePanel";
import type { MarketIntelligence } from "@/lib/market/client";

afterEach(cleanup);

const WELL_FORMED: MarketIntelligence = {
  identity_hash: "abc",
  grade_tier: "grade_10",
  verified_sales: [
    {
      source: "ebay_sold", kind: "sale", price_cents: 31000, currency: "USD",
      observed_at: "2026-07-12T00:00:00Z", sold_at: "2026-07-12T00:00:00Z",
      grade_tier: "grade_10", match: "exact", url: "https://ebay/1", title: "Charizard PSA 10",
    },
  ],
  active_listings: [
    {
      source: "ebay_active", kind: "listing", price_cents: 99900, currency: "USD",
      observed_at: "2026-07-15T00:00:00Z", sold_at: null,
      grade_tier: "grade_10", match: "exact", url: "https://ebay/2", title: "Charizard PSA 10 asking",
    },
  ],
  grade_tiers: [
    { tier: "raw", label: "Raw / Ungraded", value_cents: 20000, source: "pricecharting" },
    { tier: "grade_10", label: "Grade 10", value_cents: 300000, source: "pricecharting" },
  ],
  summary: { count: 1, last_sale_cents: 31000, last_sale_at: "2026-07-12T00:00:00Z", highest_cents: 31000, lowest_cents: 31000, median_cents: 31000, average_cents: 31000 },
  last_sold_cents: 31000, median_sold_cents: 31000, low_sold_cents: 31000, high_sold_cents: 31000,
  lowest_active_cents: 99900,
  liquidity: 0.6, confidence: 0.5,
  provenance: [{ source: "ebay_sold", query: "Charizard PSA 10", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 3, exact_count: 1, url: null }],
  sources: [
    { source: "pricecharting", status: "success", query: "Charizard", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 2, exact_count: 2, retryable: false, message: "2 results from PriceCharting." },
    { source: "ebay_sold", status: "not_configured", query: "Charizard PSA 10", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 0, exact_count: 0, retryable: false, message: "Connected-seller sales is not configured." },
  ],
  identity_completeness: { status: "complete", missing: [], notes: [] },
  generated_at: "2026-07-15T00:00:00Z",
};

describe("MarketIntelligencePanel — valid responses render normally", () => {
  it("renders every section from a fully well-formed payload", () => {
    render(<MarketIntelligencePanel data={WELL_FORMED} isLoading={false} error={null} />);
    expect(screen.getByText(/Market Summary/i)).toBeInTheDocument();
    expect(screen.getByText(/Current Listings/i)).toBeInTheDocument();
    expect(screen.getByText(/PriceCharting Grade Tiers/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider Status/i)).toBeInTheDocument();
    expect(screen.getByText(/Sources/i)).toBeInTheDocument();
    expect(screen.getAllByText("$310.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Connected seller sales/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Not configured/i).length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading and network-error states without touching the data path", () => {
    const { rerender } = render(<MarketIntelligencePanel data={undefined} isLoading error={null} />);
    expect(screen.getByText(/Gathering market data/i)).toBeInTheDocument();
    rerender(<MarketIntelligencePanel data={undefined} isLoading={false} error="providers offline" />);
    expect(screen.getByText(/Market data is unavailable/i)).toBeInTheDocument();
  });
});

describe("MarketIntelligencePanel — missing arrays never crash", () => {
  it("renders empty-state sections when every array is absent", () => {
    const partial = { generated_at: "2026-07-15T00:00:00Z" } as unknown as MarketIntelligence;
    expect(() => render(<MarketIntelligencePanel data={partial} isLoading={false} error={null} />)).not.toThrow();
    expect(screen.getByText(/No verified completed sales yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No active listings found/i)).toBeInTheDocument();
    expect(screen.getByText(/No PriceCharting product matched/i)).toBeInTheDocument();
    expect(screen.getByText(/No sources responded/i)).toBeInTheDocument();
  });

  it("renders correctly when only ONE array is missing (the rest of the payload is fine)", () => {
    const singleFieldMissing = { ...WELL_FORMED, verified_sales: undefined } as unknown as MarketIntelligence;
    expect(() => render(<MarketIntelligencePanel data={singleFieldMissing} isLoading={false} error={null} />)).not.toThrow();
    expect(screen.getByText(/No verified completed sales yet/i)).toBeInTheDocument();
    // The rest of the payload is untouched by the missing field — still renders.
    expect(screen.getByText(/Current Listings/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Charizard PSA 10 asking/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe("MarketIntelligencePanel — missing numeric fields never crash", () => {
  it("renders — for missing liquidity/confidence/summary.count instead of throwing on arithmetic", () => {
    const missingNumbers = {
      ...WELL_FORMED,
      liquidity: undefined,
      confidence: undefined,
      summary: undefined,
      median_sold_cents: undefined,
    } as unknown as MarketIntelligence;
    expect(() => render(<MarketIntelligencePanel data={missingNumbers} isLoading={false} error={null} />)).not.toThrow();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("0")).toBeInTheDocument(); // Verified sales count defaults to 0
  });
});

describe("MarketIntelligencePanel — malformed nested response data never crashes", () => {
  it("defaults a missing identity_completeness object instead of throwing on .status/.missing", () => {
    const malformedNested = { ...WELL_FORMED, identity_completeness: undefined } as unknown as MarketIntelligence;
    expect(() => render(<MarketIntelligencePanel data={malformedNested} isLoading={false} error={null} />)).not.toThrow();
  });

  it("tolerates an array item missing its own nested fields (e.g. a grade tier with no label)", () => {
    const malformedItem = {
      ...WELL_FORMED,
      grade_tiers: [{ tier: "grade_10" } as unknown as MarketIntelligence["grade_tiers"][number]],
    };
    expect(() => render(<MarketIntelligencePanel data={malformedItem} isLoading={false} error={null} />)).not.toThrow();
  });
});
