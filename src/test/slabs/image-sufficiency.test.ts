import { describe, it, expect } from "vitest";
import { assessFrontImageSufficiency } from "@/lib/slabs/image-sufficiency";
import { ANALYZE_FIELD_KEYS, type AnalyzeFieldKey, type AnalyzeResult, type ProposedField } from "@/server/analyze-slab/handler";

/** A readable field with a concrete value, or an unreadable/blank one. */
function field(value: string | null, readable = value !== null): ProposedField {
  return { value, confidence: readable ? 0.9 : 0, source: "front", readable };
}

/** Build an AnalyzeResult where every field is present; override specific keys. */
function result(overrides: Partial<Record<AnalyzeFieldKey, ProposedField>> = {}): AnalyzeResult {
  const proposed = {} as Record<AnalyzeFieldKey, ProposedField>;
  for (const k of ANALYZE_FIELD_KEYS) proposed[k] = field(`${k}-val`);
  Object.assign(proposed, overrides);
  return {
    status: "success",
    proposed,
    overall_confidence: 0.9,
    label_matches_card: true,
    warnings: [],
    requires_confirmation: true,
  };
}

describe("assessFrontImageSufficiency", () => {
  it("is 'sufficient' when the front yields every required field — back is optional", () => {
    const a = assessFrontImageSufficiency(result(), { backProvided: false });
    expect(a.level).toBe("sufficient");
    expect(a.missing_critical).toEqual([]);
    expect(a.back_recommended).toBe(false);
    expect(a.message).toMatch(/back image is optional/i);
  });

  it("is 'insufficient' and RECOMMENDS THE BACK when the certification number is unreadable", () => {
    const a = assessFrontImageSufficiency(result({ certification_number: field(null) }), { backProvided: false });
    expect(a.level).toBe("insufficient");
    expect(a.missing_critical.map((f) => f.key)).toEqual(["certification_number"]);
    expect(a.back_recommended).toBe(true);
    // Targeted, not generic — it names the field AND that the cert is usually on the back.
    expect(a.message).toMatch(/certification number/);
    expect(a.message).toMatch(/retake a sharper|enter the value manually/i);
  });

  it("does NOT re-recommend the back when it was already provided — advises a sharper retake", () => {
    const a = assessFrontImageSufficiency(result({ grade: field(null) }), { backProvided: true });
    expect(a.level).toBe("insufficient");
    expect(a.back_recommended).toBe(false);
    expect(a.message).toMatch(/sharper/i);
  });

  it("is 'sufficient_with_warnings' when required fields are read but match-improving ones are not", () => {
    const a = assessFrontImageSufficiency(result({ set: field(null), card_number: field(null) }), { backProvided: false });
    expect(a.level).toBe("sufficient_with_warnings");
    expect(a.missing_critical).toEqual([]);
    expect(a.missing_valuable.map((f) => f.key).sort()).toEqual(["card_number", "set"]);
    expect(a.message).toMatch(/front captured everything required/i);
  });

  it("treats a readable-but-empty value as NOT obtained", () => {
    const a = assessFrontImageSufficiency(result({ grader: field("", true) }), { backProvided: false });
    expect(a.level).toBe("insufficient");
    expect(a.missing_critical.map((f) => f.key)).toContain("grader");
  });

  it("lists multiple missing critical fields in the message", () => {
    const a = assessFrontImageSufficiency(
      result({ card_name: field(null), grade: field(null) }),
      { backProvided: false },
    );
    expect(a.level).toBe("insufficient");
    expect(a.message).toMatch(/card name/);
    expect(a.message).toMatch(/grade/);
  });
});
