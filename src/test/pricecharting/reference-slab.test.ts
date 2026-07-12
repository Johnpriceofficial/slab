/**
 * Reference-slab regression: Japanese CGC Pristine 10 Blastoise & Piplup GX,
 * Remix Bout 016/064. Proves the exact failures reported are fixed:
 *   - #16 is ELIGIBLE (input denominator /064 must not reject it),
 *   - #69 / #70 / #76 and a wrong character are HARD-REJECTED,
 *   - a Pikachu misread never matches the Piplup product.
 */

import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import { createMockFetch, RecordingClock } from "./helpers";

const TOKEN = "tok-abcdefghijklmnop";
function deps(mock: ReturnType<typeof createMockFetch>): HandlerDeps {
  return { fetch: mock.fetchImpl, clock: new RecordingClock(), tokenProvider: () => TOKEN };
}

const CAT = "Pokemon Japanese Remix Bout";
const PRODUCTS = [
  { id: "3470072", "product-name": "Blastoise & Piplup GX #16", "console-name": CAT, "release-date": "2019", "graded-price": 8000 },
  { id: "3470125", "product-name": "Blastoise & Piplup GX #69", "console-name": CAT, "release-date": "2019" },
  { id: "3470126", "product-name": "Blastoise & Piplup GX #70", "console-name": CAT, "release-date": "2019" },
  { id: "3470133", "product-name": "Blastoise & Piplup GX #76", "console-name": CAT, "release-date": "2019" },
  { id: "3470122", "product-name": "Venusaur & Snivy GX #66", "console-name": CAT, "release-date": "2019" },
];

const REF = {
  action: "search" as const,
  card_name: "Blastoise & Piplup GX",
  card_number: "016/064",
  set: "Remix Bout",
  year: 2019,
  language: "Japanese",
  grader: "CGC",
  grade: 10,
};

function searchBody(res: Awaited<ReturnType<typeof handlePriceChartingRequest>>) {
  if (res.body.status !== "success" || res.body.action !== "search") {
    throw new Error("expected a successful search response");
  }
  return res.body;
}

describe("reference slab — Blastoise & Piplup GX 016/064 (Remix Bout, Japanese, CGC 10)", () => {
  it("makes #16 eligible and hard-rejects #69/#70/#76 + wrong character", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: PRODUCTS } });
    const body = searchBody(await handlePriceChartingRequest(REF, deps(mock)));

    const eligible = body.candidates.map((c) => c.product_id);
    const rejected = body.rejected_candidates.map((c) => c.product_id);

    // #16 is the correct product and must be selectable.
    expect(eligible).toContain("3470072");
    expect(body.candidates.every((c) => !c.rejected)).toBe(true);

    // Wrong numbers + wrong character are rejected, never selectable.
    for (const id of ["3470125", "3470126", "3470133", "3470122"]) {
      expect(rejected).toContain(id);
      expect(eligible).not.toContain(id);
    }
    // The correct #16 is NOT rejected just because the input denominator is /064.
    expect(rejected).not.toContain("3470072");
  });

  it("auto-eligible #16 records an exact card-number match (canonical #16)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [PRODUCTS[0]] } });
    const body = searchBody(await handlePriceChartingRequest(REF, deps(mock)));
    const c = body.candidates.find((x) => x.product_id === "3470072");
    expect(c).toBeTruthy();
    expect(c!.rejected).toBe(false);
    expect(c!.match_status).not.toBe("no_match");
  });

  it("a Pikachu misread is NOT accepted against the Piplup product", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [PRODUCTS[0]] } });
    const body = searchBody(await handlePriceChartingRequest({ ...REF, card_name: "Blastoise & Pikachu GX" }, deps(mock)));
    expect(body.candidates.map((c) => c.product_id)).not.toContain("3470072");
    const rej = body.rejected_candidates.find((c) => c.product_id === "3470072");
    expect(rej).toBeTruthy();
    expect(rej!.conflicts.some((c) => /character/i.test(c))).toBe(true);
  });

  it("a wrong applied number (018/064) does NOT hard-reject #16 when it's the only conflict — promoted for manual confirmation, never auto-selected", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: [PRODUCTS[0]] } });
    const body = searchBody(await handlePriceChartingRequest({ ...REF, card_number: "018/064" }, deps(mock)));
    // 018 → canonical 18, candidate #16 → mismatch, but name/set/year/language all
    // match, so this is a number-ONLY conflict: promoted to selectable, not rejected.
    const promoted = body.candidates.find((c) => c.product_id === "3470072");
    expect(promoted).toBeTruthy();
    expect(promoted!.rejected).toBe(false);
    expect(body.rejected_candidates.map((c) => c.product_id)).not.toContain("3470072");
    // Never silently confirmed as THE match.
    expect(body.auto_confirmed_product_id).toBeNull();
    expect(body.requires_confirmation).toBe(true);
    // The mismatch stays visible, plus the promoted-candidate caveat naming the real number.
    expect(promoted!.conflicts.some((c) => /card_number mismatch/.test(c))).toBe(true);
    expect(promoted!.conflicts.some((c) => /Verify the number against the physical card/.test(c))).toBe(true);
  });

  it("REAL-WORLD: a wrong OCR number (015/064, wanted #15) promotes ALL FOUR same-name Remix Bout prints (#16/#69/#70/#76) as selectable — never auto-picks one, since they're indistinguishable without the number", async () => {
    // This is the literal reported case: OCR misread "016" as "015". All four
    // Blastoise & Piplup GX prints in this set share name/set/year/language and
    // differ ONLY by collector number — auto-resolving via identity alone would
    // risk silently picking the WRONG print. The correct behavior is to present
    // all four for the operator to disambiguate by checking the physical card.
    const mock = createMockFetch();
    mock.enqueue("/api/products?", { json: { products: PRODUCTS } });
    const body = searchBody(await handlePriceChartingRequest({ ...REF, card_number: "015/064" }, deps(mock)));

    const candidateIds = body.candidates.map((c) => c.product_id);
    const rejectedIds = body.rejected_candidates.map((c) => c.product_id);

    // All four same-name prints promoted to selectable (none auto-confirmed).
    for (const id of ["3470072", "3470125", "3470126", "3470133"]) {
      expect(candidateIds).toContain(id);
      expect(rejectedIds).not.toContain(id);
    }
    // The genuinely different character (Venusaur & Snivy) stays hard-rejected.
    expect(rejectedIds).toContain("3470122");
    expect(candidateIds).not.toContain("3470122");

    // Never silently resolved to any single one of the four.
    expect(body.auto_confirmed_product_id).toBeNull();
    expect(body.requires_confirmation).toBe(true);
    expect(body.warnings.some((w) => /4 candidates matched/.test(w))).toBe(true);

    // Each promoted candidate's own real number is surfaced so the operator can compare.
    const c16 = body.candidates.find((c) => c.product_id === "3470072")!;
    expect(c16.conflicts.some((c) => /printed number is #16/.test(c))).toBe(true);
  });
});
