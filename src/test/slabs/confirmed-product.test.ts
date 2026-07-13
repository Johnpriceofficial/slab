import { describe, it, expect } from "vitest";
import { evaluateConfirmedProduct, type ConfirmedLookup } from "@/lib/slabs/confirmed-product";
import { computeValuationConfidence, type ConfidenceSignals } from "@/lib/slabs/valuation-derive";

const ok: ConfirmedLookup = { found: true, disqualified: false, requires_confirmation: false, conflicts: [] };

describe("§5 confirmed-product-id-first state machine", () => {
  it("no confirmed id → fuzzy search allowed", () => {
    const d = evaluateConfirmedProduct(null, null);
    expect(d.state).toBe("no_confirmed_id");
    expect(d.allow_fuzzy).toBe(true);
  });

  it("compatible confirmed product → retained, link preserved, NO silent fuzzy replace", () => {
    const d = evaluateConfirmedProduct("5427932", ok);
    expect(d.state).toBe("retained");
    expect(d.preserve_link).toBe(true);
    expect(d.allow_fuzzy).toBe(false); // never silently replaced
  });

  it("soft uncertainty → link preserved, review recommended, not replaced", () => {
    const d = evaluateConfirmedProduct("5427932", { found: true, disqualified: false, requires_confirmation: true, conflicts: ["Year mismatch: wanted 1998, candidate 2021"] });
    expect(d.state).toBe("soft_review");
    expect(d.preserve_link).toBe(true);
    expect(d.allow_fuzzy).toBe(false);
  });

  it("hard conflict → confirmation_invalidated WITHOUT deleting history; fuzzy offered", () => {
    const d = evaluateConfirmedProduct("5427932", { found: true, disqualified: true, requires_confirmation: true, conflicts: ["character mismatch: candidate is missing charmander"] });
    expect(d.state).toBe("confirmation_invalidated");
    expect(d.preserve_link).toBe(true); // history preserved, not unlinked
    expect(d.allow_fuzzy).toBe(true);
    expect(d.reason).toMatch(/character mismatch/);
  });

  it("product no longer exists → unavailable, id preserved, fuzzy recovery offered", () => {
    const d = evaluateConfirmedProduct("5427932", { found: false, disqualified: false, requires_confirmation: true, conflicts: [] });
    expect(d.state).toBe("unavailable");
    expect(d.preserve_link).toBe(true);
    expect(d.allow_fuzzy).toBe(true);
  });

  it("explicit 'Search again' allows fuzzy even on a retained product", () => {
    const d = evaluateConfirmedProduct("5427932", ok, true);
    expect(d.state).toBe("retained");
    expect(d.allow_fuzzy).toBe(true);
  });
});

describe("§6 multi-signal valuation confidence", () => {
  const base: ConfidenceSignals = {
    guide_available: true,
    identity_confirmed: true,
    exact_tier: true,
    interpolated: false,
    visual_confirmed: false,
    pricing_age_days: 0,
    manual_override: false,
  };

  it("exact tier + identity + visual → Verified; without visual → High", () => {
    expect(computeValuationConfidence({ ...base, visual_confirmed: true })).toBe("verified");
    expect(computeValuationConfidence({ ...base, visual_confirmed: false })).toBe("high");
  });

  it("interpolated → Moderate", () => {
    expect(computeValuationConfidence({ ...base, exact_tier: false, interpolated: true })).toBe("moderate");
  });

  it("no usable guide value → Manual (identity confirmation alone is NOT enough)", () => {
    // 5427932 shape: identity confirmed, but CGC-10 tier unavailable.
    expect(computeValuationConfidence({ ...base, guide_available: false })).toBe("manual");
  });

  it("a user override is always Manual", () => {
    expect(computeValuationConfidence({ ...base, manual_override: true })).toBe("manual");
  });

  it("stale pricing downgrades one step; unconfirmed identity caps at Moderate", () => {
    expect(computeValuationConfidence({ ...base, visual_confirmed: true, pricing_age_days: 90 })).toBe("high"); // verified → high
    expect(computeValuationConfidence({ ...base, identity_confirmed: false })).toBe("moderate"); // high capped to moderate
  });
});
