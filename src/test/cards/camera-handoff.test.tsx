/**
 * Camera → Add a Slab hand-off.
 *
 * The scanner is a capture device, not an intake path of its own: a capture must
 * be staged as a SlabImageState, release the camera, and land on /slabs/new —
 * without ever creating a /cards inventory record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CardScanner } from "@/components/cards/CardScanner";
import { clearCameraCapture, peekCameraCapture } from "@/lib/slabs/camera-capture";
import { scanCard, resolveScan } from "@/lib/cards/api";

const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

// The graded-scan flow must never touch the card-inventory endpoints.
vi.mock("@/lib/cards/api", () => ({ scanCard: vi.fn(), resolveScan: vi.fn(), fetchScanReviews: vi.fn() }));

const stopTrack = vi.fn();
let encodeBlob: () => Blob | null = () => new Blob(["jpeg-bytes"], { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  clearCameraCapture();
  encodeBlob = () => new Blob(["jpeg-bytes"], { type: "image/jpeg" });

  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });

  // jsdom implements neither media playback nor canvas rasterization; stub the
  // exact surfaces the capture path touches so the real code runs unchanged.
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1080 });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: vi.fn() })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(encodeBlob());
  };

  URL.createObjectURL = vi.fn(() => "blob:staged-front");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearCameraCapture();
});

async function captureOnce() {
  render(<CardScanner />);
  const button = await screen.findByRole("button", { name: /capture slab/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return button;
}

describe("CardScanner → /slabs/new hand-off", () => {
  it("stages the capture as a SlabImageState, stops the camera, and navigates to /slabs/new", async () => {
    await captureOnce();

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));

    const staged = peekCameraCapture();
    expect(staged).not.toBeNull();
    expect(staged!.file.type).toBe("image/jpeg");
    expect(staged!.originalFile.name).toBe("camera-capture.jpg");
    expect(staged!.ext).toBe("jpg");
    expect(staged!.previewUrl).toBe("blob:staged-front");

    // The camera is released before the hand-off — no track keeps running.
    expect(stopTrack).toHaveBeenCalled();
  });

  it("never creates a /cards inventory record for a graded scan", async () => {
    await captureOnce();
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/slabs/new"));

    expect(scanCard).not.toHaveBeenCalled();
    expect(resolveScan).not.toHaveBeenCalled();
  });

  it("stages nothing and stays on the scanner when the frame cannot be encoded", async () => {
    encodeBlob = () => null;
    await captureOnce();

    await screen.findByRole("alert");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(peekCameraCapture()).toBeNull();
    // Still usable: the operator can line the slab up and try again.
    await waitFor(() => expect(screen.getByRole("button", { name: /capture slab/i })).toBeEnabled());
  });
});
