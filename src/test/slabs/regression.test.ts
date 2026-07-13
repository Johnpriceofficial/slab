/**
 * §4 Consolidated regression suite. One place that maps the specification's named
 * scenarios (Rayquaza 3472875, Charmander 5427932, candidate 12165982, …) to the
 * protections that must never regress. Pure-function and mocked-handler coverage
 * lives here; the DB-enforcement scenarios (transactional rollback, RLS,
 * CHECK constraints, leading-zero persistence) are covered by the env-gated live
 * integration suite (src/test/integration) and are referenced by name below.
 */

import { describe, it, expect } from "vitest";
import { handlePriceChartingRequest, type HandlerDeps } from "@/server/pricecharting/handler";
import { createMockFetch, RecordingClock } from "../pricecharting/helpers";
import { getValueForRequestedGrade } from "@/lib/pricecharting/grade-mapping";
import { buildPriceTiers } from "@/lib/slabs/pricing-tiers";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import { evaluateConfirmedProduct } from "@/lib/slabs/confirmed-product";
import { canonicalConfidence } from "@/lib/slabs/constants";
import { validateSlabInput, verifiedBlockers, saveSlab } from "@/lib/slabs/save-slab";
import { identityChangeAction, productSwitchReplacesDerived } from "@/lib/slabs/valuation-provenance";
import { isRetryableConfirmationError } from "@/lib/slabs/confirmation-patch";
import type { Product } from "@/lib/pricecharting/types";
import { makeMockDao, validInput, image } from "./helpers";

const TOKEN = "SECRET-token";
const deps = (mock: ReturnType<typeof createMockFetch>): HandlerDeps => ({
  fetch: mock.fetchImpl,
  clock: new RecordingClock(),
  tokenProvider: () => TOKEN,
});

function product(name: string, prices: Record<string, number>): Product {
  return {
    pricecharting_id: "P",
    name,
    console_or_category: "Pokemon Japanese Promo",
    release_date: null,
    upc: null,
    asin: null,
    epid: null,
    genre: null,
    raw_prices: prices,
  };
}

// ── PriceCharting identity protections ──────────────────────────────────────
describe("§4 identity — Rayquaza / Charmander", () => {
  it("N’s Zoroark ex #112 resolves to 11302479 and Electivire 8830707 is hard-rejected", async () => {
    const identity = { card_name: "N's Zoroark ex", card_number: "112/193", set: "Mega Dream ex", language: "Japanese", grader: "CGC", grade: 10 };
    const correct = createMockFetch();
    correct.enqueue("/api/product?", { json: { status: "success", id: "11302479", "product-name": "N's Zoroark ex #112", "console-name": "Pokemon Japanese Mega Dream ex" } });
    correct.enqueue("/api/offers?", { json: { offers: [] } });
    const good = await handlePriceChartingRequest({ action: "lookup", product_id: "11302479", ...identity }, deps(correct));
    if (good.body.status !== "success" || good.body.action !== "lookup") throw new Error("expected lookup body");
    expect(good.body.product_id).toBe("11302479");
    expect(good.body.disqualified).toBe(false);

    const incorrect = createMockFetch();
    incorrect.enqueue("/api/product?", { json: { status: "success", id: "8830707", "product-name": "Electivire ex #79", "console-name": "Pokemon Japanese Battle Partners" } });
    incorrect.enqueue("/api/offers?", { json: { offers: [] } });
    const bad = await handlePriceChartingRequest({ action: "lookup", product_id: "8830707", ...identity }, deps(incorrect));
    if (bad.body.status !== "success" || bad.body.action !== "lookup") throw new Error("expected lookup body");
    expect(bad.body.product_id).toBe("8830707");
    expect(bad.body.disqualified).toBe(true);
    expect(bad.body.requires_confirmation).toBe(true);
    expect(bad.body.conflicts.join(" ")).toMatch(/character|card name|number|set/i);
  });

  it("1. Rayquaza #047 never auto-confirms a #067 candidate — the number mismatch is always surfaced", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/products?", {
      json: { products: [{ id: "3472875", "product-name": "Rayquaza VMAX #067", "console-name": "Pokemon Japanese Blue Sky Stream" }] },
    });
    const res = await handlePriceChartingRequest(
      { action: "search", card_name: "Rayquaza VMAX", card_number: "047", set: "Blue Sky Stream", grader: "CGC", grade: 10 },
      deps(mock),
    );
    if (res.body.status === "success" && res.body.action === "search") {
      // 067 is a DIFFERENT print — never auto-confirmed for a 047 slab.
      expect(res.body.auto_confirmed_product_id).toBeNull();
      expect(res.body.requires_confirmation).toBe(true);
      // Shown either as a hard reject or a number-only caveated candidate, but always flagged on the number.
      const shown =
        res.body.candidates.find((c) => c.product_id === "3472875") ??
        res.body.rejected_candidates.find((c) => c.product_id === "3472875");
      expect(shown).toBeTruthy();
      expect(shown!.conflicts.join(" ")).toMatch(/number/i);
    } else throw new Error("expected search body");
  });

  it("2. a canonical Rayquaza slug URL resolves to 3472875 via the API (no scraping)", async () => {
    const mock = createMockFetch();
    const ROW = { id: "3472875", "product-name": "Rayquaza VMAX #047", "console-name": "Pokemon Japanese Blue Sky Stream" };
    mock.enqueue("/api/products?", { json: { products: [ROW] } });
    mock.enqueue("/api/product?", { json: { status: "success", ...ROW } });
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest(
      { action: "lookup", product_url: "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-047", card_name: "Rayquaza VMAX", card_number: "047", grader: "CGC", grade: 10 },
      deps(mock),
    );
    if (res.body.status === "success" && res.body.action === "lookup") {
      expect(res.body.product_id).toBe("3472875");
    } else throw new Error("expected lookup body");
  });

  it("10. Charmander 289/S-P resolves to 5427932; 12. a 289/SV-P wrong-character product is blocked", async () => {
    const ID = { card_name: "Charmander", card_number: "289/S-P", grader: "CGC", grade: 10 };
    const ok = createMockFetch();
    ok.enqueue("/api/product?", { json: { status: "success", id: "5427932", "product-name": "Charmander #289/S-P", "console-name": "Pokemon Japanese Promo", "loose-price": 413 } });
    ok.enqueue("/api/offers?", { json: { offers: [] } });
    const good = await handlePriceChartingRequest({ action: "lookup", product_id: "5427932", ...ID }, deps(ok));
    if (good.body.status === "success" && good.body.action === "lookup") {
      expect(good.body.product_id).toBe("5427932");
      expect(good.body.disqualified).toBe(false);
    } else throw new Error("expected lookup body");

    const bad = createMockFetch();
    bad.enqueue("/api/product?", { json: { status: "success", id: "999", "product-name": "Pikachu #289/SV-P", "console-name": "Pokemon Japanese Promo" } });
    bad.enqueue("/api/offers?", { json: { offers: [] } });
    const wrong = await handlePriceChartingRequest({ action: "lookup", product_id: "999", ...ID }, deps(bad));
    if (wrong.body.status === "success" && wrong.body.action === "lookup") {
      expect(wrong.body.disqualified).toBe(true);
      expect(wrong.body.requires_confirmation).toBe(true);
    } else throw new Error("expected lookup body");
  });
});

// ── Confirmed-id-first state machine ────────────────────────────────────────
describe("§4 confirmed-id-first", () => {
  it("3. a stored confirmed id (3472875) is retained (fetched first, no fuzzy) when it still matches", () => {
    const d = evaluateConfirmedProduct("3472875", { found: true, disqualified: false, requires_confirmation: false, conflicts: [] });
    expect(d.state).toBe("retained");
    expect(d.allow_fuzzy).toBe(false); // fuzzy only on explicit user action
    expect(d.preserve_link).toBe(true);
  });

  it("4. a fresh candidate (12165982) can't silently replace a confirmed product", () => {
    // Without an explicit 'search again', fuzzy is not allowed → nothing can replace it.
    const d = evaluateConfirmedProduct("3472875", { found: true, disqualified: false, requires_confirmation: true, conflicts: ["below threshold"] });
    expect(d.preserve_link).toBe(true);
    expect(d.allow_fuzzy).toBe(false);
    // Only an explicit user choice opens fuzzy replacement.
    const explicit = evaluateConfirmedProduct("3472875", { found: true, disqualified: false, requires_confirmation: true, conflicts: [] }, true);
    expect(explicit.allow_fuzzy).toBe(true);
  });

  it("a failed refresh is not misclassified as product unavailable and preserves the id", () => {
    const d = evaluateConfirmedProduct("3472875", null);
    expect(d.state).toBe("refresh_error");
    expect(d.preserve_link).toBe(true);
    expect(d.allow_fuzzy).toBe(false);
  });
});

// ── Tiers, designation, and valuation ───────────────────────────────────────
describe("§4 tiers & valuation", () => {
  it("5. a loose-only product keeps $5.00 as UNGRADED; the CGC 10 graded tier stays null", () => {
    const p = product("Charmander #289/S-P", { "loose-price": 500 }); // 500 pennies = $5.00
    const graded = getValueForRequestedGrade(p, "CGC", 10, { category: "card" });
    expect(graded.value_pennies).toBeNull(); // loose is never used as the graded value
    expect(graded.nearby_values.ungraded).toBe(5); // nearby_values are dollars → $5.00
    const ungraded = getValueForRequestedGrade(p, "CGC", null, { category: "card" });
    expect(ungraded.value_pennies).toBe(500); // pennies
    expect(ungraded.selected_tier_key).toBe("ungraded");
  });

  it("6. a missing Pristine tier is null, never $0", () => {
    const r = getValueForRequestedGrade(product("x", {}), "CGC", 10, { category: "card", designation: "PRISTINE" });
    expect(r.value_pennies).toBeNull();
    expect(r.value_pennies).not.toBe(0);
    expect(r.designation_exact).toBe(false);
  });

  it("7. a website-only $45.39 is never fabricated from a loose-only product", () => {
    const p = product("x", { "loose-price": 413 });
    const tiers = buildPriceTiers(
      Object.fromEntries(Object.entries(getValueForRequestedGrade(p, "CGC", 10, { category: "card" }).nearby_values).map(([k, v]) => [k, v === null ? null : Math.round(v * 100)])),
      { grader: "CGC", grade: "10", grade_label: "PRISTINE" },
    );
    // No tier anywhere carries the fabricated 4539.
    expect(tiers.every((t) => t.value_cents !== 4539)).toBe(true);
    expect(tiers.find((t) => t.tier === "cgc_10_pristine")?.value_cents ?? null).toBeNull();
  });

  it("9. an ordinary CGC 10 value for a Pristine slab is COMPATIBLE, never an exact Verified Pristine", () => {
    const m = buildPricingModel({
      final_cents: 4250, guide_cents: 4250, quick_cents: 3400, replacement_cents: 4675,
      valuation_confidence: "verified", price_variance_percent: 0,
      grader: "CGC", grade: "10", grade_label: "PRISTINE", product_name: "Charmander", product_id: "5427932",
    });
    expect(m.match_kind).toBe("compatible");
    expect(m.exact_match).toBe(false);
    expect(m.confidence_label).not.toBe("Verified");
  });
});

// ── Provenance (identity edits / switching) ─────────────────────────────────
describe("§4 valuation provenance", () => {
  it("13/14. an identity edit clears AUTO valuation but preserves MANUAL with a warning", () => {
    expect(identityChangeAction("pricecharting_exact_tier")).toEqual({ clearAutoValuation: true, warnManualStale: false });
    expect(identityChangeAction("pricecharting_estimate")).toEqual({ clearAutoValuation: true, warnManualStale: false });
    expect(identityChangeAction("manual_value")).toEqual({ clearAutoValuation: false, warnManualStale: true });
    expect(identityChangeAction("tier_unavailable")).toEqual({ clearAutoValuation: false, warnManualStale: false });
  });

  it("15. switching products replaces a DERIVED valuation but never a MANUAL one", () => {
    expect(productSwitchReplacesDerived("pricecharting_exact_tier")).toBe(true);
    expect(productSwitchReplacesDerived("pricecharting_compatible_tier")).toBe(true);
    expect(productSwitchReplacesDerived("manual_guide")).toBe(false);
  });
});

// ── Persistence, drafts, confidence ─────────────────────────────────────────
describe("§4 persistence, drafts & confidence", () => {
  it("18. persistence errors are classified: constraint/auth failures NOT retryable, transient ones are", () => {
    expect(isRetryableConfirmationError("violates check constraint")).toBe(false);
    expect(isRetryableConfirmationError("not authorized")).toBe(false);
    expect(isRetryableConfirmationError("Failed to fetch")).toBe(true);
  });

  it("19/26/27. a front-only draft with no cert saves; back stays optional", async () => {
    expect(validateSlabInput({ ...validInput(), certification_number: null } as never, true, false, "draft")).toEqual([]);
    const { dao, state } = makeMockDao();
    const res = await saveSlab({ ...validInput(), card_name: "", certification_number: null } as never, image(), null, dao, null, "draft");
    expect(res.status).toBe("success");
    expect(state.createdNumbers).toHaveLength(1);
  });

  it("20. a verified save is blocked without a certification number", () => {
    const errors = validateSlabInput({ ...validInput(), certification_number: "" }, true, false, "verified");
    expect(errors).toContain("Certification number is required.");
    expect(verifiedBlockers({ ...validInput(), certification_number: "" }, true)).toContain("Certification number");
  });

  it("22. duplicate certs are grader-scoped (same grader rejected, different grader allowed)", async () => {
    const { dao } = makeMockDao({ existingCerts: { "PSA:12345678": 7 } });
    const same = await saveSlab(validInput({ grader: "PSA", certification_number: "12345678" }), image(), image(), dao);
    expect(same.status).toBe("duplicate");
    const other = await saveSlab(validInput({ grader: "CGC", certification_number: "12345678" }), image(), image(), dao);
    expect(other.status).toBe("success");
  });

  it("23. legacy confidence values migrate WITHOUT changing meaning (exact→high, probable→moderate)", () => {
    expect(canonicalConfidence("exact")).toBe("high");
    expect(canonicalConfidence("probable")).toBe("moderate");
    expect(canonicalConfidence("verified")).toBe("verified");
    expect(canonicalConfidence("manual")).toBe("manual");
    expect(canonicalConfidence(null)).toBeNull();
  });

  // 8 (no-image disables visual Yes/No), 16 (confirmation+audit rollback),
  // 17 (rejection survives reload), 21 (leading-zero cert persistence), 24 (CHECK
  // constraints), 25 (RLS) are enforced at the DB / DOM boundary and are covered by
  // src/test/integration/slabvault.integration.test.ts (env-gated live suite).
  it("8. the handler reports image_source 'none' when no marketplace photo exists (visual Yes/No then disabled)", async () => {
    const mock = createMockFetch();
    mock.enqueue("/api/offers?", { json: { offers: [] } });
    const res = await handlePriceChartingRequest({ action: "offer_image", product_id: "5427932" }, deps(mock));
    if (res.body.status === "success" && res.body.action === "offer_image") {
      expect(res.body.offer_image_url).toBeNull();
      expect(res.body.image_source).toBe("none");
    } else throw new Error("expected offer_image body");
  });
});
