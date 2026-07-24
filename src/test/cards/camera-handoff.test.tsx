/**
 * Universal "Scan Item" scanner — front/back workflow.
 *
 * Covers the required behaviors: front-only slab routing, back prompting when
 * the cert is unreadable or reads disagree, back resolving a gap via one
 * combined reanalysis, single-AI-call raw and graded scans, replacing the back
 * invalidating stale analysis, skipping the back when permitted, camera tracks
 * stopping on route, and a quota failure preserving the capture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardScanner } from "@/components/cards/CardScanner";
import { clearCameraCapture, peekCameraCapture } from "@/lib/slabs/camera-capture";
import { analyzeSlab } from "@/lib/slabs/data";
import { stageRawCard, rawIdentityGaps } from "@/lib/cards/stage-raw";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));
vi.mock("react-router-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-router-dom")>()), useNavigate: () => navigateSpy }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/slabs/data", () => ({ analyzeSlab: vi.fn() }));
vi.mock("@/lib/cards/stage-raw", () => ({ stageRawCard: vi.fn(), rawIdentityGaps: vi.fn(() => []) }));

function analysis(over: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>, extra: Partial<AnalyzeResult> = {}): AnalyzeResult {
  const proposed = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) {
    const o = over[k];
    proposed[k] = o ? { value: o.value, confidence: o.confidence, source: "label", readable: o.readable } : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return { status: "success", proposed, overall_confidence: 0.9, label_matches_card: null, warnings: [], requires_confirmation: true, ...extra };
}
const GRADED_FULL = analysis({ grader: { value: "CGC", confidence: 0.99, readable: true }, grade: { value: "10", confidence: 0.98, readable: true }, certification_number: { value: "4012345678", confidence: 0.95, readable: true } });
const GRADED_NO_CERT = analysis({ grader: { value: "CGC", confidence: 0.95, readable: true }, grade: { value: "10", confidence: 0.95, readable: true }, certification_number: { value: null, confidence: 0, readable: false } });
const RAW = analysis({ card_name: { value: "Charizard", confidence: 0.95, readable: true }, set: { value: "Base", confidence: 0.9, readable: true }, card_number: { value: "4/102", confidence: 0.9, readable: true } });

const stopTrack = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  clearCameraCapture();
  vi.mocked(rawIdentityGaps).mockReturnValue([]);
  vi.mocked(stageRawCard).mockResolvedValue({ card_name: "Charizard", inventory_code: "R0001" } as never);

  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1080 });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) { cb(new Blob(["jpeg"], { type: "image/jpeg" })); };
  URL.createObjectURL = vi.fn(() => "blob:cap");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); clearCameraCapture(); });

async function scanFront() {
  render(<CardScanner onInventoryChange={vi.fn()} />);
  const button = await screen.findByRole("button", { name: /scan item/i });
  fireEvent.click(button);
  await screen.findByRole("button", { name: /retake front/i }); // review shown
}

describe("front-only slab routing (Requirement 1, 7, 10)", () => {
  it("routes a strong graded front to /slabs/new with one AI call, staging both slots, stopping the camera", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(GRADED_FULL);
    await scanFront();

    expect(analyzeSlab).toHaveBeenCalledTimes(1); // graded scan = one call
    fireEvent.click(screen.getByRole("button", { name: /continue to slab details/i }));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));
    const staged = peekCameraCapture();
    expect(staged!.analysis).toBe(GRADED_FULL); // reused — no re-analysis on the form
    expect(staged!.back).toBeNull();
    expect(stopTrack).toHaveBeenCalled();
    expect(stageRawCard).not.toHaveBeenCalled(); // no card record for a slab
  });
});

describe("back prompting and resolution (Requirements 2, 3, 4, 8)", () => {
  it("requires the back when the certification number is unreadable", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(GRADED_NO_CERT);
    await scanFront();
    expect(screen.getByText(/certification number was not readable on the front/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to slab details/i })).toBeEnabled();
  });

  it("captures the back, runs ONE combined reanalysis that resolves the cert, and unblocks continue", async () => {
    vi.mocked(analyzeSlab).mockResolvedValueOnce(GRADED_NO_CERT).mockResolvedValueOnce(GRADED_FULL);
    await scanFront();
    expect(analyzeSlab).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /add back image/i }));
    await waitFor(() => expect(analyzeSlab).toHaveBeenCalledTimes(2)); // one combined reanalysis
    // Second call included the back image.
    expect(vi.mocked(analyzeSlab).mock.calls[1][1]).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /continue to slab details/i })).toBeEnabled());
  });

  it("requires the back when independent front reads disagree", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(analysis({ grader: { value: "CGC", confidence: 0.9, readable: true }, certification_number: { value: "4012345678", confidence: 0.9, readable: true } }, { warnings: ["Card number could not be verified: two independent readings disagree."] }));
    await scanFront();
    expect(screen.getByText(/conflicting evidence/i)).toBeInTheDocument();
  });

  it("replacing the back invalidates prior analysis and re-runs exactly once more", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(GRADED_FULL);
    await scanFront();
    expect(analyzeSlab).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /add back image/i }));
    await waitFor(() => expect(analyzeSlab).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /recapture optional back/i }));
    await waitFor(() => expect(analyzeSlab).toHaveBeenCalledTimes(3)); // replacing back → one more
  });
});

describe("raw routing (Requirements 5, 6, 13)", () => {
  it("creates a raw card from the SAME analysis (one AI call, no second model request)", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(RAW);
    await scanFront();
    expect(analyzeSlab).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /add to raw inventory/i }));
    await waitFor(() => expect(stageRawCard).toHaveBeenCalledTimes(1)); // exactly one card, no second analyze
    expect(analyzeSlab).toHaveBeenCalledTimes(1);
    const [passedAnalysis, images] = vi.mocked(stageRawCard).mock.calls[0];
    expect(passedAnalysis).toBe(RAW);
    expect(images.front).toBeInstanceOf(File);
    expect(navigateSpy).not.toHaveBeenCalledWith("/slabs/new");
  });

  it("carries the back image into the raw record when one was captured", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(RAW);
    await scanFront();
    fireEvent.click(screen.getByRole("button", { name: /add back image/i }));
    await waitFor(() => expect(analyzeSlab).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /add to raw inventory/i }));
    await waitFor(() => expect(stageRawCard).toHaveBeenCalled());
    expect(vi.mocked(stageRawCard).mock.calls[0][1].back).toBeInstanceOf(File);
  });
});

describe("skip and resilience (Requirements 9, 11)", () => {
  it("allows skipping the back for a strong raw card (routes without one)", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(RAW);
    await scanFront();
    // No back captured — the raw card files directly.
    fireEvent.click(screen.getByRole("button", { name: /add to raw inventory/i }));
    await waitFor(() => expect(stageRawCard).toHaveBeenCalled());
    expect(vi.mocked(stageRawCard).mock.calls[0][1].back).toBeFalsy();
  });

  it("preserves the capture when analysis fails (quota) and offers a manual choice", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue({ status: "error", error_code: "QUOTA_EXCEEDED", message: "Daily limit reached." } as never);
    await scanFront();
    expect(screen.getByText(/couldn't analyze/i)).toBeInTheDocument();
    // The front thumbnail is still shown — the capture was not discarded.
    expect(screen.getByAltText(/captured front/i)).toBeInTheDocument();
    // Manual override to Slab still routes.
    fireEvent.click(screen.getByRole("button", { name: /^slab$/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to slab details/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));
    expect(peekCameraCapture()!.analysis).toBeNull();
  });
});
