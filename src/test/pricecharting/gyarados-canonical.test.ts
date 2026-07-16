/**
 * Canonical confirmed-product valuation + artwork regression, pinned to the exact
 * production example:
 *
 *   Gyarados V · Pokemon Japanese Blue Sky Stream · #20 (020/067) · Japanese
 *   https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/gyarados-v-20
 *
 * The confirmed product page carries the full grade table; the official API here
 * carries only loose-price (the real-world failure). The page is part of the
 * CANONICAL workflow: it is fetched for every confirmed graded product, supplies
 * the exact tier + full table + reference artwork, and NEVER substitutes a wrong
 * tier. The API value still wins when present.
 */

import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import type { ProductPageSnapshot } from "@/lib/pricecharting/webpage";
import { deriveValuation } from "@/lib/slabs/valuation-derive";
import { createMockFetch, RecordingClock } from "./helpers";

const TOKEN = "tok-secret-do-not-leak";
const PRODUCT_ID = "5327894";
const CANONICAL = "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/gyarados-v-20";

function base(mock: ReturnType<typeof createMockFetch>): HandlerDeps {
  return { fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => TOKEN };
}

// The exact PriceCharting page grade table (USD cents). Grade 1 / TAG 10 / ACE 10
// are shown "unavailable" → value_cents null (never 0, never substituted).
function tier(t: string, label: string, price: string, cents: number | null) {
  return { tier: t, displayed_label: label, displayed_price_text: price, value_cents: cents };
}
function gyaradosSnapshot(status: ProductPageSnapshot["identity_status"] = "VERIFIED"): ProductPageSnapshot {
  return {
    source: "PRICECHARTING_PUBLIC_PAGE",
    provider_id: "pricecharting",
    state: "success",
    product_id: PRODUCT_ID,
    canonical_url: CANONICAL,
    retrieved_at: "2026-07-16T00:00:00Z",
    last_updated_text: null,
    parser_version: 1,
    source_version: "pricecharting_public_page.v1",
    identity_status: status,
    identity: {
      product_id: PRODUCT_ID,
      title: "Gyarados V #20",
      card_number: "20",
      set_or_console: "Pokemon Japanese Blue Sky Stream",
      language: "Pokemon Japanese Blue Sky Stream",
      canonical_url: CANONICAL,
    },
    tiers: [
      tier("raw", "Ungraded", "$2.73", 273),
      tier("grade_1", "Grade 1", "-", null),
      tier("grade_2", "Grade 2", "$4.00", 400),
      tier("grade_3", "Grade 3", "$4.00", 400),
      tier("grade_4", "Grade 4", "$5.00", 500),
      tier("grade_5", "Grade 5", "$6.00", 600),
      tier("grade_6", "Grade 6", "$7.00", 700),
      tier("grade_7_to_7_5", "Grade 7", "$9.00", 900),
      tier("grade_8_to_8_5", "Grade 8", "$10.73", 1073),
      tier("grade_9_general", "Grade 9", "$12.00", 1200),
      tier("grade_9_5_general", "Grade 9.5", "$13.00", 1300),
      tier("tag_10", "TAG 10", "-", null),
      tier("ace_10", "ACE 10", "-", null),
      tier("sgc_10", "SGC 10", "$22.00", 2200),
      tier("cgc_10", "CGC 10", "$19.13", 1913),
      tier("psa_10", "PSA 10", "$36.03", 3603),
      tier("bgs_10", "BGS 10", "$59.99", 5999),
      tier("bgs_10_black_label", "BGS 10 Black", "$300.00", 30000),
      tier("cgc_10_pristine", "CGC 10 Pristine", "$34.32", 3432),
    ],
    artwork: {
      image_url: "https://storage.googleapis.com/images.pricecharting.com/abc123/240.jpg",
      image_source: "pricecharting_public_page_product_image",
      image_confidence: 0.95,
      is_reference_artwork: true,
    },
    message: "ok",
  };
}

// API returns ONLY loose-price (the reported production failure).
const LOOSE_ONLY = {
  id: PRODUCT_ID,
  "product-name": "Gyarados V #20",
  "console-name": "Pokemon Japanese Blue Sky Stream",
  "loose-price": 273,
};

const IDENTITY = { product_id: PRODUCT_ID, card_number: "020/067", language: "Japanese", canonical_url: CANONICAL };

function valueInput(grader: string, gradeLabel: string | null) {
  return { action: "value" as const, ...IDENTITY, grader, grade: 10, grade_label: gradeLabel ?? undefined };
}

function withPage(mock: ReturnType<typeof createMockFetch>, snap = gyaradosSnapshot()) {
  return { ...base(mock), fetchPageSnapshot: async () => snap };
}

function body(res: Awaited<ReturnType<typeof handlePriceChartingRequest>>) {
  return res.body as unknown as Record<string, unknown>;
}

describe("Gyarados V — canonical page valuation selects the EXACT tier", () => {
  it("CGC 10 PRISTINE → $34.32 from the confirmed page, with reference artwork + full table", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("CGC", "PRISTINE"), withPage(mock)));

    expect(b.guide_value_cents).toBe(3432);
    expect(b.selected_tier_key).toBe("cgc_10_pristine");
    expect(b.valuation_source).toBe("PRICECHARTING_PUBLIC_PAGE");
    expect(b.tier_availability).toBe("available");
    expect(b.designation_exact).toBe(true);
    // Reference artwork comes from the confirmed product page.
    expect((b.reference_artwork as Record<string, unknown>).is_reference_artwork).toBe(true);
    // Full grade table merged for the UI (one fetch).
    const av = b.available_values_cents as Record<string, number | null>;
    expect(av.cgc_10_pristine).toBe(3432);
    expect(av.cgc_10).toBe(1913);
    expect(av.psa_10).toBe(3603);
    expect(av.bgs_10_black_label).toBe(30000);
    expect(av.raw).toBe(273);
  });

  it("CGC 10 Gem Mint → $19.13 (ordinary CGC 10, NOT the Pristine tier)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("CGC", "Gem Mint"), withPage(mock)));
    expect(b.selected_tier_key).toBe("cgc_10");
    expect(b.guide_value_cents).toBe(1913); // never 3432 (no upward substitution)
  });

  it("PSA 10 → $36.03", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("PSA", null), withPage(mock)));
    expect(b.selected_tier_key).toBe("psa_10");
    expect(b.guide_value_cents).toBe(3603);
  });

  it("BGS 10 Black → $300.00 (Black Label tier, never ordinary BGS 10 $59.99)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("BGS", "Black"), withPage(mock)));
    expect(b.selected_tier_key).toBe("bgs_10_black_label");
    expect(b.guide_value_cents).toBe(30000);
  });

  it("missing requested tier (TAG 10 unavailable) → value stays null, NO substitution", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("TAG", null), withPage(mock)));
    expect(b.guide_value_cents).toBeNull();
    expect(b.tier_availability).toBe("tier_unavailable");
    // …but the reference artwork + full table are still returned for manual review.
    expect((b.reference_artwork as Record<string, unknown>).is_reference_artwork).toBe(true);
  });

  it("API HAS the tier → API value wins, page artwork still displays", async () => {
    const mock = createMockFetch();
    // API carries the exact CGC Pristine tier (condition-19-price) at a DIFFERENT-but-close value.
    mock.enqueue("/api/product?", { json: { ...LOOSE_ONLY, "condition-19-price": 3430 } });
    const b = body(await handlePriceChartingRequest(valueInput("CGC", "PRISTINE"), withPage(mock)));
    expect(b.valuation_source).toBe("PRICECHARTING_API");
    expect(b.guide_value_cents).toBe(3430); // API value, not the page's 3432
    expect((b.reference_artwork as Record<string, unknown>).is_reference_artwork).toBe(true);
  });

  it("a REJECTED page identity is NOT used for value or artwork", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const b = body(await handlePriceChartingRequest(valueInput("CGC", "PRISTINE"), withPage(mock, gyaradosSnapshot("REJECTED"))));
    expect(b.guide_value_cents).toBeNull(); // page value rejected → no value from a mismatched page
    expect(b.reference_artwork).toBeNull(); // and no artwork from the wrong card
    expect((b.warnings as string[]).some((w) => /identity check FAILED/i.test(w))).toBe(true);
  });

  it("the value path makes NO eBay/reference call (eBay 409s cannot block valuation)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    await handlePriceChartingRequest(valueInput("CGC", "PRISTINE"), withPage(mock));
    expect(mock.calls.every((c) => !/ebay/i.test(c.url))).toBe(true);
  });
});

describe("Gyarados V — derived Final / Quick-Sale / Replacement", () => {
  it("guide $34.32 → Final $34.32, Quick-Sale $27.46 (80%), Replacement $37.75 (110%)", () => {
    const d = deriveValuation({
      guide_cents: 3432,
      confidence_score: 95,
      field_meaning: "CGC 10 Pristine",
      provenance: "pricecharting_exact_tier",
      identity_confirmed: true,
      visual_confirmed: true,
    });
    expect(d.suggested_final_cents).toBe(3432);
    expect(d.quick_sale_cents).toBe(2746); // round(3432 * 0.8)
    expect(d.replacement_cents).toBe(3775); // round(3432 * 1.1)
  });
});
