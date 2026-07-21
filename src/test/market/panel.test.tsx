import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketIntelligencePanel } from "@/components/market/MarketIntelligencePanel";
import type { MarketIntelligence } from "@/lib/market/client";

const data: MarketIntelligence = {
  identity_hash: "abc",
  grade_tier: "grade_10",
  verified_sales: [
    { source: "ebay_sold", kind: "sale", price_cents: 31000, currency: "USD", observed_at: "2026-07-12T00:00:00Z", sold_at: "2026-07-12T00:00:00Z", grade_tier: "grade_10", match: "exact", url: "https://ebay/1", title: "Charizard PSA 10" },
  ],
  active_listings: [
    { source: "ebay_active", kind: "listing", price_cents: 99900, currency: "USD", observed_at: "2026-07-15T00:00:00Z", sold_at: null, grade_tier: "grade_10", match: "exact", url: "https://ebay/2", title: "Charizard PSA 10 asking" },
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
    { source: "ebay_active", status: "success", query: "Charizard PSA 10", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 1, exact_count: 1, retryable: false, message: "1 result from eBay active listings." },
    { source: "ebay_sold", status: "not_configured", query: "Charizard PSA 10", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 0, exact_count: 0, retryable: false, message: "Connected-seller sales is not configured." },
  ],
  identity_completeness: { status: "complete", missing: [], notes: [] },
  generated_at: "2026-07-15T00:00:00Z",
};

afterEach(cleanup);

describe("MarketIntelligencePanel", () => {
  it("renders the six sections including provider status", () => {
    render(<MarketIntelligencePanel data={data} isLoading={false} error={null} />);
    expect(screen.getByText(/Market Summary/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Verified Sales/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Current Listings/i)).toBeInTheDocument();
    expect(screen.getByText(/PriceCharting Grade Tiers/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider Status/i)).toBeInTheDocument();
    expect(screen.getByText(/Sources/i)).toBeInTheDocument();
  });

  it("surfaces an unconfigured connected-seller source instead of hiding it", () => {
    render(<MarketIntelligencePanel data={data} isLoading={false} error={null} />);
    // The connected-seller row is present AND labeled Not configured — never a
    // blank that reads like "zero sales".
    expect(screen.getByText(/Connected seller sales/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Not configured/i).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps asking prices out of sold evidence — the listing is labeled asking, not sold", () => {
    render(<MarketIntelligencePanel data={data} isLoading={false} error={null} />);
    // The listings section explicitly notes these are asking prices, not sold.
    expect(screen.getByText(/Asking prices — supply context, not sold evidence/i)).toBeInTheDocument();
    // The sold value ($310) drives the median; asking prices sit under Current
    // Listings with the note above, never in the sold stats.
    expect(screen.getAllByText("$310.00").length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading and error states", () => {
    const { rerender } = render(<MarketIntelligencePanel data={undefined} isLoading error={null} />);
    expect(screen.getByText(/Gathering market data/i)).toBeInTheDocument();
    rerender(<MarketIntelligencePanel data={undefined} isLoading={false} error="providers offline" />);
    expect(screen.getByText(/Market data is unavailable/i)).toBeInTheDocument();
  });

  it("renders empty states (never crashes) when the payload is missing arrays/objects", () => {
    // Reproduces the live crash: a 200 response whose shape is missing arrays the
    // panel maps over (e.g. a deployed edge function older than the frontend).
    // Before the fix, `.map()` on undefined threw and the top-level boundary
    // blanked the page. After, the panel degrades to empty sections.
    const partial = { generated_at: "2026-07-15T00:00:00Z" } as unknown as MarketIntelligence;
    expect(() => render(<MarketIntelligencePanel data={partial} isLoading={false} error={null} />)).not.toThrow();
    expect(screen.getByText(/Market Intelligence/i)).toBeInTheDocument();
    expect(screen.getByText(/No verified completed sales yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No active listings found/i)).toBeInTheDocument();
    expect(screen.getByText(/No PriceCharting product matched/i)).toBeInTheDocument();
  });
});
