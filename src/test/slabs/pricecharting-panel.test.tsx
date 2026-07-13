import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PriceChartingPanel } from "@/components/slabs/PriceChartingPanel";
import { priceChartingSearch } from "@/lib/slabs/data";

vi.mock("@/lib/slabs/data", () => ({
  priceChartingSearch: vi.fn(),
  priceChartingValue: vi.fn(),
  priceChartingOfferImage: vi.fn(),
  priceChartingLookup: vi.fn(),
}));

vi.mock("@/components/slabs/CandidateDebugPanel", () => ({ CandidateDebugPanel: () => null }));

const identity = {
  card_name: "Charmander",
  set: "Scarlet & Violet Promo",
  card_number: "289/S-P",
  year: 2023,
  language: "Japanese",
  variation: "",
  grader: "CGC",
  grade: "10",
  grade_label: "PRISTINE",
};

describe("PriceChartingPanel identity invalidation", () => {
  it("clears stale search results when grade_label changes", async () => {
    vi.mocked(priceChartingSearch).mockResolvedValue({
      status: "success",
      candidates: [{
        product_id: "5427932",
        product_name: "Charmander #289/S-P",
        confidence_score: 96,
        match_status: "exact",
        guide_value_cents: 4250,
        grade_field: "condition-17-price",
        candidate_image_url: "https://storage.googleapis.com/images.pricecharting.com/charmander/240.jpg",
        candidate_image_source: "official_product",
        conflicts: [],
        breakdown: {},
        rejected: false,
      }],
      rejected_candidates: [],
      requires_confirmation: false,
      auto_confirmed_product_id: "5427932",
      confidence_score: 96,
    } as never);

    const props = { identity, selectedProductId: null, onSelect: vi.fn() };
    const { rerender } = render(<PriceChartingPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Search PriceCharting" }));
    expect(await screen.findByText("Charmander #289/S-P")).toBeTruthy();
    expect(screen.getByAltText("PriceCharting candidate artwork for Charmander #289/S-P")).toBeTruthy();

    rerender(<PriceChartingPanel {...props} identity={{ ...identity, grade_label: "PERFECT" }} />);
    await waitFor(() => expect(screen.queryByText("Charmander #289/S-P")).toBeNull());
  });
});
