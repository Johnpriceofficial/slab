import { describe, it, expect } from "vitest";
import { slabBackRequirement, canSkipBack } from "@/lib/slabs/back-capture";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

function analysis(
  over: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>,
  extra: Partial<AnalyzeResult> = {},
): AnalyzeResult {
  const proposed = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) {
    const o = over[k];
    proposed[k] = o ? { value: o.value, confidence: o.confidence, source: "label", readable: o.readable } : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return { status: "success", proposed, overall_confidence: 0.9, label_matches_card: null, warnings: [], requires_confirmation: true, ...extra };
}

const strongFront = {
  grader: { value: "CGC", confidence: 0.99, readable: true },
  grade: { value: "10", confidence: 0.98, readable: true },
  certification_number: { value: "4012345678", confidence: 0.95, readable: true },
};

describe("slabBackRequirement", () => {
  it("recommends review rather than requiring the back when the certification number is unreadable", () => {
    const r = slabBackRequirement(analysis({ grader: { value: "CGC", confidence: 0.9, readable: true }, certification_number: { value: null, confidence: 0, readable: false } }));
    expect(r.requirement).toBe("recommended");
    expect(r.reason).toMatch(/certification number/i);
    expect(r.reason).toMatch(/front|manual/i);
  });

  it("recommends review rather than requiring the back when independent front reads disagree", () => {
    const r = slabBackRequirement(analysis(strongFront, { warnings: ["Card number could not be verified: two independent readings disagree."] }));
    expect(r.requirement).toBe("recommended");
    expect(canSkipBack(r.requirement)).toBe(true);
  });

  it("recommends the back on low overall confidence", () => {
    const r = slabBackRequirement(analysis(strongFront, { overall_confidence: 0.5 }));
    expect(r.requirement).toBe("recommended");
  });

  it("recommends the back when the grader is unreadable but the cert is present", () => {
    const r = slabBackRequirement(analysis({ certification_number: { value: "4012345678", confidence: 0.9, readable: true } }));
    expect(r.requirement).toBe("recommended");
  });

  it("makes the back optional when the front is strong and complete", () => {
    expect(slabBackRequirement(analysis(strongFront)).requirement).toBe("optional");
  });

  it("always permits continuing without the back, including legacy required values", () => {
    expect(canSkipBack("required")).toBe(true);
    expect(canSkipBack("recommended")).toBe(true);
    expect(canSkipBack("optional")).toBe(true);
  });
});