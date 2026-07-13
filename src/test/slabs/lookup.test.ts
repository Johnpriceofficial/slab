import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, parseProductId, type HandlerDeps } from "@/server/pricecharting/handler";
import { createMockFetch, RecordingClock } from "../pricecharting/helpers";

const TOKEN = "SECRET-pricecharting-token-DO-NOT-LEAK-1234567890";
function deps(mock: ReturnType<typeof createMockFetch>): HandlerDeps {
  return { fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => TOKEN };
}

const CHARMANDER = { id: "5427932", "product-name": "Charmander #289/S-P", "console-name": "Pokemon Japanese Promo", "loose-price": 413 };
const IDENTITY = { card_name: "Charmander", card_number: "289/S-P", grader: "CGC", grade: 10 };

describe("parseProductId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseProductId({ product_id: "5427932" })).toBe("5427932");
    expect(parseProductId({ product_id: " 5427932 " })).toBe("5427932");
  });
  it("extracts an id from a ?id= URL or a 5+ digit path segment", () => {
    expect(parseProductId({ product_url: "https://www.pricecharting.com/offer?id=5427932" })).toBe("5427932");
    expect(parseProductId({ product_url: "https://www.pricecharting.com/product/5427932" })).toBe("5427932");
  });
  it("returns null for a slug-only PriceCharting URL (no numeric id present)", () => {
    expect(parseProductId({ product_url: "https://www.pricecharting.com/game/pokemon-japanese-promo/charmander-289s-p" })).toBeNull();
    expect(parseProductId({})).toBeNull();
  });
  it("does NOT mistake a stray query param or mid-path number for a product id", () => {
    expect(parseProductId({ product_url: "https://www.pricecharting.com/game/pokemon-japanese-promo/charmander-289s-p?sort=99999" })).toBeNull();
    expect(parseProductId({ product_url: "https://www.pricecharting.com/x?utm_source=12345678" })).toBeNull();
    expect(parseProductId({ product_url: "https://www.pricecharting.com/game/12345/charizard" })).toBeNull();
    // A trailing numeric path segment IS the id.
    expect(parseProductId({ product_url: "https://www.pricecharting.com/product/5427932" })).toBe("5427932");
  });
});

describe("handler — lookup (manual recovery / confirmed-id-first)", () => {
  it("fetches the exact product, validates identity, and attaches an offer image", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "success", ...CHARMANDER } });
    mock.enqueue("/api/offers?", { json: { offers: [{ "offer-id": "o1", status: "available", "image-url": "https://storage.googleapis.com/images.pricecharting.com/x/240.jpg" }] } });
    const res = await handlePriceChartingRequest({ action: "lookup", product_id: "5427932", ...IDENTITY }, deps(mock));
    expect(res.statusCode).toBe(200);
    if (res.body.status === "success" && res.body.action === "lookup") {
      expect(res.body.product_id).toBe("5427932");
      expect(res.body.disqualified).toBe(false);
      expect(res.body.character_exact).toBe(true);
      expect(res.body.number_exact_full).toBe(true);
      expect(res.body.requires_confirmation).toBe(false); // identity floor → safe to link
      expect(res.body.offer_image_url).toMatch(/googleapis/);
      // CGC 10 has no graded tier for this product → guide null, NOT $0.
      expect(res.body.guide_value_cents).toBeNull();
      expect(res.body.available_values_cents.ungraded).toBe(413);
    } else {
      throw new Error("expected a lookup success body");
    }
  });

  it("runs the SAME hard-conflict protections — a wrong-character product is disqualified + blocked", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "success", id: "999", "product-name": "Fukuoka's Pikachu #289/SV-P", "console-name": "Pokemon Japanese Promo" } });
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest({ action: "lookup", product_id: "999", ...IDENTITY }, deps(mock));
    if (res.body.status === "success" && res.body.action === "lookup") {
      expect(res.body.disqualified).toBe(true);
      expect(res.body.requires_confirmation).toBe(true);
      expect(res.body.conflicts.join()).toMatch(/character mismatch/);
    } else {
      throw new Error("expected a lookup success body");
    }
  });

  it("requires confirmation for a NON-disqualifying conflict (year mismatch), never flags it safe", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "success", id: "5427932", "product-name": "Charmander #289/S-P", "console-name": "Pokemon Japanese Promo", "release-date": "2021-03-19" } });
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest({ action: "lookup", product_id: "5427932", ...IDENTITY, year: 1998 }, deps(mock));
    if (res.body.status === "success" && res.body.action === "lookup") {
      expect(res.body.disqualified).toBe(false); // year is not a hard conflict…
      expect(res.body.conflicts.join()).toMatch(/[Yy]ear/);
      expect(res.body.requires_confirmation).toBe(true); // …but it is NOT safe to auto-link
    } else {
      throw new Error("expected a lookup success body");
    }
  });

  it("400s a URL with no extractable id (slug-only), never contacting PriceCharting", async () => {
    const mock = createMockFetch();
    const res = await handlePriceChartingRequest({ action: "lookup", product_url: "https://www.pricecharting.com/game/pokemon-japanese-promo/charmander-289s-p", ...IDENTITY }, deps(mock));
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("error");
    expect(mock.calls.length).toBe(0);
  });

  it("reports PRODUCT_NOT_FOUND for a nonexistent id", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/product?", { json: { status: "success" } }); // no id/name → normalizeProduct yields empty
    const res = await handlePriceChartingRequest({ action: "lookup", product_id: "123456", ...IDENTITY }, deps(mock));
    expect(res.statusCode).toBe(404);
    if (res.body.status === "error") expect(res.body.error_code).toBe("PRODUCT_NOT_FOUND");
  });
});
