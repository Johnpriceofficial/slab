import { describe, it, expect } from "vitest";
import { centeringScoreFromSplit, sideScoreFromSplits, centeringScore, centeringUncertaintyPoints } from "@/lib/raw-card-pricer/centering";

describe("centeringScoreFromSplit — spec §4 band table", () => {
  it("scores 50/50 and 52/48 as 10", () => {
    expect(centeringScoreFromSplit(50)).toBe(10);
    expect(centeringScoreFromSplit(52)).toBe(10);
  });
  it("scores 53/47 through 55/45 as 9", () => {
    expect(centeringScoreFromSplit(53)).toBe(9);
    expect(centeringScoreFromSplit(55)).toBe(9);
  });
  it("scores 56/44 through 60/40 as 8", () => {
    expect(centeringScoreFromSplit(56)).toBe(8);
    expect(centeringScoreFromSplit(60)).toBe(8);
  });
  it("scores 61/39 through 65/35 as 6", () => {
    expect(centeringScoreFromSplit(61)).toBe(6);
    expect(centeringScoreFromSplit(65)).toBe(6);
  });
  it("scores 66/34 through 70/30 as 4", () => {
    expect(centeringScoreFromSplit(66)).toBe(4);
    expect(centeringScoreFromSplit(70)).toBe(4);
  });
  it("scores worse than 70/30 as 2", () => {
    expect(centeringScoreFromSplit(71)).toBe(2);
    expect(centeringScoreFromSplit(90)).toBe(2);
  });
  it("rejects an out-of-range split instead of silently clamping", () => {
    expect(() => centeringScoreFromSplit(40)).toThrow();
    expect(() => centeringScoreFromSplit(101)).toThrow();
  });
});

describe("sideScoreFromSplits — worse of horizontal/vertical", () => {
  it("takes the worse axis", () => {
    expect(sideScoreFromSplits({ majorityPercent: 52 }, { majorityPercent: 66 })).toBe(4);
    expect(sideScoreFromSplits({ majorityPercent: 90 }, { majorityPercent: 52 })).toBe(2);
  });
});

describe("centeringScore — front/back with back tolerance", () => {
  it("gives the back one grade of additional tolerance before comparing", () => {
    // front=8, back raw=6 -> back-with-tolerance=7 -> min(8,7)=7
    expect(centeringScore(8, 6)).toBe(7);
  });
  it("caps the back tolerance bonus at 10", () => {
    expect(centeringScore(9, 10)).toBe(9);
  });
  it("still uses the front score when it is the worse side", () => {
    expect(centeringScore(4, 10)).toBe(4);
  });
});

describe("centeringUncertaintyPoints", () => {
  it("returns the configured ±3 point default", () => {
    expect(centeringUncertaintyPoints()).toBe(3);
  });
});
