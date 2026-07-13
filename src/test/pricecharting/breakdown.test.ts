import { describe, it, expect } from "vitest";
import { scoreCandidate } from "@/lib/pricecharting/matching";
import type { CardItemInput, Product } from "@/lib/pricecharting/types";

function product(name: string, over: Partial<Product> = {}): Product {
  return {
    pricecharting_id: "P",
    name,
    console_or_category: "Pokemon Japanese Promo",
    release_date: null,
    upc: null,
    asin: null,
    epid: null,
    genre: null,
    raw_prices: {},
    ...over,
  };
}

const charmander = (over: Partial<CardItemInput> = {}): CardItemInput => ({
  category: "trading_card",
  card_name: "Charmander",
  card_number: "289/S-P",
  set: "Sword & Shield Promos",
  year: 2022,
  language: "Japanese",
  variant: "Pokémon GO Gift Campaign",
  grading_company: "CGC",
  grade: 10,
  ...over,
});

const field = (b: ReturnType<typeof scoreCandidate>["breakdown"], name: string) => b.fields.find((f) => f.field === name)!;

describe("structured scoring breakdown", () => {
  it("returns a full per-field breakdown with raw + adjusted scores and the floor reason", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289/S-P"));
    const b = s.breakdown;
    expect(b.raw_score).toBeLessThan(95); // catalog-alias/missing-year dilute the raw score
    expect(b.adjusted_score).toBe(95);
    expect(b.identity_floor_applied).toBe(true);
    expect(b.identity_floor_reason).toMatch(/exact character.*distinctive collector number/i);
    expect(b.eligible).toBe(true);
    // Field-level detail present for the required fields.
    for (const f of ["character", "complete_card_number", "numerator", "promo_suffix", "set", "year", "language", "variation", "artwork"]) {
      expect(b.fields.some((x) => x.field === f)).toBe(true);
    }
    expect(field(b, "character").result).toBe("exact");
    expect(field(b, "complete_card_number").result).toBe("normalized_exact");
    expect(field(b, "promo_suffix").result).toBe("exact");
    expect(field(b, "artwork").result).toBe("not_checked");
    expect(b.score_contributions.length).toBeGreaterThan(0);
  });

  it("classifies a MISSING candidate year as 'missing', not a mismatch, and not a conflict", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289/S-P")); // no release_date
    const y = field(s.breakdown, "year");
    expect(y.result).toBe("missing");
    expect(y.hard_conflict).toBe(false);
    expect(s.breakdown.soft_conflicts.some((c) => /year/i.test(c))).toBe(false);
  });

  it("classifies a set/catalog-alias difference as a SOFT signal, never a conflict", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289/S-P", { console_or_category: "Pokemon Japanese Promo" }));
    const set = field(s.breakdown, "set");
    expect(set.hard_conflict).toBe(false);
    expect(s.breakdown.hard_conflicts.some((c) => /set/i.test(c))).toBe(false);
    expect(set.explanation).toMatch(/soft|alias/i);
  });

  it("keeps HARD and SOFT conflicts separate (year mismatch is soft, wrong number is hard)", () => {
    const yearOff = scoreCandidate(charmander({ year: 1998 }), product("Charmander #289/S-P", { release_date: "2021-01-01" }));
    expect(yearOff.breakdown.soft_conflicts.some((c) => /year/i.test(c))).toBe(true);
    expect(yearOff.breakdown.hard_conflicts).toHaveLength(0);
    expect(yearOff.breakdown.disqualified).toBe(false);

    const wrongNum = scoreCandidate(charmander(), product("Charmander #290/S-P"));
    expect(wrongNum.breakdown.hard_conflicts.some((c) => /card_number/i.test(c))).toBe(true);
    expect(wrongNum.breakdown.disqualified).toBe(true);
    expect(field(wrongNum.breakdown, "numerator").result).toBe("mismatch");
  });

  it("hard-rejects a Korean catalog product for a Japanese slab", () => {
    const s = scoreCandidate(
      charmander({ card_name: "Alakazam", card_number: "071/063", set: "Mega Symphonia" }),
      product("Alakazam #71", { console_or_category: "Pokemon Korean Mega Symphonia" }),
    );
    expect(s.breakdown.disqualified).toBe(true);
    expect(s.breakdown.hard_conflicts.join(" ")).toMatch(/language mismatch.*japanese.*korean/i);
    expect(field(s.breakdown, "language").hard_conflict).toBe(true);
  });
});
