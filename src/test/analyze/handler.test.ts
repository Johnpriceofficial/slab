import { describe, it, expect } from "vitest";
import { analyzeSlabImages, type AnalyzeDeps } from "@/server/analyze-slab/handler";

const FRONT = { front_image_base64: "AAA", front_mime: "image/jpeg" };

function deps(reply: string | (() => Promise<string>)): AnalyzeDeps {
  return { callModel: typeof reply === "function" ? reply : async () => reply };
}

const fullReply = JSON.stringify({
  fields: {
    card_name: { value: "Charizard", confidence: 0.98, source: "front", readable: true },
    set: { value: "Base Set", confidence: 0.9, source: "front", readable: true },
    card_number: { value: "4", confidence: 0.8, source: "front", readable: true },
    year: { value: "1999", confidence: 0.7, source: "label", readable: true },
    grader: { value: "PSA", confidence: 0.99, source: "label", readable: true },
    grade: { value: "9", confidence: 0.99, source: "label", readable: true },
    certification_number: { value: "00012345", confidence: 0.95, source: "label", readable: true },
  },
  label_matches_card: true,
  overall_confidence: 0.9,
  warnings: [],
});

describe("analyzeSlabImages", () => {
  it("parses a full reply into a typed proposal and always requires confirmation", async () => {
    const res = await analyzeSlabImages(FRONT, deps(fullReply));
    expect(res.statusCode).toBe(200);
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.requires_confirmation).toBe(true);
    expect(res.body.proposed.card_name.value).toBe("Charizard");
    expect(res.body.overall_confidence).toBe(0.9);
  });

  it("captures the grade designation separately (PRISTINE 10 → grade '10' + grade_label 'PRISTINE')", async () => {
    const reply = JSON.stringify({
      fields: {
        grade: { value: "10", confidence: 0.98, source: "label", readable: true },
        grade_label: { value: "PRISTINE", confidence: 0.95, source: "label", readable: true },
      },
    });
    const res = await analyzeSlabImages(FRONT, deps(reply));
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.grade.value).toBe("10");
    expect(res.body.proposed.grade_label.value).toBe("PRISTINE");
    expect(res.body.proposed.grade_label.readable).toBe(true);
  });

  it("preserves certification leading zeros as a string (even if numeric)", async () => {
    const reply = JSON.stringify({ fields: { certification_number: { value: 12345, confidence: 1, source: "label", readable: true } } });
    const res = await analyzeSlabImages(FRONT, deps(reply));
    if (res.body.status !== "success") throw new Error("expected success");
    // numeric input coerced to string, not a JS number
    expect(res.body.proposed.certification_number.value).toBe("12345");
    expect(typeof res.body.proposed.certification_number.value).toBe("string");
  });

  it("flags unreadable fields (null value, warning) instead of guessing", async () => {
    const reply = JSON.stringify({
      fields: {
        card_name: { value: "Blastoise", confidence: 0.9, source: "front", readable: true },
        certification_number: { value: null, confidence: 0, source: "unknown", readable: false },
      },
    });
    const res = await analyzeSlabImages(FRONT, deps(reply));
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.certification_number.readable).toBe(false);
    expect(res.body.proposed.certification_number.value).toBeNull();
    expect(res.body.warnings.some((w) => /Could not read/.test(w))).toBe(true);
  });

  it("surfaces a label/card mismatch as a leading warning", async () => {
    const reply = JSON.stringify({
      fields: { card_name: { value: "Pikachu", confidence: 0.6, source: "card", readable: true } },
      label_matches_card: false,
      overall_confidence: 0.5,
    });
    const res = await analyzeSlabImages(FRONT, deps(reply));
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.label_matches_card).toBe(false);
    expect(res.body.warnings[0]).toMatch(/inconsistent/i);
  });

  it("clamps confidence into [0,1]", async () => {
    const reply = JSON.stringify({ fields: { card_name: { value: "X", confidence: 5, source: "front", readable: true } }, overall_confidence: -2 });
    const res = await analyzeSlabImages(FRONT, deps(reply));
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.card_name.confidence).toBe(1);
    expect(res.body.overall_confidence).toBe(0);
  });

  it("strips a ```json code fence", async () => {
    const res = await analyzeSlabImages(FRONT, deps("```json\n" + fullReply + "\n```"));
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.card_name.value).toBe("Charizard");
  });

  it("errors on a missing front image", async () => {
    const res = await analyzeSlabImages({}, deps(fullReply));
    expect(res.statusCode).toBe(400);
    if (res.body.status !== "error") throw new Error("expected error");
    expect(res.body.error_code).toBe("MISSING_IMAGE");
  });

  it("errors on an unsupported image type", async () => {
    const res = await analyzeSlabImages({ front_image_base64: "AAA", front_mime: "image/gif" }, deps(fullReply));
    if (res.body.status !== "error") throw new Error("expected error");
    expect(res.body.error_code).toBe("UNSUPPORTED_IMAGE");
  });

  it("maps malformed model JSON to a parse error", async () => {
    const res = await analyzeSlabImages(FRONT, deps("not json at all"));
    expect(res.statusCode).toBe(502);
    if (res.body.status !== "error") throw new Error("expected error");
    expect(res.body.error_code).toBe("ANALYSIS_PARSE_ERROR");
  });

  it("maps a provider throw to a provider error", async () => {
    const res = await analyzeSlabImages(FRONT, deps(async () => { throw new Error("boom"); }));
    expect(res.statusCode).toBe(502);
    if (res.body.status !== "error") throw new Error("expected error");
    expect(res.body.error_code).toBe("ANALYSIS_PROVIDER_ERROR");
  });
});
