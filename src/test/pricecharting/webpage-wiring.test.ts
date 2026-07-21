import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import { slabTierKey } from "@/lib/pricecharting/webpage";
import type { ProductPageSnapshot } from "@/lib/pricecharting/webpage";
import { createMockFetch, RecordingClock } from "./helpers";

const TOKEN = "SECRET-pricecharting-token-DO-NOT-LEAK";
const base = (mock: ReturnType<typeof createMockFetch>): HandlerDeps => ({ fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => TOKEN });

// Rayquaza-shaped product: the API returns ONLY loose-price (no graded tiers).
const LOOSE_ONLY = {
  id: "3472875",
  "product-name": "Rayquaza VMAX #47",
  "console-name": "Pokemon Japanese Blue Sky Stream",
  "loose-price": 500,
};
// Same product but the API DOES carry the exact CGC Pristine tier (condition-19).
const WITH_PRISTINE = { ...LOOSE_ONLY, "condition-19-price": 4539 };

function pageSnapshot(): ProductPageSnapshot {
  return {
    source: "PRICECHARTING_PUBLIC_PAGE", provider_id: "pricecharting", state: "success",
    product_id: "3472875", canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47",
    retrieved_at: "2026-07-16T00:00:00Z", last_updated_text: null, parser_version: 1, source_version: "pricecharting_public_page.v1",
    identity_status: "VERIFIED",
    identity: { product_id: "3472875", title: "Rayquaza VMAX #47", card_number: "47", set_or_console: "Pokemon Japanese Blue Sky Stream", language: "Pokemon Japanese Blue Sky Stream", canonical_url: null },
    tiers: [
      { tier: "cgc_10", displayed_label: "CGC 10", displayed_price_text: "$21.00", value_cents: 2100 },
      { tier: "cgc_10_pristine", displayed_label: "CGC 10 Pristine", displayed_price_text: "$45.39", value_cents: 4539 },
    ],
    artwork: { image_url: "https://storage.googleapis.com/images.pricecharting.com/hash/240.jpg", image_source: "pricecharting_public_page_product_image", image_confidence: 0.9, is_reference_artwork: true },
    message: "ok",
  };
}

const PRISTINE_INPUT = { action: "value" as const, product_id: "3472875", grader: "CGC", grade: 10, grade_label: "PRISTINE", card_number: "047/067", language: "Japanese" };

describe("slabTierKey", () => {
  it("maps grader/grade/designation to the canonical tier (cert-free)", () => {
    expect(slabTierKey("CGC", 10, "PRISTINE")).toBe("cgc_10_pristine");
    expect(slabTierKey("CGC", 10, null)).toBe("cgc_10");
    expect(slabTierKey("BGS", 10, "Black Label")).toBe("bgs_10_black_label");
    expect(slabTierKey("PSA", 10, null)).toBe("psa_10");
    expect(slabTierKey(null, null, null)).toBe("raw");
    expect(slabTierKey("CGC", 9, null)).toBe("grade_9_general");
  });
});

describe("public-page wiring into pricecharting-search value action", () => {
  it("flag OFF (no fetchPageSnapshot dep) → API-only, unchanged behavior; gap stays unavailable", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const res = await handlePriceChartingRequest(PRISTINE_INPUT, base(mock));
    const body = res.body as unknown as Record<string, unknown>;
    expect(body.valuation_source).toBe("PRICECHARTING_API");
    expect(body.guide_value_cents).toBeNull(); // graded slab, API gap → unavailable, NOT loose $5
    expect(body.tier_availability).toBe("tier_unavailable");
    expect(body.public_page).toBeNull();
  });

  it("API HAS the exact tier → page STILL fetched (canonical) for artwork/table, but API value WINS", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: WITH_PRISTINE });
    let pageFetched = false;
    const fetchPageSnapshot = async () => { pageFetched = true; return pageSnapshot(); };
    const res = await handlePriceChartingRequest(PRISTINE_INPUT, { ...base(mock), fetchPageSnapshot });
    const body = res.body as unknown as Record<string, unknown>;
    // Page is part of the canonical workflow: fetched even when the API has the tier,
    // for the full grade table + reference artwork.
    expect(pageFetched).toBe(true);
    // …but a valid exact API value is never overwritten by the page.
    expect(body.valuation_source).toBe("PRICECHARTING_API");
    expect(body.guide_value_cents).toBe(4539); // from the API's condition-19
    // Reference artwork still comes from the confirmed product page, decoupled from source.
    expect((body.reference_artwork as Record<string, unknown> | null)?.is_reference_artwork).toBe(true);
    // The full page tier map is merged for the UI (CGC 10 too), no re-fetch.
    expect((body.available_values_cents as Record<string, number>).cgc_10).toBe(2100);
  });

  it("API gap + flag ON → fills CGC Pristine from the public page with distinct provenance", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    let calledWith: { product_id: string; canonical_url: string; expected: Record<string, unknown> } | null = null;
    const fetchPageSnapshot = async (i: { product_id: string; canonical_url: string; expected: Record<string, unknown> }) => { calledWith = i; return pageSnapshot(); };
    const res = await handlePriceChartingRequest(PRISTINE_INPUT, { ...base(mock), fetchPageSnapshot });
    const body = res.body as unknown as Record<string, unknown>;
    expect(body.guide_value_cents).toBe(4539);
    expect(body.valuation_source).toBe("PRICECHARTING_PUBLIC_PAGE");
    expect(body.selected_tier_key).toBe("cgc_10_pristine");
    expect((body.public_page as Record<string, unknown>).displayed_price_text).toBe("$45.39");
    expect((body.reference_artwork as Record<string, unknown>).is_reference_artwork).toBe(true);
    // Complete tier map merged (CGC 10 too) for the UI, no re-fetch.
    expect((body.available_values_cents as Record<string, number>).cgc_10_pristine).toBe(4539);
    // Cert never entered the page request path.
    expect(calledWith!.canonical_url).toBe("https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47");
    expect(JSON.stringify(calledWith)).not.toMatch(/6165347099|cert/i);
    expect(calledWith!.expected).toEqual({ card_number: "047/067", language: "Japanese" });
  });

  it("returns a derived canonical_url when none is stored", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const res = await handlePriceChartingRequest(PRISTINE_INPUT, base(mock));
    const body = res.body as unknown as Record<string, unknown>;
    expect(body.canonical_url).toBe("https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47");
  });

  it("PREFERS a stored canonical_url over deriving from the product name", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    const stored = "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-047-stored";
    let calledUrl: string | null = null;
    const fetchPageSnapshot = async (i: { canonical_url: string }) => { calledUrl = i.canonical_url; return pageSnapshot(); };
    const res = await handlePriceChartingRequest({ ...PRISTINE_INPUT, canonical_url: stored }, { ...base(mock), fetchPageSnapshot });
    const body = res.body as unknown as Record<string, unknown>;
    expect(body.canonical_url).toBe(stored); // returned as-is, not re-derived
    expect(calledUrl).toBe(stored); // the page fetch used the STORED url
  });

  it("a RAW card never triggers a page fetch and still uses loose-price", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: LOOSE_ONLY });
    let pageFetched = false;
    const fetchPageSnapshot = async () => { pageFetched = true; return pageSnapshot(); };
    const res = await handlePriceChartingRequest({ action: "value", product_id: "3472875" }, { ...base(mock), fetchPageSnapshot });
    const body = res.body as unknown as Record<string, unknown>;
    expect(pageFetched).toBe(false);
    expect(body.guide_value_cents).toBe(500); // raw → loose-price
    expect(body.valuation_source).toBe("PRICECHARTING_API");
  });
});
