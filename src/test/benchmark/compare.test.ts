import { describe, it, expect } from "vitest";
import { compareField, classifyCertification, normalizeForCompare } from "@/lib/benchmark/compare";
import type { PredictedField } from "@/lib/benchmark/types";

const p = (value: string | null, confidence = 0.9, readable = value !== null): PredictedField => ({ value, confidence, readable });

describe("field comparison — exact and normalized (Requirement 6)", () => {
  it("matches exactly", () => {
    expect(compareField("card_name", p("Charizard"), "Charizard", 0.7).exact).toBe(true);
  });

  it("matches after case/whitespace normalization", () => {
    const o = compareField("card_name", p("  charizard "), "Charizard", 0.7);
    expect(o.exact).toBe(false);
    expect(o.match).toBe(true);
  });

  it("treats grade 10 and 10.0 as equal, and canonicalizes card numbers", () => {
    expect(compareField("grade", p("10.0"), "10", 0.7).match).toBe(true);
    expect(compareField("card_number", p("016/064"), "16/64", 0.7).match).toBe(true);
  });

  it("normalizes graders for comparison", () => {
    expect(normalizeForCompare("grader", "beckett")).toBe(normalizeForCompare("grader", "BGS"));
  });

  it("marks a field with no ground truth as not evaluable", () => {
    expect(compareField("rarity", p("Holo"), "", 0.7).evaluable).toBe(false);
  });

  it("flags false confidence: wrong value at/above the acceptance threshold", () => {
    const o = compareField("card_name", p("Blastoise", 0.95), "Charizard", 0.7);
    expect(o.match).toBe(false);
    expect(o.false_confidence).toBe(true);
  });

  it("does not flag false confidence when the wrong value is below threshold", () => {
    expect(compareField("card_name", p("Blastoise", 0.4), "Charizard", 0.7).false_confidence).toBe(false);
  });
});

describe("certification safety classification (Requirements 7, 8)", () => {
  it("classifies a correct cert after separator-only normalization", () => {
    // "0123-4567" vs "0123 4567" — only separators differ, digits identical.
    expect(classifyCertification(p("0123-4567"), "0123 4567", 0.7)).toBe("correct");
  });

  it("classifies a blank/unreadable cert as the safe non-answer", () => {
    expect(classifyCertification(p(null), "01234567", 0.7)).toBe("blank_unreadable");
    expect(classifyCertification(undefined, "01234567", 0.7)).toBe("blank_unreadable");
  });

  it("classifies a wrong low-confidence cert as incorrect", () => {
    expect(classifyCertification(p("01234568", 0.4), "01234567", 0.7)).toBe("incorrect");
  });

  it("classifies a wrong high-confidence cert as confidently_incorrect (a hard fail)", () => {
    expect(classifyCertification(p("01234568", 0.98), "01234567", 0.7)).toBe("confidently_incorrect");
  });

  it("never 'corrects' an uncertain digit to force a match", () => {
    // A digit that differs stays a mismatch — normalization only strips separators.
    expect(classifyCertification(p("8123 4567", 0.99), "0123 4567", 0.7)).toBe("confidently_incorrect");
  });
});
