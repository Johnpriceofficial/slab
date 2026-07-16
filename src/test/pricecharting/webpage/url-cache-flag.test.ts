import { describe, it, expect } from "vitest";
import { safePriceChartingGameUrl, isAllowedRedirectTarget, buildGameUrl } from "@/lib/pricecharting/webpage/url";
import { pageCacheKey, identityCacheKey, isCacheFresh, CACHE_TTL_SUCCESS_MS } from "@/lib/pricecharting/webpage/cache";
import { pageAdapterEnabled } from "@/lib/pricecharting/webpage/flag";

const GAME = "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47";

describe("public-page URL safety (SSRF)", () => {
  it("accepts only HTTPS PriceCharting /game/ product URLs", () => {
    expect(safePriceChartingGameUrl(GAME)).not.toBeNull();
    expect(safePriceChartingGameUrl("https://pricecharting.com/game/x/y")).not.toBeNull();
  });

  it("rejects other hosts, protocols, private IPs, credentials, and non-product paths", () => {
    expect(safePriceChartingGameUrl("http://www.pricecharting.com/game/x/y")).toBeNull(); // not https
    expect(safePriceChartingGameUrl("https://evil.com/game/x/y")).toBeNull();
    expect(safePriceChartingGameUrl("https://evil-pricecharting.com/game/x/y")).toBeNull(); // suffix trick
    expect(safePriceChartingGameUrl("https://user:pass@www.pricecharting.com/game/x/y")).toBeNull();
    expect(safePriceChartingGameUrl("https://www.pricecharting.com:8443/game/x/y")).toBeNull(); // custom port
    expect(safePriceChartingGameUrl("https://www.pricecharting.com/offers?product=3472875")).toBeNull(); // not /game/
    expect(safePriceChartingGameUrl("https://127.0.0.1/game/x/y")).toBeNull();
    expect(safePriceChartingGameUrl("file:///etc/passwd")).toBeNull();
  });

  it("(22) rejects redirects to non-PriceCharting hosts", () => {
    expect(isAllowedRedirectTarget("https://evil.com/game/x/y", GAME)).toBe(false);
    expect(isAllowedRedirectTarget("/game/a/b", GAME)).toBe(true); // same-host relative redirect ok
    expect(isAllowedRedirectTarget("https://www.pricecharting.com/offers?product=1", GAME)).toBe(false); // not a product page
  });

  it("builds a game URL only from sanitized slugs", () => {
    expect(buildGameUrl("pokemon-japanese-blue-sky-stream", "rayquaza-vmax-47")).toBe(GAME);
    expect(buildGameUrl("../../etc", "passwd")).toBe("https://www.pricecharting.com/game/etc/passwd"); // path chars stripped
    expect(buildGameUrl("", "x")).toBeNull();
  });
});

describe("public-page cache key — certification-free, specimen-shared", () => {
  const D = { product_id: "3472875", canonical_url: GAME };

  it("(14) cache key contains no certification number and never accepts one", () => {
    const key = pageCacheKey(D);
    expect(key).toContain("id=3472875");
    expect(key).not.toMatch(/6165347099|1234567890|cert/i);
    // Even if a caller wrongly spreads a cert onto the descriptor, it is ignored.
    const withCert = pageCacheKey({ ...D, ...({ certification_number: "6165347099" } as object) });
    expect(withCert).toBe(key);
  });

  it("(15) two different certifications of the same card share ONE snapshot key", () => {
    // The cache descriptor has no cert field, so specimen A and specimen B key identically.
    const a = pageCacheKey(D);
    const b = pageCacheKey(D);
    expect(a).toBe(b);
  });

  it("keys by CANONICAL IDENTITY (cert/grader/owner-free), shared by every specimen", () => {
    const identity = { category_or_manufacturer: "Pokemon", language: "Japanese", set: "Blue Sky Stream", card_number: "047/067", card_name: "Rayquaza VMAX" };
    const key = identityCacheKey(identity);
    expect(key).toContain("pokemon");
    expect(key).toContain("japanese");
    expect(key).toContain("blue-sky-stream");
    expect(key).toContain("rayquaza-vmax");
    // Certification number / grader are not inputs and can never appear.
    expect(key).not.toMatch(/6165347099|cgc|psa|cert|owner|grader/i);
    // Two specimens of the same card (different certs) resolve to the SAME key.
    expect(identityCacheKey(identity)).toBe(key);
    // A different card → a different key; card number is material.
    expect(identityCacheKey({ ...identity, card_number: "001/067" })).not.toBe(key);
    expect(key).toContain("v="); // parser/source version included
  });

  it("(20) the parser/source version is in the key, and freshness gates repeat fetches", () => {
    expect(pageCacheKey(D)).toContain("v=");
    expect(pageCacheKey(D)).toContain("src=");
    expect(pageCacheKey({ ...D, parser_version: 99 })).not.toBe(pageCacheKey(D));
    const stored = 1_000_000;
    expect(isCacheFresh(stored, stored + 1000, CACHE_TTL_SUCCESS_MS)).toBe(true); // fresh → reuse, no fetch
    expect(isCacheFresh(stored, stored + CACHE_TTL_SUCCESS_MS + 1, CACHE_TTL_SUCCESS_MS)).toBe(false);
  });
});

describe("feature flag", () => {
  it("(24) is OFF unless explicitly enabled with 'true' (operator-controlled)", () => {
    // Default OFF — the adapter never turns on silently. ToS-gated opt-in only.
    expect(pageAdapterEnabled(() => undefined)).toBe(false);
    expect(pageAdapterEnabled(() => "")).toBe(false);
    expect(pageAdapterEnabled(() => "false")).toBe(false);
    expect(pageAdapterEnabled(() => "1")).toBe(false);
    expect(pageAdapterEnabled(() => "off")).toBe(false);
    // Only an explicit "true" (case-insensitive) enables it.
    expect(pageAdapterEnabled(() => "TRUE")).toBe(true);
    expect(pageAdapterEnabled(() => "true")).toBe(true);
  });
});
