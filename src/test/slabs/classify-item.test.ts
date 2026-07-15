import { describe, it, expect } from "vitest";
import { classifyScannedItem } from "@/lib/slabs/classify-item";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

function result(over: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>): AnalyzeResult {
  const proposed = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) {
    const o = over[k];
    proposed[k] = o ? { value: o.value, confidence: o.confidence, source: "label", readable: o.readable } : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return { status: "success", proposed, overall_confidence: 0.8, label_matches_card: null, warnings: [], requires_confirmation: true };
}

describe("classifyScannedItem", () => {
  it("classifies a full grading label as a graded slab with high confidence", () => {
    const c = classifyScannedItem(result({
      grader: { value: "CGC", confidence: 0.99, readable: true },
      grade: { value: "10", confidence: 0.98, readable: true },
      certification_number: { value: "4012345678", confidence: 0.9, readable: true },
    }));
    expect(c.type).toBe("graded_slab");
    expect(c.signals).toEqual(["grader", "grade", "certification_number"]);
    expect(c.confidence).toBeGreaterThan(0.8);
  });

  it("classifies a card with no grading evidence as a raw card", () => {
    const c = classifyScannedItem(result({
      card_name: { value: "Charizard", confidence: 0.95, readable: true },
      set: { value: "Base Set", confidence: 0.9, readable: true },
    }));
    expect(c.type).toBe("raw_card");
    expect(c.signals).toEqual([]);
  });

  it("still calls a single grading signal a graded slab (with lower confidence)", () => {
    const strong = classifyScannedItem(result({
      grader: { value: "PSA", confidence: 0.99, readable: true },
      grade: { value: "9", confidence: 0.99, readable: true },
      certification_number: { value: "12345678", confidence: 0.99, readable: true },
    }));
    const weak = classifyScannedItem(result({ grader: { value: "PSA", confidence: 0.6, readable: true } }));
    expect(weak.type).toBe("graded_slab");
    expect(weak.confidence).toBeLessThan(strong.confidence);
  });

  it("treats an unreadable grader as no signal (raw card)", () => {
    const c = classifyScannedItem(result({ grader: { value: null, confidence: 0, readable: false } }));
    expect(c.type).toBe("raw_card");
  });
});
