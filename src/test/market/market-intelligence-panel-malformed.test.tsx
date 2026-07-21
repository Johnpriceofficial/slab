/**
 * Root-cause regression for the "Something went wrong" crash observed on
 * /slabs/3455aa7b-a727-4814-91eb-9a3dd6f17846 (inventory #32): the
 * market-intelligence Edge Function's Deno.serve handler has no top-level
 * try/catch, so ANY malformed-but-200 response (partial body from a runtime
 * hiccup, a stale cached shape, schema drift) reaches the client with no
 * `error` field. The panel used to assume that shape unconditionally
 * (`data.summary.count`), which threw during render and — with no boundary
 * around this section at the time — blanked the whole page.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketIntelligencePanel } from "@/components/market/MarketIntelligencePanel";
import type { MarketIntelligence } from "@/lib/market/client";

afterEach(cleanup);

describe("MarketIntelligencePanel malformed-response guard", () => {
  it("does not throw and shows the unavailable message when data resolves without the expected shape", () => {
    render(
      <MarketIntelligencePanel
        data={{ generated_at: "2026-07-16T00:00:00Z" } as unknown as MarketIntelligence}
        isLoading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/Market data is unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByText("Market Summary")).not.toBeInTheDocument();
  });

  it("renders the full summary for a well-formed response", () => {
    const data: MarketIntelligence = {
      generated_at: "2026-07-16T00:00:00Z",
      median_sold_cents: null,
      last_sold_cents: null,
      low_sold_cents: null,
      high_sold_cents: null,
      lowest_active_cents: null,
      liquidity: 0,
      confidence: 0,
      summary: { count: 0, median_cents: null, lowest_cents: null, highest_cents: null, last_sale_cents: null },
      verified_sales: [],
      active_listings: [],
      grade_tiers: [],
      sources: [],
      provenance: [],
      identity_completeness: { status: "complete", missing: [] },
    } as unknown as MarketIntelligence;
    render(<MarketIntelligencePanel data={data} isLoading={false} error={null} />);
    expect(screen.getByText(/Market Summary/)).toBeInTheDocument();
    expect(screen.queryByText(/Market data is unavailable right now/)).not.toBeInTheDocument();
  });
});
