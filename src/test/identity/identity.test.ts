import { describe, it, expect } from "vitest";
import { buildIdentity, identityHash, canonicalIdentityString, ebayQueryFor, CARD_IDENTITY_FIELDS } from "@/lib/identity/identity";

const CHARIZARD = {
  card_name: "Charizard",
  set: "Base Set",
  card_number: "4/102",
  language: "English",
  rarity: "Holo Rare",
  year: "1999",
};

describe("canonical identity hash", () => {
  it("is stable across casing and whitespace differences", async () => {
    const a = await identityHash(CHARIZARD);
    const b = await identityHash({ ...CHARIZARD, card_name: "  CHARIZARD ", set: "base   set" });
    expect(a).toBe(b);
  });

  it("canonicalizes the card number so 004/102 == 4/102", async () => {
    const a = await identityHash({ ...CHARIZARD, card_number: "4/102" });
    const b = await identityHash({ ...CHARIZARD, card_number: "004/102" });
    expect(a).toBe(b);
  });

  it("distinguishes different cards", async () => {
    const charizard = await identityHash(CHARIZARD);
    const blastoise = await identityHash({ ...CHARIZARD, card_name: "Blastoise", card_number: "2/102" });
    expect(charizard).not.toBe(blastoise);
  });

  it("is IDENTICAL for a raw copy, a PSA 10, and a CGC 9.5 of the same card", async () => {
    // The specimen (grade/cert/grader) is deliberately excluded from the card
    // hash — the same card links to the same market data regardless of grade.
    const raw = await identityHash(CHARIZARD);
    const psa10 = await identityHash({ ...CHARIZARD, grader: "PSA", grade: "10", certification_number: "12345678" });
    const cgc = await identityHash({ ...CHARIZARD, grader: "CGC", grade: "9.5", certification_number: "99999999" });
    expect(psa10).toBe(raw);
    expect(cgc).toBe(raw);
  });

  it("distinguishes the same card in different languages, finishes, or variations", async () => {
    const en = await identityHash(CHARIZARD);
    const jp = await identityHash({ ...CHARIZARD, language: "Japanese" });
    const reverse = await identityHash({ ...CHARIZARD, finish: "Reverse Holo" });
    expect(jp).not.toBe(en);
    expect(reverse).not.toBe(en);
  });

  it("produces a 64-char hex digest", async () => {
    expect(await identityHash(CHARIZARD)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalIdentityString", () => {
  it("covers exactly the card-identity fields and excludes specimen fields", () => {
    const s = canonicalIdentityString({ ...CHARIZARD, grader: "PSA", grade: "10", certification_number: "1" });
    for (const field of CARD_IDENTITY_FIELDS) expect(s).toContain(`${field}=`);
    expect(s).not.toContain("grader");
    expect(s).not.toContain("certification");
  });
});

describe("derived queries", () => {
  it("builds an eBay query with grader + grade for a graded specimen", () => {
    expect(ebayQueryFor({ ...CHARIZARD, grader: "PSA", grade: "10" })).toBe("Charizard Base Set 4/102 PSA 10");
  });

  it("omits the grade for a raw card", () => {
    expect(ebayQueryFor(CHARIZARD)).toBe("Charizard Base Set 4/102");
  });
});

describe("buildIdentity", () => {
  it("assembles the full object with hash, ebay_query, and a PriceCharting URL", async () => {
    const identity = await buildIdentity({ ...CHARIZARD, grader: "PSA", grade: "10", pricecharting_product_id: "6910" });
    expect(identity.card_name).toBe("Charizard");
    expect(identity.grade).toBe("10");
    expect(identity.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.ebay_query).toContain("PSA 10");
    expect(identity.pricecharting_url).toContain("product=6910");
    expect(identity.year).toBe("1999");
  });

  it("leaves the PriceCharting URL empty without a product id", async () => {
    expect((await buildIdentity(CHARIZARD)).pricecharting_url).toBe("");
  });
});
