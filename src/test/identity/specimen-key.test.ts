import { describe, it, expect } from "vitest";
import { buildIdentity, specimenKey, specimenKeyResult } from "@/lib/identity/identity";

const CARD = { card_name: "Charizard", set: "Base Set", card_number: "4/102", language: "English", year: "1999" };

describe("specimenKey", () => {
  it("keys a certified specimen by card hash + grader + certification number", async () => {
    const id = await buildIdentity({ ...CARD, grader: "PSA", grade: "10", certification_number: "12-34 5678" });
    const key = specimenKey(id);
    expect(key.startsWith(id.hash)).toBe(true);
    expect(key).toBe(`${id.hash}:psa:12345678`); // cert normalized (separators stripped)
  });

  it("keys a raw specimen by card hash + inventory code", async () => {
    const id = await buildIdentity(CARD); // no grader/cert
    expect(specimenKey(id, "R0001")).toBe(`${id.hash}:R0001`);
  });

  it("gives two raw copies of the same card DIFFERENT specimen keys", async () => {
    const id = await buildIdentity(CARD);
    expect(specimenKey(id, "R0001")).not.toBe(specimenKey(id, "R0002"));
  });

  it("gives a PSA 10 and a CGC 10 of the same card the SAME card hash but DIFFERENT specimen keys", async () => {
    const psa = await buildIdentity({ ...CARD, grader: "PSA", grade: "10", certification_number: "111" });
    const cgc = await buildIdentity({ ...CARD, grader: "CGC", grade: "10", grade_label: "Pristine", certification_number: "222" });
    expect(psa.hash).toBe(cgc.hash); // same card
    expect(specimenKey(psa)).not.toBe(specimenKey(cgc)); // different physical specimens
  });

  it("NEVER collapses to the bare card hash when neither cert nor inventory code is present", async () => {
    const id = await buildIdentity(CARD); // no cert, and we pass no inventory code
    const result = specimenKeyResult(id);
    expect(result.status).toBe("incomplete");
    expect(result.key).toBeNull();
    // The string form throws rather than silently returning the shared card hash,
    // which would give two different physical specimens the same key.
    expect(() => specimenKey(id)).toThrow(/certification number|inventory code/i);
  });
});
