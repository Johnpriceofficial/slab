import { describe, it, expect } from "vitest";
import { parseManifest, parseCsv, validateImages } from "@/lib/benchmark/manifest";

const HEADER =
  "sample_id,front_image_path,back_image_path,grader,grade,grade_label,certification_number,card_name,set_name,card_number,language,rarity,finish,variation,label_color,lighting_condition,orientation,notes";
const ROW =
  "s1,front.jpg,,CGC,10,PRISTINE,4012345678,Mega Dragonite ex,Mega Dream ex,232/193,Japanese,Mega Attack Rare,Holo,Mega Attack Rare - Holo,gold,studio,vertical,note";

describe("CSV manifest parsing (Requirement 1)", () => {
  it("parses rows and handles a blank back_image_path", () => {
    const { samples, errors } = parseManifest(`${HEADER}\n${ROW}\n`, "csv");
    expect(errors).toEqual([]);
    expect(samples).toHaveLength(1);
    expect(samples[0].sample_id).toBe("s1");
    expect(samples[0].back_image_path).toBeNull();
    expect(samples[0].variation).toBe("Mega Attack Rare - Holo");
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('a,b\n"x,y",z\n');
    expect(rows[1]).toEqual(["x,y", "z"]);
  });

  it("reports missing required columns", () => {
    const { errors } = parseManifest("sample_id,grade\ns1,10\n", "csv");
    expect(errors[0]).toMatch(/missing required columns/i);
  });

  it("flags a row missing a required value and a duplicate id", () => {
    const bad = `${HEADER}\ns1,front.jpg,,CGC,10,PRISTINE,4012345678,Name,Set,1/1,English,R,Holo,V,gold,studio,vertical,n\ns1,front.jpg,,CGC,10,PRISTINE,4012345678,Name,Set,1/1,English,R,Holo,V,gold,studio,vertical,n\n,front.jpg,,CGC,,PRISTINE,4012345678,Name,Set,1/1,English,R,Holo,V,gold,studio,vertical,n`;
    const { errors } = parseManifest(bad, "csv");
    expect(errors.some((e) => /duplicate sample_id/i.test(e))).toBe(true);
    expect(errors.some((e) => /missing required field/i.test(e))).toBe(true);
  });
});

describe("JSON manifest parsing (Requirement 1)", () => {
  it("parses an array of sample objects", () => {
    const json = JSON.stringify([
      {
        sample_id: "j1",
        front_image_path: "f.jpg",
        grader: "PSA",
        grade: "10",
        grade_label: "GEM MT",
        certification_number: "123",
        card_name: "Charizard",
        set_name: "Base",
        card_number: "4/102",
        language: "English",
        rarity: "Holo Rare",
        finish: "Holo",
        variation: "Holo Rare - Holo",
      },
    ]);
    const { samples, errors } = parseManifest(json, "json");
    expect(errors).toEqual([]);
    expect(samples[0].card_name).toBe("Charizard");
  });

  it("rejects non-array JSON", () => {
    const { errors } = parseManifest(JSON.stringify({ nope: true }), "json");
    expect(errors[0]).toMatch(/array of samples/i);
  });
});

describe("missing-image validation (Requirement 2)", () => {
  const { samples } = parseManifest(`${HEADER}\n${ROW}\n`, "csv");

  it("passes when the injected fileExists returns true", () => {
    expect(validateImages(samples, () => true)).toEqual([]);
  });

  it("reports a missing front image", () => {
    const errors = validateImages(samples, () => false);
    expect(errors[0]).toMatch(/front image not found/i);
  });

  it("reports a missing back image only when a back path is given", () => {
    const withBack = parseManifest(`${HEADER}\n${ROW.replace(",front.jpg,,", ",front.jpg,back.jpg,")}\n`, "csv").samples;
    const errors = validateImages(withBack, (p) => p === "front.jpg");
    expect(errors.some((e) => /back image not found/i.test(e))).toBe(true);
  });
});
