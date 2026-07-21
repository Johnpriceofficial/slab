import { describe, it, expect } from "vitest";
import {
  normalizeGrade,
  normalizeVariation,
  normalizeGrader,
  normalizeCertification,
  reconcileIdentity,
} from "@/lib/slabs/identity-normalize";

describe("normalizeGrade", () => {
  // Requirement 1: "10" plus "PRISTINE 10" normalizes without a conflict.
  it("splits 'PRISTINE 10' into grade 10 + label PRISTINE", () => {
    expect(normalizeGrade("PRISTINE 10")).toEqual({ grade: "10", grade_label: "PRISTINE" });
  });

  it("returns a bare numeric grade with an empty label", () => {
    expect(normalizeGrade("10")).toEqual({ grade: "10", grade_label: "" });
  });

  it("keeps a one-decimal grade and its multi-word designation", () => {
    expect(normalizeGrade("GEM MINT 9.5")).toEqual({ grade: "9.5", grade_label: "GEM MINT" });
  });

  it("handles the designation printed after the number", () => {
    expect(normalizeGrade("10 PRISTINE")).toEqual({ grade: "10", grade_label: "PRISTINE" });
  });

  it("returns empties for blank input and never invents a grade", () => {
    expect(normalizeGrade("")).toEqual({ grade: "", grade_label: "" });
    expect(normalizeGrade("PRISTINE")).toEqual({ grade: "", grade_label: "PRISTINE" });
  });
});

describe("normalizeVariation", () => {
  // Requirement 2: rarity + finish compose into variation, not a conflict.
  it("composes 'Mega Attack Rare - Holo' from rarity + finish", () => {
    expect(normalizeVariation({ rarity: "Mega Attack Rare", finish: "Holo", variation: "" })).toEqual({
      rarity: "Mega Attack Rare",
      finish: "Holo",
      variation: "Mega Attack Rare - Holo",
    });
  });

  it("decomposes a combined variation to fill a missing rarity", () => {
    expect(normalizeVariation({ rarity: "", finish: "Holo", variation: "Mega Attack Rare - Holo" })).toEqual({
      rarity: "Mega Attack Rare",
      finish: "Holo",
      variation: "Mega Attack Rare - Holo",
    });
  });

  it("leaves an already-complete set untouched", () => {
    expect(normalizeVariation({ rarity: "Rare", finish: "Holo", variation: "Rare - Holo" })).toEqual({
      rarity: "Rare",
      finish: "Holo",
      variation: "Rare - Holo",
    });
  });

  it("does not fabricate a finish when only rarity is present", () => {
    expect(normalizeVariation({ rarity: "Illustration Rare", finish: "", variation: "" })).toEqual({
      rarity: "Illustration Rare",
      finish: "",
      variation: "Illustration Rare",
    });
  });
});

describe("normalizeGrader", () => {
  it("canonicalizes known graders case-insensitively", () => {
    expect(normalizeGrader("cgc")).toBe("CGC");
    expect(normalizeGrader("Psa")).toBe("PSA");
    expect(normalizeGrader("beckett")).toBe("BGS");
    expect(normalizeGrader("SGC")).toBe("SGC");
    expect(normalizeGrader("ags")).toBe("AGS");
  });

  it("preserves an unrecognized grader rather than destroying it", () => {
    expect(normalizeGrader("TAG")).toBe("TAG");
  });
});

describe("normalizeCertification", () => {
  it("removes spaces and punctuation only, preserving every digit and leading zero", () => {
    expect(normalizeCertification("0123 4567")).toBe("01234567");
    expect(normalizeCertification("01-23-45")).toBe("012345");
    expect(normalizeCertification(" 007.008 ")).toBe("007008");
  });

  it("never replaces or drops an uncertain digit (no correction)", () => {
    // The function's only job is to strip separators; digits pass through verbatim.
    expect(normalizeCertification("8O0B")).toBe("8O0B");
  });
});

describe("reconcileIdentity", () => {
  it("treats grade 10 + label 'PRISTINE 10' as one fact, not a conflict", () => {
    const r = reconcileIdentity({ grade: "10", grade_label: "PRISTINE 10" });
    expect(r.grade.value).toBe("10");
    expect(r.grade_label.value).toBe("PRISTINE");
  });

  it("derives variation from rarity + finish and marks it derived", () => {
    const r = reconcileIdentity({ rarity: "Mega Attack Rare", finish: "Holo", variation: "" });
    expect(r.variation.value).toBe("Mega Attack Rare - Holo");
    expect(r.variation.derived).toBe(true);
    expect(r.rarity.derived).toBe(false);
  });
});
