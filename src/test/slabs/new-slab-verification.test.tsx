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
import { analyzeSlab } from "@/lib/slabs/data";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal } from "@/server/analyze-slab/handler";
import { toast } from "sonner";

vi.mock("@/lib/slabs/data", () => ({
  supabaseSlabDataAccess: { checkCertification: vi.fn().mockResolvedValue(null) },
  analyzeSlab: vi.fn(),
  linkAnalysisRun: vi.fn(),
  recordPricechartingConfirmation: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock("@/components/slabs/PriceChartingPanel", () => ({ PriceChartingPanel: () => <div data-testid="pc-panel" /> }));
vi.mock("@/components/slabs/SlabAnalysisPanel", () => ({ SlabAnalysisPanel: () => <div data-testid="analysis-panel" /> }));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value: string; children: React.ReactNode }) => <select value={value} onChange={() => {}}>{children}</select>,
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

const successResult: AnalyzeResult = {
  status: "success",
  proposed: fullProposal(),
  overall_confidence: 0.8,
  label_matches_card: true,
  warnings: [],
  requires_confirmation: true,
};

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
