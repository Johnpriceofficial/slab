import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PriceChartingPanel, EbayReferenceImages } from "@/components/slabs/PriceChartingPanel";
import { priceChartingSearch, ebayReferenceSearch } from "@/lib/slabs/data";

vi.mock("@/lib/slabs/data", () => ({
  priceChartingSearch: vi.fn(),
  priceChartingValue: vi.fn(),
  priceChartingOfferImage: vi.fn(),
  priceChartingLookup: vi.fn(),
  ebayReferenceSearch: vi.fn(async () => ({ status: "success", items: [] })),
}));
vi.mock("@/components/slabs/CandidateDebugPanel", () => ({ CandidateDebugPanel: () => null }));

const identity = {
  card_name: "Gyarados V", set: "Blue Sky Stream", card_number: "020/067", year: 2022,
  language: "Japanese", variation: "", grader: "CGC", grade: "10", grade_label: "PRISTINE",
};

function candidate(over: Record<string, unknown> = {}) {
  return {
    product_id: "5327894", product_name: "Gyarados V #20", console_or_category: "Pokemon Japanese Blue Sky Stream",
    confidence_score: 96, match_status: "exact", guide_value_cents: null, grade_field: null, company_specific: true,
    candidate_image_url: "https://storage.googleapis.com/images.pricecharting.com/g/240.jpg",
    candidate_image_source: "official_product", conflicts: [], breakdown: {}, rejected: false, ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("eBay 409 isolation", () => {
  it("the candidate list performs ZERO eBay reference calls (no per-candidate storm)", async () => {
    vi.mocked(priceChartingSearch).mockResolvedValue({
      status: "success",
      // Two candidates: one WITH and one WITHOUT a PriceCharting image. Neither may
      // trigger an eBay request while merely listed as an unselected candidate.
      candidates: [candidate(), candidate({ product_id: "9", product_name: "Gyarados V #20 alt", candidate_image_url: null, candidate_image_source: "none" })],
      rejected_candidates: [], requires_confirmation: false, auto_confirmed_product_id: null, confidence_score: 96,
    } as never);

    render(<PriceChartingPanel identity={identity} selectedProductId={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Search PriceCharting" }));
    await screen.findByText("Gyarados V #20");
    // Give any (erroneous) effects a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(ebayReferenceSearch).toHaveBeenCalledTimes(0);
  });

  it("a confirmed product WITH PriceCharting artwork performs ZERO eBay calls", async () => {
    render(<EbayReferenceImages candidate={candidate() as never} identity={identity} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(ebayReferenceSearch).toHaveBeenCalledTimes(0);
  });

  it("a confirmed product WITHOUT PriceCharting artwork performs EXACTLY ONE eBay call", async () => {
    render(<EbayReferenceImages candidate={candidate({ candidate_image_url: null, candidate_image_source: "none" }) as never} identity={identity} />);
    await waitFor(() => expect(ebayReferenceSearch).toHaveBeenCalledTimes(1));
  });

  it("an explicit hasPriceChartingImage flag suppresses the eBay call even without a candidate image", async () => {
    render(<EbayReferenceImages candidate={candidate({ candidate_image_url: null }) as never} identity={identity} hasPriceChartingImage />);
    await new Promise((r) => setTimeout(r, 0));
    expect(ebayReferenceSearch).toHaveBeenCalledTimes(0);
  });
});
