/**
 * Certification number identifies the physical SPECIMEN, never the card's market
 * price. Two slabs of the same card / grader / grade / designation with different
 * certificates must receive the same canonical identity, the same PriceCharting
 * search, the same tier, and the same value. These regression tests lock that in
 * so cert can never leak into price discovery.
 *
 * (The Rayquaza blank value is unrelated: the correct product 3472875 was found;
 * the live PriceCharting API just returned only loose-price. That is preserved
 * here — the fixtures supply the graded field to prove the matching behavior.)
 */
import { describe, it, expect } from "vitest";
import { buildIdentity, specimenKey } from "@/lib/identity/identity";
import { priceChartingQuery, ebayExactQuery } from "@/lib/market/query";
import { buildSearchQuery } from "@/lib/pricecharting/matching";
import { getValueForRequestedGrade } from "@/lib/pricecharting/grade-mapping";
import { verifiedBlockers } from "@/lib/slabs/save-slab";
import type { CardItemInput, Product } from "@/lib/pricecharting/types";

const CARD = {
  card_name: "Rayquaza VMAX",
  set: "Blue Sky Stream",
  card_number: "047/067",
  language: "Japanese",
  year: "2021",
  rarity: "RRR",
  finish: "Holo",
  variation: "Holo",
  grader: "CGC",
  grade: "10",
  grade_label: "PRISTINE",
};

// Three physical specimens of the SAME card — different certificates.
const CERTS = ["6165347099", "1234567890", "9876543210"];

// A product fixture that DOES carry the graded (Pristine) field, so we can prove
// the value is identical regardless of certificate.
function product(): Product {
  return {
    pricecharting_id: "3472875",
    name: "Rayquaza VMAX #47",
    console_or_category: "Pokemon Japanese Blue Sky Stream",
    release_date: null, upc: null, asin: null, epid: null, genre: null,
    raw_prices: { "condition-19-price": 4539 },
  };
}

const valuePristine = () => getValueForRequestedGrade(product(), "CGC", 10, { category: "card", designation: "PRISTINE" });

describe("certification number is excluded from market-price matching", () => {
  it("(1,2) same card/grader/grade/designation, DIFFERENT cert → same hash, query, tier, value", async () => {
    const ids = await Promise.all(CERTS.map((c) => buildIdentity({ ...CARD, certification_number: c })));
    // Same canonical card identity...
    expect(new Set(ids.map((i) => i.hash)).size).toBe(1);
    // ...same provider search queries (grade included, cert never)...
    expect(new Set(ids.map(priceChartingQuery)).size).toBe(1);
    expect(new Set(ids.map(ebayExactQuery)).size).toBe(1);
    // ...and the same selected tier + value (cert is not even a valuation input).
    const vals = CERTS.map(valuePristine);
    expect(new Set(vals.map((v) => v.selected_tier_key)).size).toBe(1);
    expect(new Set(vals.map((v) => v.value_pennies)).size).toBe(1);
    expect(vals[0].value_pennies).toBe(4539);
    expect(vals[0].selected_tier_key).toBe("cgc_10_pristine");
  });

  it("(3) certification number IS the specimen discriminator — different certs are different specimens", async () => {
    const [a, b] = await Promise.all([
      buildIdentity({ ...CARD, certification_number: CERTS[0] }),
      buildIdentity({ ...CARD, certification_number: CERTS[1] }),
    ]);
    expect(a.hash).toBe(b.hash); // same card
    expect(specimenKey(a)).not.toBe(specimenKey(b)); // different physical specimens
    // The specimen key is built FROM the cert (grader-scoped) — that is what
    // powers duplicate detection, and it is separate from the card hash.
    expect(specimenKey(a)).toContain(CERTS[0]);
    expect(specimenKey(a).startsWith(a.hash)).toBe(true);
  });

  it("(4) missing cert blocks a VERIFIED SAVE but never blocks valuation", async () => {
    // Verification gate DOES require a cert...
    const blockers = verifiedBlockers({ card_name: CARD.card_name, grader: "CGC", grade: "10", certification_number: null }, true);
    expect(blockers).toContain("Certification number");
    // ...but valuation does not depend on the cert at all.
    expect(valuePristine().value_pennies).toBe(4539);
  });

  it("(5) a card with NO certification number still hashes, queries, and values", async () => {
    const id = await buildIdentity({ ...CARD, certification_number: null });
    expect(id.hash).toBeTruthy();
    expect(priceChartingQuery(id)).toMatch(/rayquaza/i);
    expect(valuePristine().value_pennies).toBe(4539);
  });

  it("(6) card_number is material to identity; certification_number is not — and the two are never confused", async () => {
    const base = await buildIdentity({ ...CARD, certification_number: CERTS[0] });
    const diffCert = await buildIdentity({ ...CARD, certification_number: CERTS[1] });
    const diffNumber = await buildIdentity({ ...CARD, card_number: "001/067", certification_number: CERTS[0] });
    expect(diffCert.hash).toBe(base.hash); // changing ONLY the cert → same card
    expect(diffNumber.hash).not.toBe(base.hash); // changing the card number → different card
    // The search query carries the card number, never the certificate.
    const q = priceChartingQuery(base);
    expect(q).toContain("047/067");
    expect(q).not.toContain(CERTS[0]);
  });

  it("(7) PriceCharting product id is catalog provenance, not a specimen identifier", async () => {
    const a = await buildIdentity({ ...CARD, certification_number: CERTS[0], pricecharting_product_id: "3472875" });
    const b = await buildIdentity({ ...CARD, certification_number: CERTS[1], pricecharting_product_id: "3472875" });
    expect(a.pricecharting_product_id).toBe("3472875");
    expect(a.hash).toBe(b.hash); // both link to the SAME catalog card
    expect(specimenKey(a)).not.toBe(specimenKey(b)); // but remain distinct specimens
    expect(specimenKey(a)).not.toContain("3472875"); // product id never keys the specimen
  });

  it("the intake search-query builder ignores a certification number even if one is present on the input", () => {
    const item = {
      category: "trading_card",
      card_name: "Rayquaza VMAX",
      set: "Blue Sky Stream",
      card_number: "047/067",
      certification_number: CERTS[0],
    } as CardItemInput;
    const q = buildSearchQuery(item);
    expect(q.toLowerCase()).toContain("rayquaza");
    expect(q).not.toContain(CERTS[0]); // the cert never reaches the catalog search
  });
});
