import { describe, it, expect } from "vitest";
import { normalizeCert, normalizeGrader, certCompositeKey } from "@/lib/slabs/normalize";

describe("normalizeCert", () => {
  it("strips all whitespace and uppercases", () => {
    expect(normalizeCert("  abc 123 ")).toBe("ABC123");
    expect(normalizeCert("12 34\t56")).toBe("123456");
  });

  it("preserves leading zeros (000123 != 123)", () => {
    expect(normalizeCert("000123")).toBe("000123");
    expect(normalizeCert("000123")).not.toBe(normalizeCert("123"));
  });

  it("returns empty string for null/blank", () => {
    expect(normalizeCert(null)).toBe("");
    expect(normalizeCert("   ")).toBe("");
  });
});

describe("normalizeGrader", () => {
  it("uppercases and strips whitespace", () => {
    expect(normalizeGrader("psa")).toBe("PSA");
    expect(normalizeGrader(" C G C ")).toBe("CGC");
  });
});

describe("certCompositeKey", () => {
  it("scopes cert by grader", () => {
    expect(certCompositeKey("PSA", "12345678")).toBe("PSA:12345678");
    expect(certCompositeKey("PSA", "12345678")).not.toBe(certCompositeKey("CGC", "12345678"));
  });

  it("is null when either part is blank (incomplete records can't collide)", () => {
    expect(certCompositeKey("", "123")).toBeNull();
    expect(certCompositeKey("PSA", "")).toBeNull();
    expect(certCompositeKey(null, null)).toBeNull();
  });

  it("collapses whitespace/case differences to the same key", () => {
    expect(certCompositeKey("psa", "abc 123")).toBe(certCompositeKey("PSA", "ABC123"));
  });
});
