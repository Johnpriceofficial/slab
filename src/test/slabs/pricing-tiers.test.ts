import { describe, it, expect } from "vitest";
import {
  buildPriceTiers,
  buildPricingPersist,
  hydratePriceTiers,
  isNewerPricing,
  graderTenKey,
} from "@/lib/slabs/pricing-tiers";

const CGC10_PRISTINE = { grader: "CGC", grade: "10", grade_label: "PRISTINE" };
const CGC10_PERFECT = { grader: "CGC", grade: "10", grade_label: "PERFECT" };
const CGC10_PLAIN = { grader: "CGC", grade: "10", grade_label: null };
const CGC10_GEM = { grader: "CGC", grade: "10", grade_label: "Gem Mint" };

describe("buildPriceTiers — CGC 10 Pristine is a DISTINCT tier (never a decorated CGC 10)", () => {
  it("never decorates the ordinary CGC 10 tier with the slab's Pristine designation", () => {
    const tiers = buildPriceTiers({ cgc_10: 4250, psa_10: 6658, ungraded: 413 }, CGC10_PRISTINE);
    const cgc = tiers.find((t) => t.tier === "cgc_10")!;
    // Ordinary CGC 10 holds its real value but is NOT the exact tier and carries
    // NO Pristine designation — the API's condition-17-price is not a Pristine price.
    expect(cgc.value_cents).toBe(4250);
    expect(cgc.exact_match).toBe(false);
    expect(cgc.designation).toBeNull();
  });

  it("models CGC 10 Pristine as its own exact tier — unavailable (null) when the source has no Pristine value", () => {
    const tiers = buildPriceTiers({ cgc_10: 4250, ungraded: 413 }, CGC10_PRISTINE);
    const pristine = tiers.find((t) => t.tier === "cgc_10_pristine")!;
    expect(pristine).toBeTruthy();
    expect(pristine.exact_match).toBe(true);
    expect(pristine.designation).toBe("Pristine");
    expect(pristine.value_cents).toBeNull(); // never synthesized from ordinary CGC 10
    expect(pristine.available).toBe(false);
    // Exactly one exact tier, and it is the Pristine tier — never the ordinary one.
    expect(tiers.filter((t) => t.exact_match).map((t) => t.tier)).toEqual(["cgc_10_pristine"]);
  });

  it("adds a distinct Pristine value ONLY when the source genuinely supplies one", () => {
    const tiers = buildPriceTiers({ cgc_10: 4250, cgc_10_pristine: 6000 }, CGC10_PRISTINE);
    const pristine = tiers.find((t) => t.tier === "cgc_10_pristine")!;
    expect(pristine.value_cents).toBe(6000);
    expect(pristine.available).toBe(true);
    expect(pristine.exact_match).toBe(true);
  });

  it("keeps CGC Perfect distinct from both Pristine and ordinary CGC 10", () => {
    const tiers = buildPriceTiers(
      { cgc_10: 4250, cgc_10_pristine: 6000, cgc_10_perfect: 9000 },
      CGC10_PERFECT,
    );
    expect(tiers.find((t) => t.tier === "cgc_10_perfect")).toMatchObject({
      value_cents: 9000,
      designation: "Perfect",
      exact_match: true,
    });
    expect(tiers.find((t) => t.tier === "cgc_10_pristine")?.exact_match).toBe(false);
    expect(tiers.find((t) => t.tier === "cgc_10")?.exact_match).toBe(false);
  });

  it("never copies a Pristine value into the Perfect tier", () => {
    const perfect = buildPriceTiers({ cgc_10: 4250, cgc_10_pristine: 6000 }, CGC10_PERFECT)
      .find((t) => t.tier === "cgc_10_perfect")!;
    expect(perfect.value_cents).toBeNull();
    expect(perfect.available).toBe(false);
    expect(perfect.exact_match).toBe(true);
  });

  it("treats a plain or Gem-Mint CGC 10 as the exact ordinary tier (no Pristine row)", () => {
    for (const id of [CGC10_PLAIN, CGC10_GEM]) {
      const tiers = buildPriceTiers({ cgc_10: 2174, psa_10: 6658 }, id);
      const cgc = tiers.find((t) => t.tier === "cgc_10")!;
      expect(cgc.exact_match).toBe(true);
      expect(cgc.designation).toBeNull();
      expect(tiers.some((t) => t.tier === "cgc_10_pristine")).toBe(false);
      const psa = tiers.find((t) => t.tier === "psa_10")!;
      expect(psa.exact_match).toBe(false); // never interchangeable across graders
    }
  });

  it("stores null for unavailable tiers, never $0, and never fabricates a value", () => {
    const tiers = buildPriceTiers({ ungraded: 413 }, CGC10_PLAIN); // only ungraded present
    const cgc = tiers.find((t) => t.tier === "cgc_10")!;
    expect(cgc.value_cents).toBeNull();
    expect(cgc.available).toBe(false);
    expect(tiers.find((t) => t.tier === "ungraded")!.value_cents).toBe(413);
    // Every standard tier is represented (schema), values null when absent.
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
    const persist = buildPricingPersist({ cgc_10: 4250 }, CGC10_PLAIN, "2026-07-13T10:00:00.000Z");
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
