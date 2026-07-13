import { describe, it, expect } from "vitest";
import { saveSlab } from "@/lib/slabs/save-slab";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import { buildPricingPersist, type SlabPricingWrite } from "@/lib/slabs/pricing-tiers";
import { makeMockDao, validInput, image } from "./helpers";

const ID = { grader: "CGC", grade: "10", grade_label: null };
const AVAILABLE = { cgc_10: 4250, ungraded: 413, psa_10: 6658, grade_9_general: 2174 };

function pricingWrite(): SlabPricingWrite {
  return { persist: buildPricingPersist(AVAILABLE, ID, "2026-07-13T10:00:00.000Z"), raw: { "cgc_10": 4250 } };
}

describe("saveSlab — PriceCharting tier persistence", () => {
  it("persists the confirmed tier table via applySlabPricing on success", async () => {
    const { dao, state } = makeMockDao();
    const res = await saveSlab(validInput({ certification_number: "PC1" }), image(), image(), dao, pricingWrite());
    expect(res.status).toBe("success");
    expect(state.pricingWrites).toHaveLength(1);
    const written = state.pricingWrites[0].write.persist;
    expect(written.tiers.find((t) => t.tier === "cgc_10")?.value_cents).toBe(4250);
    expect(written.retrieved_at).toBe("2026-07-13T10:00:00.000Z");
  });

  it("does not attempt a pricing write when no pricing is supplied", async () => {
    const { dao, state } = makeMockDao();
    const res = await saveSlab(validInput({ certification_number: "PC2" }), image(), image(), dao);
    expect(res.status).toBe("success");
    expect(state.pricingWrites).toHaveLength(0);
  });

  it("treats a pricing-write failure as NON-FATAL — the slab still saves", async () => {
    const { dao } = makeMockDao({ failPricing: true });
    const res = await saveSlab(validInput({ certification_number: "PC3" }), image(), image(), dao, pricingWrite());
    expect(res.status).toBe("success"); // pricing enrichment never blocks the save
  });
});

describe("shared component — intake and detail render from identical models", () => {
  const common = {
    final_cents: 4250,
    guide_cents: 4250,
    quick_cents: 3400,
    replacement_cents: 4675,
    valuation_confidence: "verified",
    price_variance_percent: 0,
    grader: "CGC",
    grade: "10",
    grade_label: null,
    product_name: "Rayquaza VMAX #047",
    product_id: "3472875",
  };

  it("the intake model (live available values) equals the detail model (persisted tiers)", () => {
    // Intake builds tiers from the live value map...
    const intake = buildPricingModel({ ...common, available_values_cents: AVAILABLE });
    // ...detail hydrates the SAME tiers that were persisted.
    const persisted = buildPricingPersist(AVAILABLE, ID, "2026-07-13T10:00:00.000Z");
    const detail = buildPricingModel({ ...common, tiers: persisted.tiers });
    // Same inputs → byte-identical model → pixel-identical render.
    expect(detail).toEqual(intake);
    const exact = detail.grade_rows.find((r) => r.kind === "exact")!;
    expect(exact.label).toBe("CGC 10");
    expect(detail.grade_rows.find((r) => r.key === "ungraded")!.note).toBe("Raw-card reference only");
    expect(detail.grade_rows.find((r) => r.key === "psa_10")!.note).toBe("Comparison only");
  });

  it("backward-compat: an older slab with no persisted tiers falls back to the sparse exact-tier row", () => {
    const detail = buildPricingModel({ ...common, tiers: null }); // legacy row
    expect(detail.match_kind).toBe("exact");
    // Only the synthesized exact tier is shown; no full comparison table.
    expect(detail.grade_rows).toHaveLength(1);
    expect(detail.grade_rows[0].kind).toBe("exact");
    expect(detail.grade_rows[0].cents).toBe(4250);
  });
});
