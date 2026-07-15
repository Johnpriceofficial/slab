import { describe, it, expect } from "vitest";
import { buildIdentity } from "@/lib/identity/identity";
import {
  mapGradeToTier, isPremiumTier,
  priceChartingQuery, ebayExactQuery, ebayCompatibleQuery,
  buildProvenance, contributed,
  normalizeCandidate, classifyPoint, classifyCandidates, titleMatchesCard,
  separateMarket,
  summarizeSales, median,
  liquidityScore, marketConfidence,
  compareSnapshots, snapshotOf,
  type RawCandidate,
} from "@/lib/market";

const identity = await buildIdentity({ card_name: "Charizard", set: "Base Set", card_number: "4/102", language: "English", year: "1999", grader: "PSA", grade: "10", pricecharting_product_id: "6910" });

describe("grade-tier mapping", () => {
  it("maps grades to canonical tiers", () => {
    expect(mapGradeToTier(null, null)).toBe("raw");
    expect(mapGradeToTier("PSA", "10")).toBe("grade_10");
    expect(mapGradeToTier("CGC", "10", "Pristine")).toBe("pristine_10");
    expect(mapGradeToTier("BGS", "10", "Black Label")).toBe("black_label_10");
    expect(mapGradeToTier("BGS", "9.5")).toBe("grade_9_5");
    expect(mapGradeToTier("PSA", "8")).toBe("grade_8");
  });
  it("flags premium 10 tiers", () => {
    expect(isPremiumTier("pristine_10")).toBe(true);
    expect(isPremiumTier("grade_10")).toBe(false);
  });
});

describe("query generation", () => {
  it("PriceCharting query is the card identity, no grade", () => {
    expect(priceChartingQuery(identity)).toBe("Charizard Base Set 4/102");
  });
  it("eBay exact query includes grader + grade; compatible excludes grade + adds noise filters", () => {
    expect(ebayExactQuery(identity)).toContain("PSA 10");
    expect(ebayExactQuery(identity)).toContain('"Charizard"');
    expect(ebayCompatibleQuery(identity)).not.toContain("PSA 10");
    expect(ebayCompatibleQuery(identity)).toContain("-lot");
  });
});

describe("candidate normalization + classification", () => {
  const at = "2026-07-15T00:00:00Z";
  it("drops candidates without a usable price", () => {
    expect(normalizeCandidate({ source: "ebay_sold", title: "x", price_cents: null }, at)).toBeNull();
    expect(normalizeCandidate({ source: "ebay_sold", title: "x", price_cents: 0 }, at)).toBeNull();
  });
  it("normalizes sold vs active into sale vs listing", () => {
    const sale = normalizeCandidate({ source: "ebay_sold", title: "Charizard 4/102 PSA 10", price_cents: 30000, sold: true, sold_at: at, grader: "PSA", grade: "10" }, at)!;
    const listing = normalizeCandidate({ source: "ebay_active", title: "Charizard 4/102 PSA 10", price_cents: 45000, sold: false, grader: "PSA", grade: "10" }, at)!;
    expect(sale.kind).toBe("sale");
    expect(listing.kind).toBe("listing");
    expect(sale.grade_tier).toBe("grade_10");
  });
  it("classifies exact (same card + tier), compatible (same card, other tier), rejected (different card)", () => {
    const point = (title: string, grade: string) => ({ ...normalizeCandidate({ source: "ebay_sold", title, price_cents: 100, sold: true, grader: "PSA", grade }, at)! });
    expect(classifyPoint(identity, "grade_10", point("Charizard Base Set 4/102 PSA 10", "10"))).toBe("exact");
    expect(classifyPoint(identity, "grade_10", point("Charizard Base Set 4/102 PSA 9", "9"))).toBe("compatible");
    expect(classifyPoint(identity, "grade_10", point("Blastoise Base Set 2/102 PSA 10", "10"))).toBe("rejected");
  });
  it("titleMatchesCard requires the name and number", () => {
    expect(titleMatchesCard(identity, "Charizard 4/102 holo")).toBe(true);
    expect(titleMatchesCard(identity, "Charizard 99/102")).toBe(false);
    expect(titleMatchesCard(identity, "Venusaur 4/102")).toBe(false);
  });
});

describe("active vs sold separation", () => {
  const at = "2026-07-15T00:00:00Z";
  const candidates: RawCandidate[] = [
    { source: "ebay_sold", title: "Charizard 4/102 PSA 10", price_cents: 30000, sold: true, sold_at: at, grader: "PSA", grade: "10" },
    { source: "ebay_active", title: "Charizard 4/102 PSA 10", price_cents: 45000, sold: false, grader: "PSA", grade: "10" },
    { source: "ebay_sold", title: "Charizard 4/102 PSA 9", price_cents: 12000, sold: true, sold_at: at, grader: "PSA", grade: "9" },
    { source: "ebay_sold", title: "Pikachu 58/102", price_cents: 500, sold: true, grader: "PSA", grade: "10" },
  ];
  it("keeps verified sales, active listings, and compatible tiers apart and drops rejects", () => {
    const points = classifyCandidates(identity, "grade_10", candidates, at);
    const { sales, active, compatible } = separateMarket(points);
    expect(sales).toHaveLength(1);      // the PSA 10 sale
    expect(active).toHaveLength(1);     // the PSA 10 listing
    expect(compatible).toHaveLength(1); // the PSA 9 sale
    // Pikachu (different card) is rejected and appears nowhere.
    expect([...sales, ...active, ...compatible].some((p) => p.title?.includes("Pikachu"))).toBe(false);
  });
});

describe("summary — verified sales only", () => {
  it("computes count/last/high/low/median/average and ignores listings", () => {
    const at = (d: string) => `2026-07-${d}T00:00:00Z`;
    const sales = classifyCandidates(identity, "grade_10", [
      { source: "ebay_sold", title: "Charizard 4/102 PSA 10", price_cents: 30000, sold: true, sold_at: at("10"), grader: "PSA", grade: "10" },
      { source: "ebay_sold", title: "Charizard 4/102 PSA 10", price_cents: 20000, sold: true, sold_at: at("12"), grader: "PSA", grade: "10" },
      { source: "ebay_active", title: "Charizard 4/102 PSA 10", price_cents: 99000, sold: false, grader: "PSA", grade: "10" },
    ], at("12")).filter((p) => p.match === "exact");
    const s = summarizeSales(sales);
    expect(s.count).toBe(2);
    expect(s.highest_cents).toBe(30000);
    expect(s.lowest_cents).toBe(20000);
    expect(s.median_cents).toBe(25000);
    expect(s.last_sale_cents).toBe(20000); // most recent (the 12th)
  });
  it("median handles odd and even counts", () => {
    expect(median([100, 300, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(median([])).toBeNull();
  });
  it("empty sales yields a null summary, not a throw", () => {
    expect(summarizeSales([]).count).toBe(0);
    expect(summarizeSales([]).median_cents).toBeNull();
  });
});

describe("liquidity + confidence", () => {
  const at = "2026-07-30T00:00:00Z";
  const sale = (d: string, price = 10000): RawCandidate => ({ source: "ebay_sold", title: "Charizard 4/102 PSA 10", price_cents: price, sold: true, sold_at: `2026-07-${d}T00:00:00Z`, grader: "PSA", grade: "10" });
  it("scores frequent recent sales as more liquid than a single stale one", () => {
    const many = classifyCandidates(identity, "grade_10", [sale("20"), sale("24"), sale("27"), sale("29")], at);
    const one = classifyCandidates(identity, "grade_10", [sale("02")], at);
    expect(liquidityScore(many, at)).toBeGreaterThan(liquidityScore(one, at));
    expect(liquidityScore([], at)).toBe(0);
  });
  it("confidence rises with sample size and tight dispersion", () => {
    const tight = summarizeSales(classifyCandidates(identity, "grade_10", [sale("20", 10000), sale("22", 10500), sale("24", 9800), sale("26", 10200)], at));
    const wide = summarizeSales(classifyCandidates(identity, "grade_10", [sale("20", 5000), sale("22", 30000)], at));
    expect(marketConfidence({ summary: tight, sourceCount: 2, asOf: at })).toBeGreaterThan(marketConfidence({ summary: wide, sourceCount: 1, asOf: at }));
    expect(marketConfidence({ summary: summarizeSales([]), sourceCount: 0, asOf: at })).toBe(0);
  });
});

describe("snapshot comparison / trend", () => {
  it("computes delta, percent, and trend direction", () => {
    const prev = snapshotOf("2026-06-15T00:00:00Z", 20000, 5);
    const up = compareSnapshots(prev, snapshotOf("2026-07-15T00:00:00Z", 26000, 6));
    expect(up.delta_cents).toBe(6000);
    expect(up.percent_change).toBeCloseTo(0.3);
    expect(up.trend).toBe("up");
    expect(compareSnapshots(prev, snapshotOf("2026-07-15T00:00:00Z", 20100, 5)).trend).toBe("flat"); // within 2%
    expect(compareSnapshots(prev, snapshotOf("2026-07-15T00:00:00Z", 15000, 5)).trend).toBe("down");
  });
  it("returns nulls when a snapshot has no median", () => {
    const c = compareSnapshots(snapshotOf("a", null, 0), snapshotOf("b", 20000, 3));
    expect(c.delta_cents).toBeNull();
    expect(c.trend).toBe("flat");
  });
});

describe("provenance", () => {
  it("records source attribution and contribution", () => {
    const p = buildProvenance({ source: "ebay_sold", query: "Charizard PSA 10", retrieved_at: "2026-07-15T00:00:00Z", candidate_count: 12, exact_count: 4 });
    expect(p.source).toBe("ebay_sold");
    expect(contributed(p)).toBe(true);
    expect(contributed({ ...p, exact_count: 0 })).toBe(false);
  });
});
