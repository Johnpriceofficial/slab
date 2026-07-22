/**
 * Unit coverage for the edge-function-invoking functions in
 * src/lib/slabs/data.ts: priceChartingSearch/Value/OfferImage/Lookup,
 * analyzeSlab, linkAnalysisRun, marketplace + eBay operations,
 * recordPricechartingConfirmation, and refreshSlabPricing (the largest,
 * most-branching function in the file).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseMock }));

import {
  priceChartingSearch,
  priceChartingValue,
  priceChartingOfferImage,
  priceChartingLookup,
  analyzeSlab,
  linkAnalysisRun,
  invokePriceChartingMarketplace,
  syncAllPriceChartingOffers,
  ebayReferenceSearch,
  startEbayOAuth,
  ebaySellerOperation,
  recordPricechartingConfirmation,
  refreshSlabPricing,
} from "@/lib/slabs/data";
import type { Slab } from "@/lib/slabs/types";

function makeFakeBlob(): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(8), type: "image/jpeg" } as unknown as Blob;
}

beforeEach(() => {
  supabaseMock.from.mockReset();
  supabaseMock.rpc.mockReset();
  supabaseMock.functions.invoke.mockReset();
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
});

describe("priceChartingSearch", () => {
  it("returns the search response on success", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success", candidates: [] }, error: null });
    const result = await priceChartingSearch({ card_name: "Charmander" });
    expect(result).toEqual({ status: "success", candidates: [] });
    expect(supabaseMock.functions.invoke).toHaveBeenCalledWith(
      "pricecharting-search",
      { body: { action: "search", card_name: "Charmander" } },
    );
  });

  it("maps a network failure to a retryable NETWORK_ERROR", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "fetch failed" } });
    const result = await priceChartingSearch({});
    expect(result).toEqual({ status: "error", error_code: "NETWORK_ERROR", message: "fetch failed", retryable: true });
  });
});

describe("priceChartingValue", () => {
  it("drops undefined/null/empty identity fields from the body", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    await priceChartingValue({ product_id: "p1", card_name: "Charmander", set: "", year: undefined });
    expect(supabaseMock.functions.invoke).toHaveBeenCalledWith(
      "pricecharting-search",
      { body: { action: "value", product_id: "p1", card_name: "Charmander" } },
    );
  });

  it("maps a network failure to a retryable NETWORK_ERROR", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const result = await priceChartingValue({ product_id: "p1" });
    expect(result).toEqual({ status: "error", error_code: "NETWORK_ERROR", message: "timeout", retryable: true });
  });
});

describe("priceChartingOfferImage / priceChartingLookup", () => {
  it("priceChartingOfferImage requests the offer_image action", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    await priceChartingOfferImage("p1");
    expect(supabaseMock.functions.invoke).toHaveBeenCalledWith(
      "pricecharting-search",
      { body: { action: "offer_image", product_id: "p1" } },
    );
  });

  it("priceChartingLookup treats a slash-bearing string as a URL", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    await priceChartingLookup("pricecharting.com/game/pokemon/charmander", {});
    expect(supabaseMock.functions.invoke).toHaveBeenCalledWith(
      "pricecharting-search",
      { body: { action: "lookup", product_url: "pricecharting.com/game/pokemon/charmander" } },
    );
  });

  it("priceChartingLookup treats a plain string as a product id", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    await priceChartingLookup("5427932", {});
    expect(supabaseMock.functions.invoke).toHaveBeenCalledWith(
      "pricecharting-search",
      { body: { action: "lookup", product_id: "5427932" } },
    );
  });

  it("priceChartingLookup maps a network failure", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    const result = await priceChartingLookup("5427932", {});
    expect(result).toEqual({ status: "error", error_code: "NETWORK_ERROR", message: "down", retryable: true });
  });
});

describe("analyzeSlab", () => {
  it("sends front+back as base64 and returns the analysis result", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    const result = await analyzeSlab({ blob: makeFakeBlob(), mime: "image/jpeg" }, { blob: makeFakeBlob(), mime: "image/jpeg" });
    expect(result).toEqual({ status: "success" });
    const [name, opts] = supabaseMock.functions.invoke.mock.calls[0];
    expect(name).toBe("analyze-slab");
    expect(opts.body.front_mime).toBe("image/jpeg");
    expect(opts.body.back_mime).toBe("image/jpeg");
    expect(typeof opts.body.front_image_base64).toBe("string");
  });

  it("omits back-image fields when no back image is provided", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success" }, error: null });
    await analyzeSlab({ blob: makeFakeBlob(), mime: "image/jpeg" }, null);
    const [, opts] = supabaseMock.functions.invoke.mock.calls[0];
    expect(opts.body.back_image_base64).toBeUndefined();
  });

  it("maps a network failure to a NETWORK_ERROR", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "fail" } });
    const result = await analyzeSlab({ blob: makeFakeBlob(), mime: "image/jpeg" }, null);
    expect(result).toEqual({ status: "error", error_code: "NETWORK_ERROR", message: "fail" });
  });
});

describe("linkAnalysisRun", () => {
  it("calls the RPC and resolves on success", async () => {
    supabaseMock.rpc.mockResolvedValue({ error: null });
    await expect(linkAnalysisRun("run1", "s1")).resolves.toBeUndefined();
    expect(supabaseMock.rpc).toHaveBeenCalledWith("link_ai_analysis_run", { p_run_id: "run1", p_slab_id: "s1" });
  });

  it("throws on RPC error", async () => {
    supabaseMock.rpc.mockResolvedValue({ error: { message: "fail" } });
    await expect(linkAnalysisRun("run1", "s1")).rejects.toThrow("fail");
  });
});

describe("invokePriceChartingMarketplace", () => {
  it("applies the snapshot atomically after a successful publish", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({
      data: { status: "success", snapshot: { offer_id: "o1" } },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({ error: null });
    const result = await invokePriceChartingMarketplace("s1", { action: "publish" } as never);
    expect(result).toEqual({ status: "success", snapshot: { offer_id: "o1" } });
    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      "apply_pricecharting_offer_snapshot",
      expect.objectContaining({ p_slab_id: "s1", p_event_type: "published" }),
    );
  });

  it("surfaces a PERSISTENCE_ERROR when the snapshot apply RPC fails", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({
      data: { status: "success", snapshot: { offer_id: "o1" } },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({ error: { message: "constraint" } });
    const result = await invokePriceChartingMarketplace("s1", { action: "publish" } as never);
    expect(result).toEqual({ status: "error", error_code: "PERSISTENCE_ERROR", message: "constraint", retryable: true });
  });

  it("maps a network failure to a retryable NETWORK_ERROR", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    const result = await invokePriceChartingMarketplace("s1", { action: "details", offer_id: "o1" } as never);
    expect(result).toEqual({ status: "error", error_code: "NETWORK_ERROR", message: "down", retryable: true });
  });
});

describe("syncAllPriceChartingOffers", () => {
  it("returns the sync summary on success", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success", offers_updated: 2 }, error: null });
    expect(await syncAllPriceChartingOffers()).toEqual({ status: "success", offers_updated: 2 });
  });

  it("maps a network failure to an error status", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await syncAllPriceChartingOffers()).toEqual({ status: "error", message: "down" });
  });
});

describe("ebayReferenceSearch", () => {
  it("returns items on success", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success", items: [{ item_id: "i1" }] }, error: null });
    expect(await ebayReferenceSearch({ query: "Charmander" })).toEqual({ status: "success", items: [{ item_id: "i1" }] });
  });

  it("reports unavailable (never throws) when the function errors", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "not configured" } });
    const result = await ebayReferenceSearch({ query: "Charmander" });
    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
  });
});

describe("startEbayOAuth", () => {
  it("returns the authorization URL on success", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success", authorization_url: "https://ebay.example/auth" }, error: null });
    expect(await startEbayOAuth()).toEqual({ status: "success", authorization_url: "https://ebay.example/auth" });
  });

  it("reports unavailable when eBay OAuth is not configured", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "not configured" } });
    expect((await startEbayOAuth()).status).toBe("unavailable");
  });
});

describe("ebaySellerOperation", () => {
  it("returns the function's response on success", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: { status: "success", listing_id: "L1" }, error: null });
    expect(await ebaySellerOperation("ebay-list-item", {})).toEqual({ status: "success", listing_id: "L1" });
  });

  it("maps a network failure to an error status", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await ebaySellerOperation("ebay-order-sync", {})).toEqual({ status: "error", message: "down" });
  });

  it("reports an error when the function returns no body at all", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: null });
    expect(await ebaySellerOperation("ebay-account-sync", {})).toEqual({ status: "error", message: "eBay returned no response." });
  });
});

describe("recordPricechartingConfirmation", () => {
  const confirmation = {
    product_id: "p1",
    candidate_image_url: null,
    candidate_image_source: null,
    candidate_image_type: null,
    candidate_image_available: false,
    visual_confirmation_status: "user_confirmed",
    visual_confirmation_method: "side_by_side",
    visual_rejection_reason: null,
    visual_rejection_note: null,
    product_confirmation_source: "search_auto",
    scoring_version: 1,
  };

  it("returns success on a clean RPC round-trip", async () => {
    supabaseMock.rpc.mockResolvedValue({ error: null });
    const result = await recordPricechartingConfirmation("s1", confirmation);
    expect(result).toEqual({ status: "success" });
    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      "record_pricecharting_confirmation",
      expect.objectContaining({ p_slab_id: "s1" }),
    );
  });

  it("classifies a network error as retryable", async () => {
    supabaseMock.rpc.mockResolvedValue({ error: { message: "network error: fetch failed" } });
    const result = await recordPricechartingConfirmation("s1", confirmation);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.retryable).toBe(true);
  });
});

describe("refreshSlabPricing", () => {
  const baseSlab = {
    id: "s1",
    card_name: "Charmander",
    set_name: null,
    card_number: null,
    year: null,
    language: null,
    variation: null,
    grader: "CGC",
    grade: "10",
    grade_label: "PRISTINE",
    pricecharting_product_id: null,
    pricecharting_match_status: null,
  } as unknown as Slab;

  it("returns no_product when search finds no candidates and no product is linked", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({
      data: { status: "success", candidates: [] },
      error: null,
    });
    const result = await refreshSlabPricing(baseSlab);
    expect(result.status).toBe("no_product");
  });

  it("returns an error status when the search call itself fails", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({ data: null, error: { message: "down" } });
    const result = await refreshSlabPricing(baseSlab);
    expect(result).toEqual({ status: "error", message: "down" });
  });

  it("applies refreshed pricing atomically when a product is already linked", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({
      data: {
        status: "success",
        guide_value_cents: 4250,
        product_name: "Charmander #289/S-P",
        available_values_cents: { cgc_10_pristine: 4250 },
      },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const slab = { ...baseSlab, pricecharting_product_id: "5427932", pricecharting_match_status: "confirmed" } as unknown as Slab;
    const result = await refreshSlabPricing(slab);
    expect(result).toEqual({ status: "applied", guide_cents: 4250, product_name: "Charmander #289/S-P" });
  });

  it("reports stale when a newer pricing write already landed", async () => {
    supabaseMock.functions.invoke.mockResolvedValue({
      data: { status: "success", guide_value_cents: 100, available_values_cents: {} },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({ data: false, error: null });
    const slab = { ...baseSlab, pricecharting_product_id: "5427932", pricecharting_match_status: "confirmed" } as unknown as Slab;
    const result = await refreshSlabPricing(slab);
    expect(result.status).toBe("stale");
  });

  it("catches an unexpected throw and reports it as a plain error", async () => {
    supabaseMock.functions.invoke.mockRejectedValue(new Error("unexpected"));
    const result = await refreshSlabPricing(baseSlab);
    expect(result).toEqual({ status: "error", message: "unexpected" });
  });
});
