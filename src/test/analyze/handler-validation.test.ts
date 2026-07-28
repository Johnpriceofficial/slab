import { describe, expect, it, vi } from "vitest";
import { analyzeSlabImages } from "../../server/analyze-slab/handler";
import { DEFAULT_IMAGE_LIMITS } from "../../server/analyze-slab/validate-images";

/**
 * Proves the security property end-to-end at the handler level: rejected
 * image input NEVER reaches the AI provider — callModel is not invoked.
 */

function jpegB64(totalBytes = 24): string {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.from(bytes).toString("base64");
}

describe("analyzeSlabImages input gating", () => {
  it("rejects invalid base64 before any provider call", async () => {
    const callModel = vi.fn();
    const result = await analyzeSlabImages(
      { front_image_base64: "!!!not-base64!!!", front_mime: "image/jpeg" },
      { callModel },
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ status: "error", error_code: "INVALID_BASE64" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("rejects oversized images before any provider call", async () => {
    const callModel = vi.fn();
    const result = await analyzeSlabImages(
      { front_image_base64: jpegB64(64), front_mime: "image/jpeg" },
      { callModel, imageLimits: { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 16 } },
    );
    expect(result.statusCode).toBe(413);
    expect(result.body).toMatchObject({ status: "error", error_code: "IMAGE_TOO_LARGE" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("rejects excess variants before any provider call", async () => {
    const callModel = vi.fn();
    const variant = { label: "v", image_base64: jpegB64(), mime: "image/jpeg" };
    const result = await analyzeSlabImages(
      { front_image_base64: jpegB64(), front_mime: "image/jpeg", variants: [variant, variant] },
      { callModel, imageLimits: { ...DEFAULT_IMAGE_LIMITS, maxVariants: 1 } },
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ status: "error", error_code: "TOO_MANY_VARIANTS" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("reaches the provider only for valid input", async () => {
    const callModel = vi.fn().mockRejectedValue(new Error("sentinel: provider reached"));
    let outcome: unknown;
    try {
      outcome = await analyzeSlabImages(
        { front_image_base64: jpegB64(), front_mime: "image/jpeg" },
        { callModel },
      );
    } catch (error) {
      outcome = error;
    }
    expect(callModel).toHaveBeenCalled();
    expect(outcome).toBeDefined();
  });
});
