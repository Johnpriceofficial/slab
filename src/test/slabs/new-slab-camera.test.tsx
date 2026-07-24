/**
 * NewSlab hydration from a staged camera capture.
 *
 * The capture must arrive already loaded in the Front slot — one image, consumed
 * exactly once — while the manual upload workflow is left untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NewSlab from "@/pages/slabs/NewSlab";
import { clearCameraCapture, consumeCameraCapture, peekCameraCapture, stageCameraCapture } from "@/lib/slabs/camera-capture";
import type { SlabImageState } from "@/lib/slabs/image-state";
import { saveSlab, type SlabDataAccess } from "@/lib/slabs/save-slab";

vi.mock("@/lib/slabs/data", () => ({
  supabaseSlabDataAccess: { checkCertification: vi.fn().mockResolvedValue(null) },
  analyzeSlab: vi.fn(),
  linkAnalysisRun: vi.fn(),
  recordPricechartingConfirmation: vi.fn(),
}));

vi.mock("@/lib/slabs/save-slab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slabs/save-slab")>()),
  saveSlab: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

// Out of scope for this test; both are exercised by their own suites.
vi.mock("@/components/slabs/PriceChartingPanel", () => ({ PriceChartingPanel: () => <div data-testid="pc-panel" /> }));
vi.mock("@/components/slabs/SlabAnalysisPanel", () => ({ SlabAnalysisPanel: () => <div data-testid="analysis-panel" /> }));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value: string; children: React.ReactNode }) => <select value={value} onChange={() => {}}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));

const dao = { checkCertification: vi.fn().mockResolvedValue(null) } as unknown as SlabDataAccess;

function stagedCapture(): SlabImageState {
  const file = new File(["jpeg-bytes"], "camera-capture.jpg", { type: "image/jpeg" });
  return { originalFile: file, file, previewUrl: "blob:staged-front", ext: "jpg" };
}

let queryClient: QueryClient;

const renderNewSlab = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/slabs/new"]}>
        <NewSlab dao={dao} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearCameraCapture();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  URL.createObjectURL = vi.fn(() => "blob:manual-upload");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearCameraCapture();
});

describe("NewSlab camera hydration", () => {
  it("loads the staged capture into the Front image slot on mount", async () => {
    stageCameraCapture(stagedCapture());
    renderNewSlab();

    const front = await screen.findByAltText("front of slab");
    expect(front).toHaveAttribute("src", "blob:staged-front");

    // Front is filled; Back remains an empty upload target, so the manual
    // workflow is untouched and the operator can still add the back photo.
    expect(screen.getByLabelText(/upload optional back image/i)).toBeInTheDocument();
    expect(screen.queryByAltText("back of slab")).not.toBeInTheDocument();
  });

  it("unblocks the draft save that an empty form withholds (a front image is present)", async () => {
    stageCameraCapture(stagedCapture());
    renderNewSlab();
    await screen.findByAltText("front of slab");

    await waitFor(() => expect(screen.getByRole("button", { name: /save as unverified draft/i })).toBeEnabled());
  });

  it("consumes the capture exactly once, so a later manual visit starts empty", async () => {
    stageCameraCapture(stagedCapture());
    renderNewSlab();
    await screen.findByAltText("front of slab");

    // The buffer is drained by the hydrating mount — nothing is left to re-apply.
    expect(peekCameraCapture()).toBeNull();

    cleanup();
    renderNewSlab();

    expect(await screen.findByText(/click to upload the front image/i)).toBeInTheDocument();
    expect(screen.queryByAltText("front of slab")).not.toBeInTheDocument();
  });

  it("saves a scanned slab exactly once and makes it visible in /slabs immediately", async () => {
    vi.mocked(saveSlab).mockResolvedValue({
      status: "success",
      slab: { id: "slab-1", inventory_number: 7 } as never,
      warnings: [],
    } as never);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    stageCameraCapture(stagedCapture());
    renderNewSlab();
    await screen.findByAltText("front of slab");

    const draft = screen.getByRole("button", { name: /save as unverified draft/i });
    await waitFor(() => expect(draft).toBeEnabled());
    fireEvent.click(draft);

    // One capture → one slab. The camera never wrote a record of its own.
    await waitFor(() => expect(saveSlab).toHaveBeenCalledTimes(1));

    // The cached inventory list is dropped, so /slabs refetches and shows the
    // new slab at once instead of serving a stale 60s-fresh list without it.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["slabs"] }));

    // The saved slab was built from the captured front image.
    const [, frontArg] = vi.mocked(saveSlab).mock.calls[0];
    expect((frontArg!.blob as File).name).toBe("camera-capture.jpg");
  });

  it("renders the ordinary empty manual-upload form when no capture is staged", async () => {
    expect(consumeCameraCapture()).toBeNull();
    renderNewSlab();

    expect(await screen.findByText(/click to upload the front image/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/upload optional back image/i)).toBeInTheDocument();
    // Draft save stays blocked until an image exists — camera or manual.
    expect(screen.getByRole("button", { name: /save as unverified draft/i })).toBeDisabled();
  });
});
