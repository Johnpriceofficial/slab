import { describe, it, expect } from "vitest";
import { parseCardNumber, cardNumberToken, cardNumbersEquivalent } from "@/lib/pricecharting/card-number";

describe("parseCardNumber", () => {
  it("splits NNN/NNN and preserves the display value", () => {
    const p = parseCardNumber("016/064");
    expect(p.display).toBe("016/064");
    expect(p.numerator).toBe("016");
    expect(p.denominator).toBe("064");
    expect(p.canonicalNumerator).toBe("16");
    expect(p.canonicalDenominator).toBe("64");
  });

  it("NEVER concatenates numerator and denominator", () => {
    expect(cardNumberToken("016/064")).toBe("16");
    expect(cardNumberToken("016/064")).not.toBe("016064");
  });

  it("handles #-prefixed and bare numbers with leading zeros", () => {
    expect(cardNumberToken("#16")).toBe("16");
    expect(cardNumberToken("16")).toBe("16");
    expect(cardNumberToken("#016")).toBe("16");
    expect(cardNumberToken("016")).toBe("16");
  });

  it("preserves alphanumeric promo prefixes (only leading zeros dropped)", () => {
    expect(cardNumberToken("SV49/SV94")).toBe("sv49");
    expect(cardNumberToken("TG12/TG30")).toBe("tg12");
    expect(cardNumberToken("SWSH123")).toBe("swsh123");
    expect(cardNumberToken("H12")).toBe("h12");
  });
});

describe("cardNumbersEquivalent", () => {
  it("treats equivalent forms of the same card as equal", () => {
    for (const other of ["016/064", "16/64", "#016", "#16", "16"]) {
      expect(cardNumbersEquivalent("016/064", other)).toBe(true);
    }
  });

  it("treats a product title ending in #16 as the same card", () => {
    expect(cardNumbersEquivalent("016/064", "16")).toBe(true);
  });

  it("treats DIFFERENT collector numbers as NOT equal", () => {
    for (const other of ["015/064", "069/064", "076/064", "#69", "#76", "18/64"]) {
      expect(cardNumbersEquivalent("016/064", other)).toBe(false);
    }
  });

  it("is false when either side has no parseable numerator", () => {
    expect(cardNumbersEquivalent("016/064", "")).toBe(false);
    expect(cardNumbersEquivalent(null, "16")).toBe(false);
    expect(cardNumbersEquivalent(undefined, undefined)).toBe(false);
  });
});
