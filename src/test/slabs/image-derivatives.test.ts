import { describe, expect, it } from "vitest";
import { DETERMINISTIC_TRANSFORMS } from "@/lib/slabs/image-derivatives";

describe("deterministic slab analysis image variants", () => {
  it("includes the label-region passes required for conservative OCR", () => {
    const required = [
      "label_original",
      "label_corrected",
      "label_enhanced",
      "label_grayscale",
      "label_sharpened",
      "label_thresholded",
    ] as const;

    for (const label of required) {
      const transform = DETERMINISTIC_TRANSFORMS[label];
      expect(transform).toBeTruthy();
      expect(transform.crop).toEqual([0, 0, 1, 0.32]);
    }
  });

  it("uses non-generative deterministic transforms for certification and label evidence", () => {
    expect(DETERMINISTIC_TRANSFORMS.certification_sharpened.crop).toEqual([0.45, 0, 0.55, 0.25]);
    expect(DETERMINISTIC_TRANSFORMS.label_thresholded.threshold).toBeTypeOf("number");
    expect(DETERMINISTIC_TRANSFORMS.label_sharpened.sharpen).toBe(true);
    expect(Object.values(DETERMINISTIC_TRANSFORMS).some((transform) => transform.variant === "perspective_corrected_label_region")).toBe(true);
  });
});
