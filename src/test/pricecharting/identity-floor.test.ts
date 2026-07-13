import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  normalizeFullNumber,
  extractFullCardNumber,
  promoSuffix,
} from "@/lib/pricecharting/matching";
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

describe("full-number helpers", () => {
  it("folds punctuation/dashes/spacing but preserves the full printed value", () => {
    expect(normalizeFullNumber("289/S-P")).toBe("289/s-p");
    expect(normalizeFullNumber("#289/S-P")).toBe("289/s-p");
    expect(normalizeFullNumber("289 / S-P")).toBe("289/s-p");
    expect(normalizeFullNumber("289/S–P")).toBe("289/s-p"); // en-dash
    expect(extractFullCardNumber("Charmander #289/S-P")).toBe("289/S-P");
    expect(extractFullCardNumber("Charmander #4")).toBe("4");
  });
  it("promoSuffix returns the alphabetic family, never a numeric denominator", () => {
    expect(promoSuffix("289/s-p")).toBe("s-p");
    expect(promoSuffix("289/sv-p")).toBe("sv-p");
    expect(promoSuffix("16/64")).toBeNull(); // set-size denominator, not a suffix
    expect(promoSuffix("289")).toBeNull();
  });
});

describe("identity floor — catalog-alias / missing-year no longer block a confirmed match", () => {
  it("floors Charmander 289/S-P to a confirming score despite alias set + missing PriceCharting year", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289/S-P")); // no release_date, catalog console
    expect(s.disqualified).toBe(false);
    expect(s.characterExact).toBe(true);
    expect(s.numberExactFull).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(95); // was ~65 before the floor
  });

  it("treats a candidate that prints only the numerator (#289) as compatible but NOT exact_full", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289"));
    expect(s.disqualified).toBe(false); // numerator matches → still eligible
    expect(s.numberExactFull).toBe(false); // no suffix → not floored
    expect(s.score).toBeLessThan(95);
  });

  it("does NOT floor a bare-numeric number shared across sets (relies on set/year)", () => {
    const s = scoreCandidate(charmander({ card_number: "4" }), product("Charmander #4", { console_or_category: "Pokemon Base Set" }));
    expect(s.numberExactFull).toBe(true); // "4" === "4"
    expect(s.score).toBeLessThan(95); // bare digit is not distinctive → no floor
  });
});

describe("protections intact — wrong identity still rejected", () => {
  it("REJECTS a conflicting promo suffix (289/S-P vs 289/SV-P)", () => {
    const s = scoreCandidate(charmander(), product("Charmander #289/SV-P"));
    expect(s.disqualified).toBe(true);
    expect(s.conflicts.join()).toMatch(/promo suffix/);
    expect(s.score).toBeLessThan(95);
  });

  it("REJECTS a different character even with the same number (Fukuoka's Pikachu 289/SV-P)", () => {
    const s = scoreCandidate(charmander(), product("Fukuoka's Pikachu #289/SV-P"));
    expect(s.disqualified).toBe(true);
    expect(s.conflicts.join()).toMatch(/character mismatch/);
  });

  it("REJECTS a genuinely different numerator (290/S-P)", () => {
    const s = scoreCandidate(charmander(), product("Charmander #290/S-P"));
    expect(s.disqualified).toBe(true);
    expect(s.conflicts.join()).toMatch(/card_number mismatch/);
    expect(s.numberExactFull).toBe(false);
  });

  it("does not floor when a character is missing even if the number is exact", () => {
    // A non-matching character disqualifies regardless of the number.
    const s = scoreCandidate(charmander({ card_name: "Charmeleon" }), product("Charmander #289/S-P"));
    expect(s.disqualified).toBe(true);
  });
});
