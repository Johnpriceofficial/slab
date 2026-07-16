import { describe, it, expect } from "vitest";
import { resolveTierSource } from "@/lib/pricecharting/webpage/merge";
import { getValueForRequestedGrade } from "@/lib/pricecharting/grade-mapping";
import type { Product } from "@/lib/pricecharting/types";

describe("source priority: API vs public page", () => {
  it("(16) keeps the API and public-page as SEPARATE sources; exact API tier wins", () => {
    const r = resolveTierSource({ api_cents: 2100, page_cents: 2100, page_identity_verified: true });
    expect(r.source).toBe("PRICECHARTING_API"); // API priority
    expect(r.corroborated).toBe(true); // agreement corroborates...
    expect(r.value_cents).toBe(2100);
  });

  it("public page fills an API gap and is labeled as the public page (never API)", () => {
    const r = resolveTierSource({ api_cents: null, page_cents: 4539, page_identity_verified: true });
    expect(r.source).toBe("PRICECHARTING_PUBLIC_PAGE");
    expect(r.value_cents).toBe(4539);
    expect(r.confidence_hint).toBe("exact");
  });

  it("(17) surfaces a material API/page conflict, keeps API value, lowers confidence — never auto-picks higher", () => {
    const r = resolveTierSource({ api_cents: 2100, page_cents: 9000, page_identity_verified: true });
    expect(r.conflict).toBe(true);
    expect(r.value_cents).toBe(2100); // NOT the higher 9000
    expect(r.confidence_hint).toBe("exact_reduced_conflict");
  });

  it("ignores public-page value when identity is not verified", () => {
    const r = resolveTierSource({ api_cents: null, page_cents: 4539, page_identity_verified: false });
    expect(r.source).toBe("NONE");
    expect(r.value_cents).toBeNull();
  });

  it("(18) a graded tier with neither source is UNAVAILABLE — never falls back to loose-price", () => {
    const r = resolveTierSource({ api_cents: null, page_cents: null, page_identity_verified: true });
    expect(r.value_cents).toBeNull();
    expect(r.source).toBe("NONE");
    expect(r.confidence_hint).toBe("unavailable");
  });
});

describe("(19) raw-card valuation still uses loose-price", () => {
  const rawOnly: Product = {
    pricecharting_id: "P", name: "Some Card", console_or_category: "Pokemon Cards",
    release_date: null, upc: null, asin: null, epid: null, genre: null,
    raw_prices: { "loose-price": 500 },
  };
  it("an ungraded (raw) card resolves to the loose-price ungraded tier", () => {
    const v = getValueForRequestedGrade(rawOnly, undefined, null, { category: "card" });
    expect(v.value_pennies).toBe(500);
    expect(v.selected_tier_key).toBe("ungraded");
  });
});
