/**
 * Regression: apostrophes in a card name broke canonical-URL construction.
 *
 *   N's Zoroark ex · Pokemon Japanese Mega Dream ex · #112 (112/193) · Japanese
 *   CGC 10 PRISTINE · product 11302479
 *   https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n%27s-zoroark-ex-112
 *
 * PriceCharting KEEPS the apostrophe in the slug (rendered n%27s). The old slug
 * builder collapsed it to a hyphen (n-s-...), so the derived URL did not resolve
 * and production returned no CGC 10 Pristine value / no artwork. These tests pin:
 *   - buildGameUrl preserves the apostrophe (straight / curly / %27 all → n's),
 *   - canonicalSlugKey makes n's / n-s / n%27s / ns compare EQUAL (redirect-safe),
 *   - a different product still differs,
 *   - verifyPageIdentity does not flag an apostrophe/encoding variance as a mismatch,
 *   - the value handler derives the correct URL and returns the exact Pristine tier.
 */

import { describe, it, expect } from "vitest";
import { buildGameUrl, canonicalSlugKey, safePriceChartingGameUrl } from "@/lib/pricecharting/webpage/url";
import { verifyPageIdentity } from "@/lib/pricecharting/webpage/verify";
import type { RawPageExtract } from "@/lib/pricecharting/webpage/parse";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import type { ProductPageSnapshot } from "@/lib/pricecharting/webpage";
import { createMockFetch, RecordingClock } from "./helpers";

const CONSOLE = "Pokemon Japanese Mega Dream ex";
const EXPECTED = "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n's-zoroark-ex-112";

describe("buildGameUrl preserves apostrophes", () => {
  it("keeps a straight apostrophe (not a hyphen)", () => {
    expect(buildGameUrl(CONSOLE, "N's Zoroark ex #112")).toBe(EXPECTED);
  });
  it("normalizes a curly apostrophe to the same URL", () => {
    expect(buildGameUrl(CONSOLE, "N’s Zoroark ex #112")).toBe(EXPECTED);
  });
  it("normalizes a percent-encoded apostrophe to the same URL", () => {
    expect(buildGameUrl(CONSOLE, "N%27s Zoroark ex #112")).toBe(EXPECTED);
  });
  it("still slugifies other punctuation to hyphens and strips injection", () => {
    expect(buildGameUrl(CONSOLE, "Pikachu & Zekrom GX #33")).toBe(
      "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/pikachu-zekrom-gx-33",
    );
  });
  it("produces a URL that passes the SSRF allowlist", () => {
    expect(safePriceChartingGameUrl(EXPECTED)).not.toBeNull();
  });
});

describe("canonicalSlugKey collapses apostrophe/hyphen/encoding variants", () => {
  const key = canonicalSlugKey("n's-zoroark-ex-112");
  it("treats n's / n-s / n%27s / ns / curly as the SAME product", () => {
    expect(canonicalSlugKey("n-s-zoroark-ex-112")).toBe(key);
    expect(canonicalSlugKey("n%27s-zoroark-ex-112")).toBe(key);
    expect(canonicalSlugKey("ns-zoroark-ex-112")).toBe(key);
    expect(canonicalSlugKey("n’s-zoroark-ex-112")).toBe(key);
  });
  it("treats the full URL forms (literal vs %27, incl. a redirect-final URL) as EQUAL", () => {
    expect(canonicalSlugKey(EXPECTED)).toBe(
      canonicalSlugKey("https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n%27s-zoroark-ex-112"),
    );
  });
  it("does NOT collapse a genuinely different product", () => {
    expect(canonicalSlugKey("pikachu-ex-113")).not.toBe(key);
  });
});

describe("verifyPageIdentity ignores apostrophe/encoding variance", () => {
  function extract(over: Partial<RawPageExtract> = {}): RawPageExtract {
    return { looksLikeProductPage: true, product_id: "11302479", card_number: "112", set_or_console: CONSOLE, canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n%27s-zoroark-ex-112", rows: [{ label: "CGC 10 Pristine", priceText: "$34.99" }], ...over } as RawPageExtract;
  }
  it("VERIFIES when the derived (n's) and page (n%27s) URLs are the same product", () => {
    const v = verifyPageIdentity(extract(), { product_id: "11302479", card_number: "112/193", language: "Japanese", canonical_url: EXPECTED });
    expect(v.status).toBe("VERIFIED");
    expect(v.reasons.join(" ")).not.toMatch(/Canonical URL differs/i);
  });
});

// Handler-level: the value action must DERIVE the apostrophe-preserving URL.
const API_LOOSE_ONLY = { id: "11302479", "product-name": "N's Zoroark ex #112", "console-name": CONSOLE, "loose-price": 147 };
function snapshot(): ProductPageSnapshot {
  return {
    source: "PRICECHARTING_PUBLIC_PAGE", provider_id: "pricecharting", state: "success", product_id: "11302479",
    canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n%27s-zoroark-ex-112",
    retrieved_at: "2026-07-16T00:00:00Z", last_updated_text: null, parser_version: 1, source_version: "pricecharting_public_page.v1",
    identity_status: "VERIFIED",
    identity: { product_id: "11302479", title: "N's Zoroark ex #112", card_number: "112", set_or_console: CONSOLE, language: CONSOLE, canonical_url: null },
    tiers: [
      { tier: "raw", displayed_label: "Ungraded", displayed_price_text: "$1.47", value_cents: 147 },
      { tier: "cgc_10", displayed_label: "CGC 10", displayed_price_text: "$12.50", value_cents: 1250 },
      { tier: "cgc_10_pristine", displayed_label: "CGC 10 Pristine", displayed_price_text: "$34.99", value_cents: 3499 },
    ],
    artwork: { image_url: "https://storage.googleapis.com/images.pricecharting.com/n/240.jpg", image_source: "pricecharting_public_page_product_image", image_confidence: 0.95, is_reference_artwork: true },
    message: "ok",
  };
}

describe("value handler — N's Zoroark ex derives the correct apostrophe URL", () => {
  it("derives n's-zoroark (NOT n-s-) and returns the exact CGC 10 Pristine tier", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: API_LOOSE_ONLY });
    let calledUrl: string | null = null;
    const deps: HandlerDeps = {
      fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => "tok",
      fetchPageSnapshot: async (i: { canonical_url: string }) => { calledUrl = i.canonical_url; return snapshot(); },
    };
    const res = await handlePriceChartingRequest(
      { action: "value", product_id: "11302479", grader: "CGC", grade: 10, grade_label: "PRISTINE", card_number: "112/193", language: "Japanese" },
      deps,
    );
    const body = res.body as unknown as Record<string, unknown>;
    // The derived URL keeps the apostrophe.
    expect(calledUrl).toBe(EXPECTED);
    expect(calledUrl).not.toMatch(/n-s-zoroark/);
    expect(body.guide_value_cents).toBe(3499);
    expect(body.selected_tier_key).toBe("cgc_10_pristine");
    expect(body.tier_availability).toBe("available");
    expect(body.designation_exact).toBe(true);
    expect((body.reference_artwork as Record<string, unknown>).is_reference_artwork).toBe(true);
    expect((body.available_values_cents as Record<string, number>).cgc_10_pristine).toBe(3499);
  });
});
