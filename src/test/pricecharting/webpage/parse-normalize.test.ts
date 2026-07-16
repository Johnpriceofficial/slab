import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProductPage } from "@/lib/pricecharting/webpage/parse";
import { normalizeTiers, parsePriceToCents, pageLabelToTier } from "@/lib/pricecharting/webpage/normalize";

const fixture = (name: string) => readFileSync(join(process.cwd(), "src/test/fixtures/pricecharting", name), "utf8");
const RAYQUAZA = fixture("rayquaza-full-prices.html");
const CHALLENGE = fixture("challenge-page.html");

describe("PriceCharting public page — parse + normalize", () => {
  it("parses identity anchors and the #full-prices table from the real structure", () => {
    const x = parseProductPage(RAYQUAZA);
    expect(x.looksLikeProductPage).toBe(true);
    expect(x.product_id).toBe("3472875");
    expect(x.card_number).toBe("47");
    expect(x.canonical_url).toBe("https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47");
    expect(x.rows.length).toBeGreaterThanOrEqual(19);
  });

  it("(5) classifies an anti-bot challenge / error page as NOT a product page", () => {
    const x = parseProductPage(CHALLENGE);
    expect(x.looksLikeProductPage).toBe(false);
    expect(x.rows.length).toBe(0);
    expect(x.product_id).toBeNull();
  });

  it("(6) CGC 10 Pristine parses to 4539 cents", () => {
    const tiers = normalizeTiers(parseProductPage(RAYQUAZA).rows);
    const pristine = tiers.find((t) => t.tier === "cgc_10_pristine")!;
    expect(pristine.value_cents).toBe(4539);
    expect(pristine.displayed_label).toBe("CGC 10 Pristine");
    expect(pristine.displayed_price_text).toBe("$45.39");
  });

  it("(7) CGC 10 stays distinct from CGC 10 Pristine", () => {
    const tiers = normalizeTiers(parseProductPage(RAYQUAZA).rows);
    expect(tiers.find((t) => t.tier === "cgc_10")!.value_cents).toBe(2100);
    expect(tiers.find((t) => t.tier === "cgc_10_pristine")!.value_cents).toBe(4539);
  });

  it("(8) BGS 10 Black Label stays distinct from BGS 10", () => {
    const tiers = normalizeTiers(parseProductPage(RAYQUAZA).rows);
    expect(tiers.find((t) => t.tier === "bgs_10")!.value_cents).toBe(19678);
    expect(tiers.find((t) => t.tier === "bgs_10_black_label")!.value_cents).toBe(98400);
  });

  it("keeps every grade-10 variant a distinct tier (no cross-substitution)", () => {
    const tiers = normalizeTiers(parseProductPage(RAYQUAZA).rows);
    const keys = ["psa_10", "cgc_10", "cgc_10_pristine", "bgs_10", "bgs_10_black_label", "sgc_10", "tag_10", "ace_10"];
    const found = keys.map((k) => tiers.find((t) => t.tier === k)?.value_cents);
    expect(found.every((v) => typeof v === "number")).toBe(true);
    expect(new Set(found).size).toBe(keys.length); // all different values
  });

  it("(9) currency parsing handles commas and decimals", () => {
    expect(parsePriceToCents("$45.39")).toBe(4539);
    expect(parsePriceToCents("$984.00")).toBe(98400);
    expect(parsePriceToCents("$1,234.56")).toBe(123456);
    expect(parsePriceToCents("21")).toBe(2100);
  });

  it("(10) a missing tier ('-') is null, never 0", () => {
    expect(parsePriceToCents("-")).toBeNull();
    const tiers = normalizeTiers(parseProductPage(RAYQUAZA).rows);
    const g1 = tiers.find((t) => t.tier === "grade_1")!; // page shows "-"
    expect(g1.value_cents).toBeNull();
  });

  it("(11) malformed / implausible values are rejected to null", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("N/A")).toBeNull();
    expect(parsePriceToCents("free")).toBeNull();
    expect(parsePriceToCents("$0.00")).toBeNull();
    expect(parsePriceToCents("-$5.00")).toBeNull();
    expect(parsePriceToCents("£45.39")).toBeNull(); // non-USD
    expect(parsePriceToCents("$99999999.00")).toBeNull(); // implausible
  });

  it("maps labels to the canonical tier vocabulary and ignores unknown labels", () => {
    expect(pageLabelToTier("CGC 10 Pristine")).toBe("cgc_10_pristine");
    expect(pageLabelToTier("BGS 10 Black")).toBe("bgs_10_black_label");
    expect(pageLabelToTier("Ungraded")).toBe("raw");
    expect(pageLabelToTier("Some Future Grader 10")).toBeNull();
  });
});
