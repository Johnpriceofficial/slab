import { describe, it, expect } from "vitest";
import {
  convertPenniesToDollars,
  convertDollarsToPennies,
  sumPennies,
  multiplyPennies,
  formatPennies,
} from "@/lib/pricecharting/money";

describe("money — penny/dollar conversion", () => {
  it("converts pennies to dollars per PriceCharting examples", () => {
    expect(convertPenniesToDollars(1732)).toBe(17.32);
    expect(convertPenniesToDollars(10000)).toBe(100.0);
    expect(convertPenniesToDollars(42995)).toBe(429.95);
  });

  it("preserves null (never coerces missing data to 0)", () => {
    expect(convertPenniesToDollars(null)).toBeNull();
    expect(convertPenniesToDollars(undefined)).toBeNull();
  });

  it("treats an explicit zero as $0.00, not null", () => {
    expect(convertPenniesToDollars(0)).toBe(0);
    expect(formatPennies(0)).toBe("$0.00");
  });

  it("rejects non-integer pennies", () => {
    expect(() => convertPenniesToDollars(17.5)).toThrow();
  });

  it("converts dollars (number and string) to integer pennies without float error", () => {
    expect(convertDollarsToPennies(17.32)).toBe(1732);
    expect(convertDollarsToPennies("100.00")).toBe(10000);
    expect(convertDollarsToPennies("$429.95")).toBe(42995);
    expect(convertDollarsToPennies("$1,299.95")).toBe(129995);
    expect(convertDollarsToPennies(".5")).toBe(50);
    expect(convertDollarsToPennies("0")).toBe(0);
  });

  it("avoids the classic 0.1 + 0.2 float trap by staying in integer pennies", () => {
    const total = sumPennies([
      convertDollarsToPennies(0.1),
      convertDollarsToPennies(0.2),
    ]);
    expect(total).toBe(30);
    expect(convertPenniesToDollars(total)).toBe(0.3);
  });

  it("rounds fractions beyond a cent half-up", () => {
    expect(convertDollarsToPennies("1.005")).toBe(101); // 1.005 -> 100.5 -> 101
    expect(convertDollarsToPennies("1.004")).toBe(100);
  });

  it("returns null for empty/undefined dollar input", () => {
    expect(convertDollarsToPennies(null)).toBeNull();
    expect(convertDollarsToPennies(undefined)).toBeNull();
    expect(convertDollarsToPennies("")).toBeNull();
  });

  it("throws on unparseable dollar input", () => {
    expect(() => convertDollarsToPennies("abc")).toThrow();
  });

  it("multiplies unit price by quantity as integers", () => {
    expect(multiplyPennies(1732, 3)).toBe(5196);
    expect(() => multiplyPennies(1732, -1)).toThrow();
    expect(() => multiplyPennies(1732, 1.5)).toThrow();
  });

  it("sum skips null/undefined entries", () => {
    expect(sumPennies([100, null, 200, undefined, 50])).toBe(350);
  });
});
