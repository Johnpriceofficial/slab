import { describe, it, expect } from "vitest";
import { reconcileGradeReadings, reconcileVariationReadings, type ProposedField } from "@/server/analyze-slab/handler";
import { verifiedBlockers } from "@/lib/slabs/save-slab";

const field = (value: string | null, readable = value !== null, confidence = 0.9): ProposedField => ({
  value,
  confidence,
  source: "label",
  readable,
});

describe("grade reconciliation — numeric + designation, not literal string", () => {
  it("(1) '10' + 'Pristine 10' → grade 10, PRISTINE label, no conflict", () => {
    const r = reconcileGradeReadings(field("10"), field("Pristine 10"));
    expect(r.grade.readable).toBe(true);
    expect(r.grade.value).toBe("10");
    expect(r.grade_label_designation).toBe("PRISTINE");
    expect(r.warning).toBeNull();
  });

  it("(2) '10' + 'Perfect 10' reconciles to 10 + PERFECT", () => {
    const r = reconcileGradeReadings(field("10"), field("Perfect 10"));
    expect(r.grade.value).toBe("10");
    expect(r.grade_label_designation).toBe("PERFECT");
    expect(r.warning).toBeNull();
  });

  it("(3) '10' + 'Black Label 10' reconciles to 10 + BLACK LABEL", () => {
    const r = reconcileGradeReadings(field("10"), field("Black Label 10"));
    expect(r.grade.value).toBe("10");
    expect(r.grade_label_designation).toBe("BLACK LABEL");
    expect(r.warning).toBeNull();
  });

  it("(4) '10' + 'Gem Mint 10' reconciles to 10 + GEM MINT, no conflict", () => {
    const r = reconcileGradeReadings(field("10"), field("Gem Mint 10"));
    expect(r.grade.readable).toBe(true);
    expect(r.grade.value).toBe("10");
    expect(r.grade_label_designation).toBe("GEM MINT");
    expect(r.warning).toBeNull();
  });

  it("also reconciles the reversed order ('Pristine 10' + '10')", () => {
    const r = reconcileGradeReadings(field("Pristine 10"), field("10"));
    expect(r.grade.value).toBe("10");
    expect(r.grade_label_designation).toBe("PRISTINE");
    expect(r.warning).toBeNull();
  });

  it("(4) '9.5' + 'Pristine 10' remains a REAL conflict (grade cleared)", () => {
    const r = reconcileGradeReadings(field("9.5"), field("Pristine 10"));
    expect(r.grade.readable).toBe(false);
    expect(r.grade.value).toBeNull();
    expect(r.warning).toMatch(/disagree/i);
  });

  it("keeps other genuine numeric disagreements a conflict ('9' vs '10', '8.5' vs '9.5')", () => {
    expect(reconcileGradeReadings(field("9"), field("10")).grade.readable).toBe(false);
    expect(reconcileGradeReadings(field("8.5"), field("9.5")).grade.readable).toBe(false);
  });

  it("(5) an unreadable grade stays cleared and blocks a verified save", () => {
    const r = reconcileGradeReadings(field(null, false), field("10"));
    expect(r.grade.readable).toBe(false);
    // A cleared grade must still block the verified save path.
    const blockers = verifiedBlockers({ card_name: "Rayquaza VMAX", grader: "CGC", grade: r.grade.value, certification_number: "6165347099" }, true);
    expect(blockers).toContain("Grade");
  });

  it("does not fabricate a numeric grade from an unparseable pair", () => {
    const r = reconcileGradeReadings(field("Pristine"), field("Gem"));
    expect(r.grade.readable).toBe(false); // no numeric grade in either reading
  });
});

describe("(14) variation reconciliation preserves Holo evidence", () => {
  it("keeps a readable variation instead of clearing it on a benign wording difference", () => {
    const r = reconcileVariationReadings(field("Holo"), field("RRR - Holo"));
    expect(r.variation.readable).toBe(true);
    expect(r.variation.value).toBe("Holo"); // Holo evidence preserved, not dropped
    expect(r.warning).toMatch(/differ/i);
  });

  it("agrees cleanly when both passes match", () => {
    const r = reconcileVariationReadings(field("Holo"), field("holo"));
    expect(r.variation.readable).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("never clears a readable variation just because the reread was unreadable", () => {
    const r = reconcileVariationReadings(field("Holo"), field(null, false));
    expect(r.variation.readable).toBe(true);
    expect(r.variation.value).toBe("Holo");
  });
});
