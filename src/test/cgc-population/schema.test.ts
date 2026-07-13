import { describe, it, expect } from "vitest";
import { validateCgcRecord, validateCgcBatch } from "@/lib/cgc-population/schema";

const base = {
  card_name: "Charmander",
  card_number: "289/S-P",
  set_name: "Sword & Shield Promos",
  set_id: 1234,
  card_id: 5678,
  year: "2022",
  parallel_or_variant: "Pokémon GO Gift Campaign",
  autograph: false,
  memorabilia: false,
  total_graded: 50,
  count_pristine_10: 12,
  count_gem_mint_10: 20,
  count_perfect_10: 0,
  count_mint_9: 18,
  report_url: "https://www.cgccards.com/population-report/pokemon/x",
};

describe("validateCgcRecord", () => {
  it("parses a valid record and normalizes identity fields", () => {
    const r = validateCgcRecord(base);
    expect(r.errors).toEqual([]);
    expect(r.value).not.toBeNull();
    const v = r.value!;
    expect(v.normalized_card_name).toBe("charmander");
    expect(v.normalized_set_name).toBe("sword & shield promos");
    // Full printed number preserved; numerator token is a retrieval aid.
    expect(v.normalized_card_number).toBe("289/s-p");
    expect(v.card_number_token).toBe("289");
    // Diacritics folded for matching.
    expect(v.normalized_variant).toBe("pokemon go gift campaign");
    expect(v.cgc_card_id).toBe(5678);
  });

  it("keeps a MISSING count as null (never a claimed zero) and an explicit 0 as 0", () => {
    const r = validateCgcRecord({ ...base, count_gem_mint_10: undefined, count_perfect_10: 0 });
    expect(r.value).not.toBeNull();
    expect(r.value!.counts.count_gem_mint_10).toBeNull(); // missing ≠ 0
    expect(r.value!.counts.count_perfect_10).toBe(0); // explicit 0 preserved
  });

  it("REJECTS a negative count", () => {
    const r = validateCgcRecord({ ...base, count_mint_9: -3 });
    expect(r.value).toBeNull();
    expect(r.errors.join()).toMatch(/count_mint_9: negative/);
  });

  it("REJECTS a non-integer count", () => {
    const r = validateCgcRecord({ ...base, count_pristine_10: 4.5 });
    expect(r.value).toBeNull();
  });

  it("REJECTS a record with neither card_name nor card_number", () => {
    const r = validateCgcRecord({ ...base, card_name: "", card_number: null });
    expect(r.value).toBeNull();
    expect(r.errors.join()).toMatch(/missing both/);
  });

  it("batch validation returns good cards and an error count without throwing", () => {
    const { cards, errorCount } = validateCgcBatch([base, { ...base, count_mint_9: -1 }, "garbage"]);
    expect(cards).toHaveLength(1);
    expect(errorCount).toBe(2);
  });
});
