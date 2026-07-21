import { describe, it, expect } from "vitest";
import { guideValueSourceMarker, VALUATION_PROVENANCE } from "@/lib/slabs/valuation-provenance";

describe("guideValueSourceMarker — the guide-value column is source-neutral", () => {
  it("marks operator-entered values as manual so they are never shown as a bare PriceCharting price", () => {
    expect(guideValueSourceMarker("manual_guide")).toBe("manual");
    expect(guideValueSourceMarker("manual_value")).toBe("manual");
  });

  it("marks a compatible tier and an estimate distinctly", () => {
    expect(guideValueSourceMarker("pricecharting_compatible_tier")).toBe("compatible");
    expect(guideValueSourceMarker("pricecharting_estimate")).toBe("estimate");
  });

  it("adds NO marker for a genuine exact-tier value (or when unavailable/absent)", () => {
    expect(guideValueSourceMarker("pricecharting_exact_tier")).toBeNull();
    expect(guideValueSourceMarker("tier_unavailable")).toBeNull();
    expect(guideValueSourceMarker(null)).toBeNull();
    expect(guideValueSourceMarker(undefined)).toBeNull();
  });

  it("returns a value for every provenance in the canonical enum (no unhandled case)", () => {
    for (const p of VALUATION_PROVENANCE) {
      const m = guideValueSourceMarker(p);
      expect(m === null || m === "manual" || m === "compatible" || m === "estimate").toBe(true);
    }
  });
});
