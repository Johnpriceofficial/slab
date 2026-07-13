import { describe, it, expect } from "vitest";
import {
  buildPriceTiers,
  buildPricingPersist,
  hydratePriceTiers,
  isNewerPricing,
  graderTenKey,
} from "@/lib/slabs/pricing-tiers";

const CGC10 = { grader: "CGC", grade: "10", grade_label: "PRISTINE" };

describe("buildPriceTiers", () => {
  it("marks the slab's own grader+10 tier as the exact match, carrying the designation", () => {
    const tiers = buildPriceTiers({ cgc_10: 4250, psa_10: 6658, ungraded: 413 }, CGC10);
    const cgc = tiers.find((t) => t.tier === "cgc_10")!;
    expect(cgc.exact_match).toBe(true);
    expect(cgc.designation).toBe("Pristine");
    expect(cgc.value_cents).toBe(4250);
    expect(cgc.available).toBe(true);
    // Never treated as interchangeable: PSA 10 is a distinct, non-exact tier.
    const psa = tiers.find((t) => t.tier === "psa_10")!;
    expect(psa.exact_match).toBe(false);
    expect(psa.grader).toBe("PSA");
  });

  it("stores null for unavailable tiers, never $0, and never fabricates a value", () => {
    const tiers = buildPriceTiers({ ungraded: 413 }, CGC10); // only ungraded present
    const cgc = tiers.find((t) => t.tier === "cgc_10")!;
    expect(cgc.value_cents).toBeNull();
    expect(cgc.available).toBe(false);
    expect(tiers.find((t) => t.tier === "ungraded")!.value_cents).toBe(413);
    // Every known tier is represented (schema), values null when absent.
    expect(tiers).toHaveLength(9);
  });

  it("has no exact tier for a non-10 grade (no grader-specific tier exists)", () => {
    const tiers = buildPriceTiers({ grade_9_general: 2000 }, { grader: "CGC", grade: "9", grade_label: null });
    expect(tiers.some((t) => t.exact_match)).toBe(false);
  });
});

describe("graderTenKey", () => {
  it("maps grader + grade 10 to the tier key, and returns null otherwise", () => {
    expect(graderTenKey("CGC", "10")).toBe("cgc_10");
    expect(graderTenKey("psa", "10")).toBe("psa_10");
    expect(graderTenKey("CGC", "9")).toBeNull();
    expect(graderTenKey("RAW", "10")).toBeNull();
  });
});

describe("buildPricingPersist + hydratePriceTiers round-trip", () => {
  it("persists source, retrieved_at, and the tier array; hydrates back identically", () => {
    const persist = buildPricingPersist({ cgc_10: 4250 }, CGC10, "2026-07-13T10:00:00.000Z");
    expect(persist.source).toBe("PriceCharting");
    expect(persist.retrieved_at).toBe("2026-07-13T10:00:00.000Z");
    const hydrated = hydratePriceTiers(persist);
    expect(hydrated).toEqual(persist.tiers);
  });

  it("hydrates null/empty persisted data to null (backward-compatible sparse fallback)", () => {
    expect(hydratePriceTiers(null)).toBeNull();
    expect(hydratePriceTiers(undefined)).toBeNull();
    expect(hydratePriceTiers({ source: "PriceCharting", retrieved_at: "x", tiers: [] })).toBeNull();
  });
});

describe("isNewerPricing — stale-write guard", () => {
  it("applies an equal-or-newer response and rejects an older (stale) one", () => {
    const older = "2026-07-13T10:00:00.000Z";
    const newer = "2026-07-13T11:00:00.000Z";
    expect(isNewerPricing(older, newer)).toBe(true); // newer overwrites
    expect(isNewerPricing(newer, older)).toBe(false); // stale rejected
    expect(isNewerPricing(older, older)).toBe(true); // equal is idempotent-ok
  });

  it("applies when nothing is stored yet, and never overwrites with an unstamped response", () => {
    expect(isNewerPricing(null, "2026-07-13T10:00:00.000Z")).toBe(true);
    expect(isNewerPricing("2026-07-13T10:00:00.000Z", null)).toBe(false);
    expect(isNewerPricing(null, null)).toBe(false);
  });
});
