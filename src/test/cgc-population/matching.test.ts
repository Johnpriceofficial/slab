import { describe, it, expect } from "vitest";
import { validateCgcRecord } from "@/lib/cgc-population/schema";
import {
  resolveSlabTier,
  computePopulationView,
  matchPopulation,
  type SlabIdentityForMatch,
} from "@/lib/cgc-population/matching";
import type { CgcPopulationCard } from "@/lib/cgc-population/types";

function card(over: Record<string, unknown> = {}): CgcPopulationCard {
  const raw = {
    card_name: "Charmander",
    card_number: "289/S-P",
    set_name: "Sword & Shield Promos",
    year: "2022",
    parallel_or_variant: "Pokémon GO Gift Campaign",
    total_graded: 50,
    count_perfect_10: 1,
    count_pristine_10: 12,
    count_gem_mint_10: 20,
    count_mint_9: 17,
    ...over,
  };
  const v = validateCgcRecord(raw);
  if (!v.value) throw new Error("bad test card: " + v.errors.join());
  return v.value;
}

const cgcSlab = (over: Partial<SlabIdentityForMatch> = {}): SlabIdentityForMatch => ({
  grader: "CGC",
  card_name: "Charmander",
  card_number: "289/S-P",
  set_name: "Sword & Shield Promos",
  year: "2022",
  variation: "Pokémon GO Gift Campaign",
  language: "Japanese",
  grade: "10",
  grade_label: "PRISTINE",
  ...over,
});

describe("resolveSlabTier — designations stay distinct, grade 10 needs a designation", () => {
  it("maps each grade-10 designation to its OWN count field", () => {
    expect(resolveSlabTier("10", "PRISTINE")?.field).toBe("count_pristine_10");
    expect(resolveSlabTier("10", "GEM MINT")?.field).toBe("count_gem_mint_10");
    expect(resolveSlabTier("10", "PERFECT")?.field).toBe("count_perfect_10");
  });
  it("returns null for a bare grade 10 with no recognized designation (never guesses)", () => {
    expect(resolveSlabTier("10", "")).toBeNull();
    expect(resolveSlabTier("10", null)).toBeNull();
  });
  it("maps sub-10 grades and the lower bucket", () => {
    expect(resolveSlabTier("9.5", null)?.field).toBe("count_mint_plus_9_5");
    expect(resolveSlabTier("9", null)?.field).toBe("count_mint_9");
    expect(resolveSlabTier("7", null)?.field).toBe("count_nm_7");
    expect(resolveSlabTier("3", null)?.field).toBe("count_lower_grades");
  });
});

describe("computePopulationView — Pristine 10 uses count_pristine_10, not Gem Mint", () => {
  it("selects the exact designation count and splits higher/lower correctly", () => {
    const tier = resolveSlabTier("10", "PRISTINE")!;
    const v = computePopulationView(card(), tier);
    expect(v.at_grade).toBe(12); // count_pristine_10, NOT gem_mint (20)
    expect(v.higher).toBe(1); // only Perfect 10 ranks above Pristine
    expect(v.lower).toBe(20 + 17); // gem_mint + mint_9 (+ null tiers as 0)
    expect(v.total).toBe(50);
  });
  it("does not merge Perfect / Pristine / Gem Mint", () => {
    const pristine = computePopulationView(card(), resolveSlabTier("10", "PRISTINE")!);
    const gem = computePopulationView(card(), resolveSlabTier("10", "GEM MINT")!);
    expect(pristine.at_grade).toBe(12);
    expect(gem.at_grade).toBe(20);
    expect(pristine.at_grade).not.toBe(gem.at_grade);
  });
});

describe("matchPopulation — deterministic, conflict-gated", () => {
  it("confirms an exact match on name + full printed number + set", () => {
    const r = matchPopulation(cgcSlab(), [card()], true);
    expect(r.status).toBe("confirmed_exact");
    expect(r.card?.card_number).toBe("289/S-P");
  });

  it("is not applicable for a NON-CGC slab (PSA)", () => {
    const r = matchPopulation(cgcSlab({ grader: "PSA" }), [card()], true);
    expect(r.status).toBe("not_applicable");
  });

  it("distinguishes 'not indexed' from 'no record found'", () => {
    expect(matchPopulation(cgcSlab(), [], false).status).toBe("not_indexed");
    expect(matchPopulation(cgcSlab(), [], true).status).toBe("no_record_found");
  });

  it("REJECTS a same-number card in a DIFFERENT set (number alone never matches)", () => {
    const wrongSet = card({ set_name: "Some Other Set" });
    const r = matchPopulation(cgcSlab(), [wrongSet], true);
    expect(r.status).toBe("rejected");
    expect(r.rejected[0].conflicts).toContain("wrong set");
  });

  it("REJECTS a wrong parallel/promotional variation even with the same number", () => {
    const wrongVariant = card({ parallel_or_variant: "25th Anniversary" });
    const r = matchPopulation(cgcSlab(), [wrongVariant], true);
    expect(r.status).toBe("rejected");
    expect(r.rejected[0].conflicts).toContain("wrong parallel/promotional variation");
  });

  it("preserves the Japanese promo number: the numerator token cannot override a set conflict", () => {
    // Candidate shares numerator token 289 but is a different printed number in a
    // different set — must NOT match on the token.
    const other = card({ card_number: "289", set_name: "English Base Set", year: "1999", parallel_or_variant: null });
    const r = matchPopulation(cgcSlab(), [other], true);
    expect(r.status).toBe("rejected");
    expect(r.rejected[0].conflicts).toContain("wrong set");
  });

  it("is ambiguous when two eligible candidates remain", () => {
    const a = card({ card_id: 1 });
    const b = card({ card_id: 2 });
    const r = matchPopulation(cgcSlab(), [a, b], true);
    expect(r.status).toBe("ambiguous");
    expect(r.card).toBeNull();
  });

  it("does not raise a wrong-year conflict when the slab year is missing", () => {
    const r = matchPopulation(cgcSlab({ year: null }), [card()], true);
    expect(r.status).toBe("confirmed_exact");
  });
});
