/**
 * Regression: the exact production slab that produced a blank valuation —
 *
 *   Mew ex · Pokémon Card 151 · 151/165 · Japanese · Holo · CGC Pristine 10
 *   Certification 6165347194  (cert is NEVER part of identity or valuation)
 *
 * The English "151" (Scarlet & Violet) set ALSO prints Mew ex at 151/165, so the
 * ONLY discriminator between the customer's Japanese slab and the English product
 * is language. PriceCharting marks Asian catalogs ("... Japanese ...") and leaves
 * English UNMARKED — which is exactly why the Japanese slab was silently linked to
 * the English product and then had no CGC Pristine tier to value.
 *
 * These tests pin the fix at the scoring boundary:
 *   - English (unmarked) product  → NOT auto-acceptable (soft "language unverified"
 *     conflict, identity floor blocked) — it can never reach confirmed silently.
 *   - Japanese (marked) product    → eligible, no language conflict.
 *   - Korean (marked) product       → hard-rejected (unambiguous wrong language).
 */

import { describe, it, expect } from "vitest";
import { scoreCandidate } from "@/lib/pricecharting/matching";
import type { CardItemInput, Product } from "@/lib/pricecharting/types";

function product(name: string, console_or_category: string, over: Partial<Product> = {}): Product {
  return {
    pricecharting_id: "P",
    name,
    console_or_category,
    release_date: "2023",
    upc: null,
    asin: null,
    epid: null,
    genre: null,
    raw_prices: {},
    ...over,
  };
}

// The customer's slab, as OCR resolves it (99% confidence on every field).
const MEW: CardItemInput = {
  category: "trading_card",
  card_name: "Mew ex",
  card_number: "151/165",
  set: "Pokémon Card 151",
  year: 2023,
  language: "Japanese",
  holo: true,
  grading_company: "CGC",
  grade: 10,
};

// Same character + same 151 number in BOTH sets — language is the only difference.
const ENGLISH = product("Mew ex #151", "Pokemon Scarlet & Violet 151"); // unmarked = English
const JAPANESE = product("Mew ex #151", "Pokemon Japanese Scarlet & Violet 151");
const KOREAN = product("Mew ex #151", "Pokemon Korean Scarlet & Violet 151");

describe("Mew ex 151/165 Japanese — language is material to acceptance", () => {
  it("does NOT silently accept the ENGLISH product for a Japanese slab", () => {
    const s = scoreCandidate(MEW, ENGLISH);
    // Not hard-rejected (the English product could still be shown as an option)…
    expect(s.disqualified).toBe(false);
    // …but flagged so it can never be auto-confirmed: language is unverified.
    expect(s.conflicts.some((c) => /language unverified/i.test(c))).toBe(true);
    // The identity floor must NOT fire — a language-ambiguous match is never "Exact".
    expect(s.score).toBeLessThan(95);
  });

  it("accepts the JAPANESE product with no language conflict", () => {
    const s = scoreCandidate(MEW, JAPANESE);
    expect(s.disqualified).toBe(false);
    expect(s.characterExact).toBe(true);
    expect(s.conflicts.some((c) => /language/i.test(c))).toBe(false);
    // The Japanese product must out-score the English one — language corroborates.
    expect(s.score).toBeGreaterThan(scoreCandidate(MEW, ENGLISH).score);
  });

  it("HARD-rejects a positively different language (Korean)", () => {
    const s = scoreCandidate(MEW, KOREAN);
    expect(s.disqualified).toBe(true);
    expect(s.conflicts.some((c) => /language mismatch.*japanese.*korean/i.test(c))).toBe(true);
  });

  it("certification number never enters scoring (identity is cert-free)", () => {
    const withCert = scoreCandidate({ ...MEW, certification_number: "6165347194" } as CardItemInput, JAPANESE);
    const without = scoreCandidate(MEW, JAPANESE);
    expect(withCert.score).toBe(without.score);
  });
});
