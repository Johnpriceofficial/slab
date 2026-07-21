/**
 * Regression: the "PriceCharting Guide Value" metric on the primary
 * valuation card must not claim PriceCharting provenance for a manually
 * entered number (match_kind === "manual"). Verified against production
 * record 3455aa7b-a727-4814-91eb-9a3dd6f17846 (slab S0001).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SlabPricingCard } from "@/components/slabs/SlabPricingCard";
import { buildPricingModel } from "@/lib/slabs/pricing-display";

describe("SlabPricingCard — guide-value label reflects provenance", () => {
  it("labels a manual valuation 'Manually-Entered Guide Value', never 'PriceCharting Guide Value'", () => {
    const model = buildPricingModel({
      final_cents: 4250,
      guide_cents: 4250,
      quick_cents: 3400,
      replacement_cents: 4675,
      valuation_confidence: "moderate",
      valuation_provenance: "manual_guide",
      price_variance_percent: 0,
      grader: "CGC",
      grade: "10",
      grade_label: "PRISTINE",
      product_name: null,
      product_id: null,
    });
    render(<SlabPricingCard model={model} />);
    expect(screen.getByText("Manually-Entered Guide Value")).toBeInTheDocument();
    expect(screen.queryByText("PriceCharting Guide Value")).not.toBeInTheDocument();
  });

  it("keeps the 'PriceCharting Guide Value' label for a real confirmed-tier valuation", () => {
    const model = buildPricingModel({
      final_cents: 12000,
      guide_cents: 12000,
      quick_cents: 9600,
      replacement_cents: 13200,
      valuation_confidence: "high",
      valuation_provenance: "pricecharting_exact_tier",
      price_variance_percent: 0,
      grader: "PSA",
      grade: "10",
      grade_label: null,
      product_name: "Some Card",
      product_id: "123",
      designation_exact: true,
    });
    render(<SlabPricingCard model={model} />);
    expect(screen.getByText("PriceCharting Guide Value")).toBeInTheDocument();
    expect(screen.queryByText("Manually-Entered Guide Value")).not.toBeInTheDocument();
  });
});
