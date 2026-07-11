import { describe, it, expect } from "vitest";
import { extractCharacters, characterMatch } from "@/lib/pricecharting/character-name";

describe("extractCharacters", () => {
  it("extracts major characters, stripping card-type suffixes and joiners", () => {
    expect(extractCharacters("Blastoise & Piplup GX")).toEqual(["blastoise", "piplup"]);
    expect(extractCharacters("Blastoise and Piplup GX")).toEqual(["blastoise", "piplup"]);
    expect(extractCharacters("Charizard")).toEqual(["charizard"]);
    expect(extractCharacters("Venusaur & Snivy GX")).toEqual(["venusaur", "snivy"]);
  });
});

describe("characterMatch", () => {
  it("matches when every major character is present ('&' == 'and')", () => {
    expect(characterMatch("Blastoise & Piplup GX", "Blastoise & Piplup GX #16").ok).toBe(true);
    expect(characterMatch("Blastoise and Piplup", "Blastoise & Piplup GX #16").ok).toBe(true);
  });

  it("REJECTS a replaced character — Piplup is not Pikachu", () => {
    const m = characterMatch("Blastoise & Pikachu GX", "Blastoise & Piplup GX #16");
    expect(m.ok).toBe(false);
    expect(m.missing).toContain("pikachu");
  });

  it("rejects a candidate missing a major character", () => {
    const m = characterMatch("Blastoise & Piplup GX", "Venusaur & Snivy GX #66");
    expect(m.ok).toBe(false);
    expect(m.missing).toEqual(expect.arrayContaining(["blastoise", "piplup"]));
  });

  it("never fuzzily equates two distinct Pokémon", () => {
    expect(characterMatch("Pikachu", "Pichu #1").ok).toBe(false);
    expect(characterMatch("Piplup", "Prinplup").ok).toBe(false);
  });
});
