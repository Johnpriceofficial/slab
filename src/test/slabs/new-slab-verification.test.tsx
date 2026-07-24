/**
 * /slabs/new verification behavior.
 *
 * Both intake paths (camera capture and manual upload) run through the SAME
 * server-side analysis (Requirement 8), and replacing or clearing an image
 * invalidates a stale verification (Requirement 7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NewSlab from "@/pages/slabs/NewSlab";
import { clearCameraCapture, stageCameraCapture } from "@/lib/slabs/camera-capture";
import type { SlabImageState } from "@/lib/slabs/image-state";
import { analyzeSlab, priceChartingSearch, priceChartingValue } from "@/lib/slabs/data";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal } from "@/server/analyze-slab/handler";
import { toast } from "sonner";

vi.mock("@/lib/slabs/data", () => ({
  supabaseSlabDataAccess: { checkCertification: vi.fn().mockResolvedValue(null) },
  analyzeSlab: vi.fn(),
  priceChartingSearch: vi.fn(),
  priceChartingValue: vi.fn(),
  linkAnalysisRun: vi.fn(),
  recordPricechartingConfirmation: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock("@/components/slabs/PriceChartingPanel", () => ({ PriceChartingPanel: () => <div data-testid="pc-panel" /> }));
vi.mock("@/components/slabs/SlabAnalysisPanel", () => ({ SlabAnalysisPanel: () => <div data-testid="analysis-panel" /> }));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange?: (value: string) => void; children: React.ReactNode }) => (
    <select value={value} onChange={(event) => onValueChange?.(event.currentTarget.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));

function fullProposal(): AnalyzeProposal {
  const p = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) p[k] = { value: null, confidence: 0, source: "unknown", readable: false };
  p.card_name = { value: "Charizard", confidence: 0.9, source: "card", readable: true };
  return p;
}

function highConfidenceProposal(): AnalyzeProposal {
  const p = fullProposal();
  p.card_name = { value: "Venusaur", confidence: 0.98, source: "card", readable: true };
  p.set = { value: "Pokemon GO", confidence: 0.98, source: "label", readable: true };
  p.card_number = { value: "003/071", confidence: 0.99, source: "label", readable: true };
  p.year = { value: "2022", confidence: 0.96, source: "label", readable: true };
  p.language = { value: "Japanese", confidence: 0.96, source: "label", readable: true };
  p.rarity = { value: "Rare", confidence: 0.95, source: "card", readable: true };
  p.finish = { value: "Holo", confidence: 0.96, source: "card", readable: true };
  p.grader = { value: "CGC", confidence: 0.99, source: "label", readable: true };
  p.grade = { value: "10", confidence: 0.99, source: "label", readable: true };
  p.grade_label = { value: "PRISTINE", confidence: 0.98, source: "label", readable: true };
  p.certification_number = { value: "6165347099", confidence: 0.99, source: "label", readable: true };
  p.label_description = { value: "2022 Pokemon GO Japanese Venusaur", confidence: 0.95, source: "label", readable: true };
  return p;
}

const successResult: AnalyzeResult = {
  status: "success",
  proposed: fullProposal(),
  overall_confidence: 0.8,
  label_matches_card: true,
  warnings: [],
  requires_confirmation: true,
};

function autoResult(overrides: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    status: "success",
    proposed: highConfidenceProposal(),
    overall_confidence: 0.98,
    label_matches_card: true,
    warnings: [],
    requires_confirmation: true,
    ...overrides,
  };
}

function stagedCapture(): SlabImageState {
  const file = new File(["jpeg-bytes"], "camera-capture.jpg", { type: "image/jpeg" });
  return { originalFile: file, file, previewUrl: "blob:staged-front", ext: "jpg" };
}

let queryClient: QueryClient;

function renderNewSlab() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/slabs/new"]}>
        <NewSlab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCameraCapture();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(analyzeSlab).mockResolvedValue(successResult);
  vi.mocked(priceChartingSearch).mockResolvedValue({
    status: "success",
    action: "search",
    query: "Charizard",
    confidence_score: 0,
    confidence_level: "Unresolved",
    requires_confirmation: true,
    auto_confirmed_product_id: null,
    candidates: [],
    rejected_candidates: [],
    warnings: [],
  });
  vi.mocked(priceChartingValue).mockResolvedValue({ status: "error", error_code: "TEST_ONLY", message: "not configured", retryable: false });
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearCameraCapture();
});

async function runAnalysis() {
  const analyzeBtn = await screen.findByRole("button", { name: /analyze images/i });
  await waitFor(() => expect(analyzeBtn).toBeEnabled());
  fireEvent.click(analyzeBtn);
  await screen.findByTestId("analysis-panel");
}

describe("shared analysis pipeline (Requirement 8)", () => {
  it("runs the server analysis on a camera-staged front image", async () => {
    stageCameraCapture(stagedCapture());
    renderNewSlab();
    await screen.findByAltText("front of slab");

    await runAnalysis();

    expect(analyzeSlab).toHaveBeenCalledTimes(1);
    const [front] = vi.mocked(analyzeSlab).mock.calls[0];
    expect((front.blob as File).name).toBe("camera-capture.jpg");
  });

  it("runs the SAME server analysis on a manually uploaded front image", async () => {
    renderNewSlab();
    // Manual upload: a web-safe JPEG passes normalizeImageFile's fast path, so no
    // canvas is needed in jsdom. This is the identical pipeline the camera uses.
    const file = new File(["jpeg-bytes"], "manual-front.jpg", { type: "image/jpeg" });
    const input = screen.getByLabelText(/upload required front image/i);
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByAltText("front of slab");

    await runAnalysis();

    expect(analyzeSlab).toHaveBeenCalledTimes(1);
    const [front] = vi.mocked(analyzeSlab).mock.calls[0];
    expect((front.blob as File).name).toBe("manual-front.jpg");
  });
});

describe("automatic analysis application", () => {
  it("reuses scanner analysis immediately without rerunning server analysis", async () => {
    stageCameraCapture(stagedCapture(), null, autoResult());
    renderNewSlab();

    await screen.findByAltText("front of slab");
    await screen.findByTestId("analysis-panel");

    expect(analyzeSlab).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByDisplayValue("Venusaur")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Japanese")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CGC")).toBeInTheDocument();
    expect(screen.getByDisplayValue("6165347099")).toBeInTheDocument();
  });

  it("populates safe high-confidence fields and replaces untouched English/PSA defaults", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(autoResult());
    renderNewSlab();
    const file = new File(["jpeg-bytes"], "front.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/upload required front image/i), { target: { files: [file] } });
    await screen.findByAltText("front of slab");

    await runAnalysis();

    await waitFor(() => expect(screen.getByDisplayValue("Venusaur")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Pokemon GO")).toBeInTheDocument();
    expect(screen.getByDisplayValue("003/071")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2022")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Japanese")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CGC")).toBeInTheDocument();
    expect(screen.getByDisplayValue("6165347099")).toBeInTheDocument();
  });

  it("does not overwrite operator-edited default language or grader values", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(autoResult());
    renderNewSlab();
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "Korean" } });
    fireEvent.change(selects[1], { target: { value: "BGS" } });

    const file = new File(["jpeg-bytes"], "front.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/upload required front image/i), { target: { files: [file] } });
    await screen.findByAltText("front of slab");

    await runAnalysis();

    expect(screen.getByDisplayValue("Korean")).toBeInTheDocument();
    expect(screen.getByDisplayValue("BGS")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Japanese")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("CGC")).not.toBeInTheDocument();
  });

  it("automatically links and values one exact conflict-free PriceCharting match", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(autoResult());
    vi.mocked(priceChartingSearch).mockResolvedValue({
      status: "success",
      action: "search",
      query: "Venusaur Pokemon GO #3",
      confidence_score: 96,
      confidence_level: "Exact",
      requires_confirmation: false,
      auto_confirmed_product_id: "1003",
      candidates: [{
        product_id: "1003",
        product_name: "Venusaur #3",
        console_or_category: "Pokemon Japanese Pokemon GO",
        confidence_score: 96,
        match_status: "exact",
        grade_field: "condition-17-price",
        guide_value_cents: 6000,
        company_specific: true,
        canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-pokemon-go/venusaur-3",
        candidate_image_url: null,
        candidate_image_source: "none",
        conflicts: [],
        rejected: false,
        breakdown: {},
      }],
      rejected_candidates: [],
      warnings: [],
    } as never);
    vi.mocked(priceChartingValue).mockResolvedValue({
      status: "success",
      action: "value",
      product_id: "1003",
      product_name: "Venusaur #3",
      console_or_category: "Pokemon Japanese Pokemon GO",
      grade_field: "condition-17-price",
      guide_value_cents: 6000,
      price_source: "api",
      company_specific: true,
      is_estimate: false,
      selected_tier_key: "cgc_10_pristine",
      selected_tier_label: "CGC 10 Pristine",
      designation_requested: "PRISTINE",
      designation_exact: true,
      tier_availability: "available",
      sales_volume: 7,
      available_values_cents: { cgc_10_pristine: 6000, cgc_10: 4250 },
      canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-pokemon-go/venusaur-3",
      valuation_source: "PRICECHARTING_API",
      public_page: null,
      reference_artwork: null,
      warnings: [],
    });
    renderNewSlab();
    const file = new File(["jpeg-bytes"], "front.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/upload required front image/i), { target: { files: [file] } });
    await screen.findByAltText("front of slab");

    await runAnalysis();

    await waitFor(() => expect(priceChartingValue).toHaveBeenCalledWith(expect.objectContaining({ product_id: "1003" })));
    expect(screen.getByLabelText("PriceCharting Guide Value ($)")).toHaveValue("60.00");
    expect(screen.getByLabelText("Final Value ($)")).toHaveValue("60.00");
    expect(screen.getByLabelText("Quick-Sale Value ($)")).toHaveValue("48.00");
    expect(screen.getByLabelText("Replacement Value ($)")).toHaveValue("66.00");
    expect(screen.getByLabelText("Valuation Confidence")).toHaveValue("high");
  });
});

describe("stale verification invalidation (Requirement 7)", () => {
  it("drops an existing analysis when the image is cleared or replaced", async () => {
    stageCameraCapture(stagedCapture());
    renderNewSlab();
    await screen.findByAltText("front of slab");
    await runAnalysis();
    expect(screen.getByTestId("analysis-panel")).toBeInTheDocument();

    // Clear the front image — the proposal described the old photo.
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));

    await waitFor(() => expect(screen.queryByTestId("analysis-panel")).not.toBeInTheDocument());
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/re-run analysis/i));
  });
});
