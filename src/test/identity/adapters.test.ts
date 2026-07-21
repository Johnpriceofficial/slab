import { describe, it, expect } from "vitest";
import { slabIdentity, cardIdentity } from "@/lib/identity/adapters";
import type { Slab } from "@/lib/slabs/types";
import type { InventoryCard } from "@/lib/cards/api";

const slab = {
  id: "s1", inventory_number: 1, inventory_prefix: "S", inventory_sequence: 1, inventory_code: "S0001",
  card_name: "Charizard", set_name: "Base Set", card_number: "4/102", language: "English",
  rarity: "Holo Rare", variation: "", year: 1999, grader: "PSA", grade: "10", grade_label: "GEM MT",
  certification_number: "12345678", pricecharting_product_id: "6910",
} as unknown as Slab;

const card = {
  id: "c1", inventory_code: "R0001", card_name: "Charizard", set_name: "Base Set", card_number: "4/102", rarity: "Holo Rare",
} as unknown as InventoryCard;

describe("identity adapters unify slabs and raw cards", () => {
  it("a slab and a raw card hash the same when their KNOWN identity fields match", async () => {
    // A raw-card record carries only name/set/number/rarity today, so compare it
    // to a slab whose other identity fields are absent — they are the same card.
    const bareSlab = { ...slab, language: null, year: null, variation: null } as unknown as Slab;
    const s = await slabIdentity(bareSlab);
    const c = await cardIdentity(card);
    expect(s.hash).toBe(c.hash);
  });

  it("a fully-specified slab hashes differently from a raw card missing language/year", async () => {
    // Surfaces a real persistence gap: the raw `cards` record cannot yet store
    // language/year/finish/variation, so its identity is lossier than a slab's.
    const s = await slabIdentity(slab); // has language + year
    const c = await cardIdentity(card); // lacks them
    expect(s.hash).not.toBe(c.hash);
  });

  it("the slab carries the specimen fields; the raw card does not", async () => {
    const s = await slabIdentity(slab);
    const c = await cardIdentity(card);
    expect(s.grade).toBe("10");
    expect(s.certification_number).toBe("12345678");
    expect(c.grade).toBe("");
    expect(c.certification_number).toBe("");
  });

  it("both derive an eBay query; only the slab includes the grade", async () => {
    expect((await slabIdentity(slab)).ebay_query).toContain("PSA 10");
    expect((await cardIdentity(card)).ebay_query).toBe("Charizard Base Set 4/102");
  });
});
