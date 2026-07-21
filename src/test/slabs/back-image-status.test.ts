import { describe, it, expect } from "vitest";
import { backImageStatus } from "@/lib/slabs/back-image-status";

describe("backImageStatus — a missing back image is surfaced, not silently omitted", () => {
  it("reports present with no note when a back image path exists", () => {
    const s = backImageStatus("slabs/abc/back.jpg");
    expect(s.present).toBe(true);
    expect(s.label).toBe("On file");
    expect(s.note).toBeNull();
  });

  it("reports missing with an actionable note when the back image is null", () => {
    const s = backImageStatus(null);
    expect(s.present).toBe(false);
    expect(s.label).toBe("Missing");
    expect(s.note).toMatch(/add one to complete verification/i);
  });

  it("treats empty/whitespace paths as missing", () => {
    expect(backImageStatus("").present).toBe(false);
    expect(backImageStatus("   ").present).toBe(false);
    expect(backImageStatus(undefined).present).toBe(false);
  });
});
