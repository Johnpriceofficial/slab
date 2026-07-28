import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_LIMITS,
  validateAnalyzeImageInput,
  type ImageValidationLimits,
} from "../../server/analyze-slab/validate-images";

/** Base64 for a byte prefix padded to a total length. */
function b64(prefix: number[], totalBytes = 24): string {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(prefix.slice(0, totalBytes));
  return Buffer.from(bytes).toString("base64");
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const HEIC = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];

function front(overrides: Record<string, unknown> = {}) {
  return { front_image_base64: b64(JPEG), front_mime: "image/jpeg", ...overrides };
}

describe("validateAnalyzeImageInput", () => {
  it("accepts a valid front-only payload for every allowed type", () => {
    expect(validateAnalyzeImageInput(front())).toBeNull();
    expect(
      validateAnalyzeImageInput({ front_image_base64: b64(PNG), front_mime: "image/png" }),
    ).toBeNull();
    expect(
      validateAnalyzeImageInput({ front_image_base64: b64(WEBP), front_mime: "image/webp" }),
    ).toBeNull();
    expect(
      validateAnalyzeImageInput({ front_image_base64: b64(HEIC), front_mime: "image/heic" }),
    ).toBeNull();
  });

  it("accepts front + back + valid variants within limits", () => {
    const input = front({
      back_image_base64: b64(JPEG),
      back_mime: "image/jpeg",
      variants: [{ label: "front_crop", image_base64: b64(PNG), mime: "image/png" }],
    });
    expect(validateAnalyzeImageInput(input)).toBeNull();
  });

  it("requires a front image", () => {
    expect(validateAnalyzeImageInput({})?.code).toBe("MISSING_IMAGE");
    expect(validateAnalyzeImageInput({ front_image_base64: b64(JPEG) })?.code).toBe("MISSING_IMAGE");
  });

  it("rejects disallowed MIME types", () => {
    const error = validateAnalyzeImageInput(front({ front_mime: "image/gif" }));
    expect(error?.code).toBe("UNSUPPORTED_IMAGE");
    expect(error?.statusCode).toBe(400);
  });

  it("rejects invalid base64 (charset and length)", () => {
    expect(validateAnalyzeImageInput(front({ front_image_base64: "not base64 !!" }))?.code).toBe(
      "INVALID_BASE64",
    );
    expect(validateAnalyzeImageInput(front({ front_image_base64: "abc" }))?.code).toBe(
      "INVALID_BASE64",
    );
  });

  it("rejects empty images", () => {
    expect(validateAnalyzeImageInput(front({ front_image_base64: "" }))?.code).toBe("MISSING_IMAGE");
    const backEmpty = front({ back_image_base64: "", back_mime: "image/jpeg" });
    // An empty back string is treated as absent (front-required/back-optional).
    expect(validateAnalyzeImageInput(backEmpty)).toBeNull();
  });

  it("rejects an oversized individual image", () => {
    const limits: ImageValidationLimits = { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 16 };
    const error = validateAnalyzeImageInput(front(), limits);
    expect(error?.code).toBe("IMAGE_TOO_LARGE");
    expect(error?.statusCode).toBe(413);
  });

  it("rejects an oversized aggregate payload", () => {
    const limits: ImageValidationLimits = {
      ...DEFAULT_IMAGE_LIMITS,
      maxImageBytes: 64,
      maxAggregateBytes: 40,
    };
    const input = front({ back_image_base64: b64(JPEG), back_mime: "image/jpeg" });
    const error = validateAnalyzeImageInput(input, limits);
    expect(error?.code).toBe("AGGREGATE_IMAGE_LIMIT");
    expect(error?.statusCode).toBe(413);
  });

  it("rejects too many variants", () => {
    const limits: ImageValidationLimits = { ...DEFAULT_IMAGE_LIMITS, maxVariants: 2 };
    const variant = { label: "v", image_base64: b64(JPEG), mime: "image/jpeg" };
    const error = validateAnalyzeImageInput(
      front({ variants: [variant, variant, variant] }),
      limits,
    );
    expect(error?.code).toBe("TOO_MANY_VARIANTS");
  });

  it("rejects content that does not match the declared MIME type", () => {
    const error = validateAnalyzeImageInput(
      front({ front_image_base64: b64(PNG), front_mime: "image/jpeg" }),
    );
    expect(error?.code).toBe("UNSUPPORTED_IMAGE");
    expect(error?.message).toContain("does not match");
  });

  it("validates the variants the analysis would forward", () => {
    const error = validateAnalyzeImageInput(
      front({ variants: [{ label: "bad", image_base64: "%%%%", mime: "image/jpeg" }] }),
    );
    expect(error?.code).toBe("INVALID_BASE64");
    // Variants the handler skips (disallowed mime) don't fail the request.
    expect(
      validateAnalyzeImageInput(
        front({ variants: [{ label: "skip", image_base64: b64(JPEG), mime: "image/gif" }] }),
      ),
    ).toBeNull();
  });
});
