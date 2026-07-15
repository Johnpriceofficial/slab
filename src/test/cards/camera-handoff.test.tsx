/**
 * Universal "Scan Item" scanner — capture, classify, route.
 *
 * One capture is analyzed once and classified: a graded slab is staged (image +
 * analysis) and handed to /slabs/new with NO second AI call; a raw card is
 * created through the raw pipeline; an uncertain result asks the operator to
 * choose Raw / Slab / Retake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardScanner } from "@/components/cards/CardScanner";
import { clearCameraCapture, peekCameraCapture } from "@/lib/slabs/camera-capture";
import { analyzeSlab } from "@/lib/slabs/data";
import { scanCard } from "@/lib/cards/api";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/slabs/data", () => ({ analyzeSlab: vi.fn() }));
vi.mock("@/lib/cards/api", () => ({ scanCard: vi.fn() }));

function analysis(over: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>): AnalyzeResult {
  const proposed = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) {
    const o = over[k];
    proposed[k] = o ? { value: o.value, confidence: o.confidence, source: "label", readable: o.readable } : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return { status: "success", proposed, overall_confidence: 0.8, label_matches_card: null, warnings: [], requires_confirmation: true };
}

const GRADED = analysis({
  grader: { value: "CGC", confidence: 0.99, readable: true },
  grade: { value: "10", confidence: 0.98, readable: true },
  certification_number: { value: "4012345678", confidence: 0.95, readable: true },
});
const RAW = analysis({ card_name: { value: "Charizard", confidence: 0.95, readable: true } });

const stopTrack = vi.fn();
let encodeBlob: () => Blob | null;

beforeEach(() => {
  vi.clearAllMocks();
  clearCameraCapture();
  encodeBlob = () => new Blob(["jpeg-bytes"], { type: "image/jpeg" });
  vi.mocked(scanCard).mockResolvedValue({ status: "added", extraction: { card_name: "Charizard" } } as never);

  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1080 });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(encodeBlob()); };
  URL.createObjectURL = vi.fn(() => "blob:staged-front");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearCameraCapture();
});

async function scan() {
  render(<CardScanner />);
  const button = await screen.findByRole("button", { name: /scan item/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("universal scanner classification + routing", () => {
  it("stages a graded slab (image + analysis) and navigates to /slabs/new, no card write", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(GRADED);
    await scan();

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));
    const staged = peekCameraCapture();
    expect(staged!.image.file.type).toBe("image/jpeg");
    expect(staged!.analysis).toBe(GRADED); // reused — /slabs/new needn't re-analyze
    expect(stopTrack).toHaveBeenCalled();
    expect(scanCard).not.toHaveBeenCalled();
  });

  it("routes a raw card into the raw pipeline and does not navigate", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue(RAW);
    const onInventoryChange = vi.fn();
    render(<CardScanner onInventoryChange={onInventoryChange} />);
    const button = await screen.findByRole("button", { name: /scan item/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(scanCard).toHaveBeenCalledTimes(1));
    expect(navigateSpy).not.toHaveBeenCalledWith("/slabs/new");
    expect(onInventoryChange).toHaveBeenCalled();
    expect(peekCameraCapture()).toBeNull(); // nothing staged for the slab form
  });

  it("asks the operator to choose when analysis is unavailable, then routes on choice", async () => {
    vi.mocked(analyzeSlab).mockResolvedValue({ status: "error", error_code: "QUOTA", message: "Daily limit reached." } as never);
    await scan();

    await screen.findByText(/couldn't determine the item type/i);
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(scanCard).not.toHaveBeenCalled();

    // Operator picks Slab → stage + navigate.
    fireEvent.click(screen.getByRole("button", { name: /^slab$/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));
    expect(peekCameraCapture()!.analysis).toBeNull(); // no analysis to reuse
  });

  it("stays on the scanner with an error when the frame can't be encoded", async () => {
    encodeBlob = () => null;
    await scan();
    await screen.findByRole("alert");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(analyzeSlab).not.toHaveBeenCalled();
  });
});
