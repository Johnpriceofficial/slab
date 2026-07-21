import { describe, it, expect } from "vitest";
import { normalizeLanguage, detectConsoleLanguage, languageFamily } from "@/lib/pricecharting/language";

describe("normalizeLanguage — canonical vocabulary, tokenized", () => {
  it("folds common aliases to canonical values", () => {
    expect(normalizeLanguage("Japanese")).toBe("japanese");
    expect(normalizeLanguage("JPN")).toBe("japanese");
    expect(normalizeLanguage("jp")).toBe("japanese");
    expect(normalizeLanguage("English")).toBe("english");
    expect(normalizeLanguage("Korean")).toBe("korean");
    expect(normalizeLanguage("Chinese (Simplified)")).toBe("chinese_simplified");
    expect(normalizeLanguage("Traditional Chinese")).toBe("chinese_traditional");
    expect(normalizeLanguage("Chinese")).toBe("chinese_simplified"); // generic → simplified default
    expect(normalizeLanguage("Thai")).toBe("thai");
    expect(normalizeLanguage("Indonesian")).toBe("indonesian");
    expect(normalizeLanguage("Français")).toBe("french");
    expect(normalizeLanguage("Deutsch")).toBe("german");
    expect(normalizeLanguage("Português")).toBe("portuguese");
    expect(normalizeLanguage("Russian")).toBe("russian");
  });

  it("returns unknown for empty and other for unrecognized", () => {
    expect(normalizeLanguage("")).toBe("unknown");
    expect(normalizeLanguage(null)).toBe("unknown");
    expect(normalizeLanguage("Klingon")).toBe("other");
  });
});

describe("detectConsoleLanguage — from the CONSOLE/SET name only, whole words", () => {
  it("reads PriceCharting language markers", () => {
    expect(detectConsoleLanguage("Pokemon Japanese Blue Sky Stream")).toBe("japanese");
    expect(detectConsoleLanguage("Pokemon Korean Sword & Shield")).toBe("korean");
    expect(detectConsoleLanguage("Pokemon Chinese Simplified")).toBe("chinese_simplified");
  });

  it("returns null for an UNMARKED (English) console — never a false language", () => {
    expect(detectConsoleLanguage("Pokemon Scarlet & Violet 151")).toBeNull();
    expect(detectConsoleLanguage("Pokemon Base Set")).toBeNull();
  });

  it("does NOT misread a card-name-like token as a language (the /chin/ bug)", () => {
    // "Chinchou" contains the substring 'chin' but is NOT Chinese. A naive
    // /chin/ test would have matched it — the whole-word tokenizer must not.
    expect(detectConsoleLanguage("Chinchou")).toBeNull();
    expect(detectConsoleLanguage("Pokemon Neo Genesis Chinchou")).toBeNull();
    // Likewise "Japan"-y or "Korea"-ish card words never trip detection here,
    // because detection is only ever run on the console/set string.
    expect(detectConsoleLanguage("Munchlax")).toBeNull();
  });
});

describe("languageFamily — conflict comparison", () => {
  it("collapses Chinese variants to one family but keeps others distinct", () => {
    expect(languageFamily("chinese_simplified")).toBe("chinese");
    expect(languageFamily("chinese_traditional")).toBe("chinese");
    expect(languageFamily("japanese")).toBe("japanese");
    expect(languageFamily("english")).toBe("english");
  });

  it("has no family for other/unknown (never drives a hard conflict)", () => {
    expect(languageFamily("other")).toBeNull();
    expect(languageFamily("unknown")).toBeNull();
    expect(languageFamily(null)).toBeNull();
  });

  it("Simplified and Traditional do not conflict with each other, but do with Japanese", () => {
    expect(languageFamily("chinese_simplified")).toBe(languageFamily("chinese_traditional"));
    expect(languageFamily("chinese_simplified")).not.toBe(languageFamily("japanese"));
  });
});
