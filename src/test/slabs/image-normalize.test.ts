import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeImageFile, type ImageNormalizeDeps } from "../../lib/slabs/image-normalize";
import { MAX_IMAGE_BYTES } from "../../lib/slabs/constants";

function makeFile(name: string, type: string, size = 1024): File {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

let noopDeps: ImageNormalizeDeps;

beforeEach(() => {
  noopDeps = {
    decodeHeic: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })),
    reencodeViaCanvas: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })),
  };
});

describe("normalizeImageFile", () => {
  it("passes an already-web-safe JPEG through unchanged (no re-encode)", async () => {
    const file = makeFile("card.jpg", "image/jpeg");
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.error).toBeNull();
    expect(result.file).toBe(file); // same object — not re-encoded
    expect(noopDeps.decodeHeic).not.toHaveBeenCalled();
    expect(noopDeps.reencodeViaCanvas).not.toHaveBeenCalled();
  });

  it("passes PNG and WEBP through unchanged", async () => {
    for (const type of ["image/png", "image/webp"]) {
      const file = makeFile(`card.${type.split("/")[1]}`, type);
      const result = await normalizeImageFile(file, noopDeps);
      expect(result.error).toBeNull();
      expect(result.file).toBe(file);
    }
  });

  it("routes HEIC (by MIME) through decodeHeic and returns a JPEG File", async () => {
    const file = makeFile("IMG_3543.heic", "image/heic");
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.error).toBeNull();
    expect(noopDeps.decodeHeic).toHaveBeenCalledWith(file);
    expect(result.file?.type).toBe("image/jpeg");
    expect(result.file?.name).toBe("IMG_3543.jpg");
  });

  it("routes HEIC by extension even when the browser reports an empty/generic MIME type", async () => {
    // Non-Safari browsers commonly report "" or "application/octet-stream" for HEIC files.
    const file = makeFile("IMG_3543 (1).HEIC", "");
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.error).toBeNull();
    expect(noopDeps.decodeHeic).toHaveBeenCalledWith(file);
    expect(result.file?.type).toBe("image/jpeg");
    expect(result.file?.name).toBe("IMG_3543 (1).jpg");
  });

  it("routes a non-web-safe browser-decodable format (e.g. GIF) through canvas re-encoding", async () => {
    const file = makeFile("meme.gif", "image/gif");
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.error).toBeNull();
    expect(noopDeps.reencodeViaCanvas).toHaveBeenCalledWith(file);
    expect(result.file?.type).toBe("image/jpeg");
    expect(result.file?.name).toBe("meme.jpg");
  });

  it("surfaces a clear error when the browser genuinely cannot decode the format (e.g. raw TIFF)", async () => {
    const file = makeFile("scan.tiff", "image/tiff");
    noopDeps.reencodeViaCanvas = vi.fn(async () => {
      throw new Error("Browser could not decode this image format.");
    });
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.file).toBeNull();
    expect(result.error).toMatch(/could not read this image format/i);
  });

  it("rejects a file that doesn't look like an image at all", async () => {
    const file = makeFile("invoice.pdf", "application/pdf");
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.file).toBeNull();
    expect(result.error).toMatch(/doesn't look like an image/i);
    expect(noopDeps.decodeHeic).not.toHaveBeenCalled();
    expect(noopDeps.reencodeViaCanvas).not.toHaveBeenCalled();
  });

  it("rejects a file over the size limit before attempting any conversion", async () => {
    const file = makeFile("huge.heic", "image/heic", MAX_IMAGE_BYTES + 1);
    const result = await normalizeImageFile(file, noopDeps);
    expect(result.file).toBeNull();
    expect(result.error).toMatch(/too large/i);
    expect(noopDeps.decodeHeic).not.toHaveBeenCalled();
  });
});
