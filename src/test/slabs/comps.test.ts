import { describe, it, expect } from "vitest";
import { compTotalCents, computeCompStats, suggestFinalValue } from "@/lib/slabs/comps";
import type { SlabComp } from "@/lib/slabs/types";

function comp(p: Partial<SlabComp>): SlabComp {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    slab_id: "slab-1",
    sale_date: null,
    sold_price_cents: null,
    shipping_cents: null,
    total_price_cents: null,
    marketplace: null,
    grader: null,
    grade: null,
    exact_match: null,
    source_url: null,
    notes: null,
    created_at: "2026-07-10T00:00:00Z",
    ...p,
  };
}

describe("compTotalCents", () => {
  it("uses explicit total when present", () => {
    expect(compTotalCents(comp({ total_price_cents: 5000, sold_price_cents: 4000, shipping_cents: 500 }))).toBe(5000);
  });
  it("falls back to sold + shipping", () => {
    expect(compTotalCents(comp({ sold_price_cents: 4000, shipping_cents: 500 }))).toBe(4500);
    expect(compTotalCents(comp({ sold_price_cents: 4000 }))).toBe(4000);
  });
  it("is null with no sold price and no total", () => {
    expect(compTotalCents(comp({ shipping_cents: 500 }))).toBeNull();
  });
});

describe("computeCompStats", () => {
  it("computes exact/accepted medians, range, and most recent date", () => {
    const comps = [
      comp({ sale_date: "2026-01-01", sold_price_cents: 10000, exact_match: true }),
      comp({ sale_date: "2026-03-01", sold_price_cents: 20000, exact_match: true }),
      comp({ sale_date: "2026-02-01", sold_price_cents: 30000, exact_match: false }),
      comp({ shipping_cents: 100 }), // no sold price → excluded
    ];
    const s = computeCompStats(comps);
    expect(s.accepted_count).toBe(3);
    expect(s.exact_count).toBe(2);
    expect(s.exact_median_cents).toBe(15000); // (10000 + 20000)/2
    expect(s.accepted_median_cents).toBe(20000); // median of 10000,20000,30000
    expect(s.sold_range_cents).toEqual({ min: 10000, max: 30000 });
    expect(s.most_recent_sale_date).toBe("2026-03-01");
  });

  it("handles no comps", () => {
    const s = computeCompStats([]);
    expect(s).toMatchObject({
      accepted_count: 0,
      exact_count: 0,
      exact_median_cents: null,
      accepted_median_cents: null,
      sold_range_cents: null,
      most_recent_sale_date: null,
    });
  });
});

describe("suggestFinalValue", () => {
  const base = computeCompStats([
    comp({ sold_price_cents: 12000, exact_match: true }),
    comp({ sold_price_cents: 18000, exact_match: false }),
  ]);

  it("prefers exact median when available", () => {
    const s = suggestFinalValue(base, 9999);
    expect(s.basis).toBe("exact_median");
    expect(s.suggested_cents).toBe(12000);
  });

  it("falls back to accepted median when there are no exact comps", () => {
    const stats = computeCompStats([comp({ sold_price_cents: 10000, exact_match: false }), comp({ sold_price_cents: 20000, exact_match: false })]);
    const s = suggestFinalValue(stats, 9999);
    expect(s.basis).toBe("accepted_median");
    expect(s.suggested_cents).toBe(15000);
  });

  it("uses PriceCharting guide only as secondary evidence when no comps", () => {
    const s = suggestFinalValue(computeCompStats([]), 8800);
    expect(s.basis).toBe("pricecharting_guide");
    expect(s.suggested_cents).toBe(8800);
  });

  it("suggests nothing when there are no comps and no guide", () => {
    const s = suggestFinalValue(computeCompStats([]), null);
    expect(s.basis).toBe("none");
    expect(s.suggested_cents).toBeNull();
  });
});
