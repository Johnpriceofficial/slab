import { describe, expect, it } from "vitest";
import { canSkipBack, slabBackRequirement } from "@/lib/slabs/back-capture";
import type { AnalyzeFieldKey, AnalyzeResult } from "@/server/analyze-slab/handler";

function result(overrides: Partial<Record<AnalyzeFieldKey, { value: string | null; readable: boolean }>> = {}, warnings: string[] = [], confidence = 0.98): AnalyzeResult {
  const values: Record<AnalyzeFieldKey, string> = {
    card_name: "Charizard",
    set: "Base Set",
    card_number: "4/102",
    year: "1999",
    language: "English",
    rarity: "Rare Holo",
    finish: "Holo",
    variation: "Rare Holo - Holo",
    grader: "PSA",
    grade: "10",
    grade_label: "GEM MT",
    certification_number: "12345678",
    label_description: "1999 Pokemon Base Set Charizard",
  };
  const proposed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const override = overrides[key as AnalyzeFieldKey];
      return [key, {
        value: override ? override.value : value,
        confidence: override?.readable === false ? 0 : 0.98,
        source: "front" as const,
        readable: override ? override.readable : true,
      }];
    }),
  ) as AnalyzeResult["proposed"];
  return { status: "success", proposed, overall_confidence: confidence, label_matches_card: true, warnings, requires_confirmation: true };
}

describe("graded slab front-only routing", () => {
  it.each(["PSA", "CGC", "BGS"])("allows a front-only %s slab to continue", (grader) => {
    const analysis = result({ grader: { value: grader, readable: true } });
    const requirement = slabBackRequirement(analysis);
    expect(requirement.requirement).toBe("optional");
    expect(canSkipBack(requirement.requirement)).toBe(true);
  });

  it("recommends review but never requires a back when the front certification is unreadable", () => {
    const requirement = slabBackRequirement(result({ certification_number: { value: null, readable: false } }));
    expect(requirement.requirement).toBe("recommended");
    expect(canSkipBack(requirement.requirement)).toBe(true);
    expect(requirement.reason).toMatch(/front-label|manually/i);
    expect(requirement.reason).toMatch(/optional/i);
  });

  it("does not turn conflicting front evidence into a forced second upload", () => {
    const requirement = slabBackRequirement(result({}, ["Certification number needs review: independent readings disagree."]));
    expect(requirement.requirement).toBe("recommended");
    expect(canSkipBack(requirement.requirement)).toBe(true);
  });

  it("keeps low-confidence front analysis non-blocking", () => {
    const requirement = slabBackRequirement(result({}, [], 0.4));
    expect(requirement.requirement).toBe("recommended");
    expect(canSkipBack(requirement.requirement)).toBe(true);
  });

  it("legacy required values cannot block continuation", () => {
    expect(canSkipBack("required")).toBe(true);
  });
});
