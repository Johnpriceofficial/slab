import { describe, it, expect } from "vitest";
import { analyzeSlabImages, type AnalyzeDeps, type AnalyzeModelRequest } from "@/server/analyze-slab/handler";

const FRONT = { front_image_base64: "AAA", front_mime: "image/jpeg" };
const BACK = { back_image_base64: "BBB", back_mime: "image/jpeg" };

function seqDeps(replies: Array<string | (() => Promise<string>)>): { deps: AnalyzeDeps; calls: AnalyzeModelRequest[] } {
  const calls: AnalyzeModelRequest[] = [];
  let i = 0;
  const callModel = async (req: AnalyzeModelRequest) => {
    calls.push(req);
    const entry = replies[Math.min(i, replies.length - 1)];
    i++;
    return typeof entry === "function" ? entry() : entry;
  };
  return { deps: { callModel }, calls };
}

async function analyze(reply: unknown, input = FRONT) {
  const { deps } = seqDeps([JSON.stringify(reply)]);
  const res = await analyzeSlabImages(input, deps);
  if (res.body.status !== "success") throw new Error(`expected success, got ${JSON.stringify(res.body)}`);
  return res.body;
}

describe("compatible readings are reconciled, not flagged as conflicts", () => {
  // Requirement 1 (end to end): "10" + "PRISTINE 10" must not surface a grade conflict.
  it("splits a designation folded into grade_label and raises no conflict", async () => {
    const body = await analyze({
      fields: {
        grade: { value: "10", confidence: 0.98, source: "label", readable: true },
        grade_label: { value: "PRISTINE 10", confidence: 0.95, source: "label", readable: true },
      },
    });
    expect(body.proposed.grade.value).toBe("10");
    expect(body.proposed.grade_label.value).toBe("PRISTINE");
    expect(body.warnings.join(" ")).not.toMatch(/conflict/i);
  });

  // Requirement 2 (end to end): rarity + finish compose into variation, no conflict.
  it("composes variation from rarity + finish and reads finish as its own field", async () => {
    const body = await analyze({
      fields: {
        rarity: { value: "Mega Attack Rare", confidence: 0.9, source: "card", readable: true },
        finish: { value: "Holo", confidence: 0.88, source: "card", readable: true },
        variation: { value: "", confidence: 0, source: "unknown", readable: false },
      },
    });
    expect(body.proposed.rarity.value).toBe("Mega Attack Rare");
    expect(body.proposed.finish.value).toBe("Holo");
    expect(body.proposed.variation.value).toBe("Mega Attack Rare - Holo");
    expect(body.proposed.variation.readable).toBe(true);
    expect(body.warnings.join(" ")).not.toMatch(/conflict/i);
  });

  it("resolves the full provided slab example without grade or variation conflicts", async () => {
    const body = await analyze({
      fields: {
        grader: { value: "CGC", confidence: 0.99, source: "label", readable: true },
        grade: { value: "10", confidence: 0.99, source: "label", readable: true },
        grade_label: { value: "PRISTINE", confidence: 0.98, source: "label", readable: true },
        card_name: { value: "Mega Dragonite ex", confidence: 0.95, source: "card", readable: true },
        set: { value: "Mega Dream ex", confidence: 0.9, source: "card", readable: true },
        year: { value: "2025", confidence: 0.9, source: "label", readable: true },
        language: { value: "Japanese", confidence: 0.95, source: "label", readable: true },
        rarity: { value: "Mega Attack Rare", confidence: 0.9, source: "card", readable: true },
        finish: { value: "Holo", confidence: 0.9, source: "card", readable: true },
        // certification present but too small/blurred → unreadable, never guessed.
        certification_number: { value: null, confidence: 0, source: "label", readable: false },
      },
    });
    expect(body.proposed.grade.value).toBe("10");
    expect(body.proposed.grade_label.value).toBe("PRISTINE");
    expect(body.proposed.variation.value).toBe("Mega Attack Rare - Holo");
    expect(body.proposed.certification_number.value).toBeNull();
    expect(body.warnings.join(" ")).not.toMatch(/grade conflict|variation conflict/i);
  });
});

describe("certification number is never guessed", () => {
  // Requirement 3: a blurred certification returns blank, never fabricated digits.
  it("returns an empty certification with a warning when unreadable", async () => {
    const body = await analyze({
      fields: {
        card_name: { value: "Charizard", confidence: 0.9, source: "card", readable: true },
        certification_number: { value: null, confidence: 0, source: "label", readable: false },
      },
    });
    expect(body.proposed.certification_number.value).toBeNull();
    expect(body.proposed.certification_number.readable).toBe(false);
    expect(body.warnings.join(" ")).toMatch(/could not read/i);
  });

  // Requirement 4: two independent passes over front+back agree → confirmed cert.
  it("confirms a certification when an independent re-read agrees", async () => {
    const { deps } = seqDeps([
      JSON.stringify({
        fields: {
          card_number: { value: null, confidence: 0, source: "label", readable: false },
          certification_number: { value: "0123 4567", confidence: 0.8, source: "label", readable: true },
        },
      }),
      JSON.stringify({ certification_number: { value: "01234567", confidence: 0.85, readable: true } }),
    ]);
    const res = await analyzeSlabImages({ ...FRONT, ...BACK }, deps);
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.certification_number.value).toBe("0123 4567");
    expect(res.body.proposed.certification_number.confidence).toBeGreaterThanOrEqual(0.95);
    expect(res.body.warnings.join(" ")).not.toMatch(/certification number needs review/i);
  });

  // Requirement 5: a genuine disagreement is flagged, not silently resolved.
  it("clears the certification and warns when two independent reads disagree", async () => {
    const { deps } = seqDeps([
      JSON.stringify({
        fields: {
          card_number: { value: null, confidence: 0, source: "label", readable: false },
          certification_number: { value: "00012345", confidence: 0.9, source: "label", readable: true },
        },
      }),
      JSON.stringify({ certification_number: { value: "00012346", confidence: 0.9, readable: true } }),
    ]);
    const res = await analyzeSlabImages({ ...FRONT, ...BACK }, deps);
    if (res.body.status !== "success") throw new Error("expected success");
    expect(res.body.proposed.certification_number.value).toBeNull();
    expect(res.body.warnings.join(" ")).toMatch(/certification number needs review/i);
  });
});
