import { describe, expect, it } from "vitest";
import {
  ANALYSIS_AUTO_APPLY_THRESHOLDS,
  buildAutomaticAnalysisPatch,
  type CanonicalIdentityDraft,
} from "@/lib/slabs/analysis-auto-apply";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

const EMPTY: CanonicalIdentityDraft = {
  card_name: "",
  set_name: "",
  card_number: "",
  year: "",
  language: "",
  rarity: "",
  finish: "",
  variation: "",
  grader: "",
  grade: "",
  grade_label: "",
  certification_number: "",
  label_description: "",
};

function proposal(overrides: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>): AnalyzeProposal {
  const p = {} as AnalyzeProposal;
  for (const key of ANALYZE_FIELD_KEYS) {
    const field = overrides[key];
    p[key] = field
      ? { ...field, source: "label" }
      : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return p;
}

function result(fields: Parameters<typeof proposal>[0], extra: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    status: "success",
    proposed: proposal(fields),
    overall_confidence: 0.96,
    label_matches_card: true,
    warnings: [],
    requires_confirmation: true,
    ...extra,
  };
}

describe("buildAutomaticAnalysisPatch", () => {
  it("applies only readable, valid, threshold-clearing fields into blank canonical values", () => {
    const patch = buildAutomaticAnalysisPatch(
      EMPTY,
      result({
        card_name: { value: "Venusaur", confidence: ANALYSIS_AUTO_APPLY_THRESHOLDS.card_name, readable: true },
        set: { value: "Pokemon GO", confidence: 0.98, readable: true },
        card_number: { value: "003/071", confidence: 0.99, readable: true },
        year: { value: "2022", confidence: 0.95, readable: true },
        language: { value: "Japanese", confidence: 0.96, readable: true },
        grader: { value: "CGC", confidence: 0.99, readable: true },
        grade: { value: "10", confidence: 0.98, readable: true },
        grade_label: { value: "PRISTINE", confidence: 0.98, readable: true },
        certification_number: { value: "6165347099", confidence: 0.99, readable: true },
      }),
    );

    expect(patch.values).toMatchObject({
      card_name: "Venusaur",
      set_name: "Pokemon GO",
      card_number: "003/071",
      year: "2022",
      language: "Japanese",
      grader: "CGC",
      grade: "10",
      grade_label: "PRISTINE",
      certification_number: "6165347099",
    });
    expect(patch.applied).toEqual([
      "card_name",
      "set",
      "card_number",
      "year",
      "language",
      "grader",
      "grade",
      "grade_label",
      "certification_number",
    ]);
    expect(patch.review).toEqual([]);
  });

  it("never overwrites a nonblank canonical value", () => {
    const patch = buildAutomaticAnalysisPatch(
      { ...EMPTY, card_name: "Operator Typed Name", certification_number: "OPERATOR-CERT" },
      result({
        card_name: { value: "Venusaur", confidence: 0.99, readable: true },
        certification_number: { value: "6165347099", confidence: 0.99, readable: true },
      }),
    );

    expect(patch.values.card_name).toBeUndefined();
    expect(patch.values.certification_number).toBeUndefined();
    expect(patch.applied).toEqual([]);
    expect(patch.review).toEqual(["card_name", "certification_number"]);
  });

  it("keeps unreadable, invalid, low-confidence, and label/card-conflicting fields review-only", () => {
    const patch = buildAutomaticAnalysisPatch(
      EMPTY,
      result(
        {
          card_name: { value: "Venusaur", confidence: 0.99, readable: true },
          year: { value: "22", confidence: 0.99, readable: true },
          language: { value: "Japanese", confidence: 0.6, readable: true },
          card_number: { value: null, confidence: 0, readable: false },
          certification_number: { value: "6165347099", confidence: 0.99, readable: true },
        },
        { label_matches_card: false },
      ),
    );

    expect(patch.values).toEqual({});
    expect(patch.applied).toEqual([]);
    expect(patch.review).toEqual(["card_name", "year", "language", "certification_number"]);
  });

  it("normalizes compatible grade and finish evidence without inventing missing certification digits", () => {
    const patch = buildAutomaticAnalysisPatch(
      EMPTY,
      result({
        rarity: { value: "Rare", confidence: 0.95, readable: true },
        finish: { value: "Holo", confidence: 0.95, readable: true },
        grade: { value: "10", confidence: 0.98, readable: true },
        grade_label: { value: "PRISTINE 10", confidence: 0.98, readable: true },
        certification_number: { value: null, confidence: 0, readable: false },
      }),
    );

    expect(patch.values).toMatchObject({
      rarity: "Rare",
      finish: "Holo",
      variation: "Rare - Holo",
      grade: "10",
      grade_label: "PRISTINE",
    });
    expect(patch.values.certification_number).toBeUndefined();
  });
});
