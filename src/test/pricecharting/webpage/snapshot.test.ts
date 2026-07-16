import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductPageSnapshot, valueGradedTierApiFirst, snapshotTierMap, type SnapshotInput, type ProductPageSnapshot } from "@/lib/pricecharting/webpage";
import { resetPageBreaker, type PageFetch } from "@/lib/pricecharting/webpage/fetch";

const fixture = (name: string) => readFileSync(join(process.cwd(), "src/test/fixtures/pricecharting", name), "utf8");
const RAYQUAZA_HTML = fixture("rayquaza-full-prices.html");
const WRONG_HTML = fixture("wrong-product.html");

const GAME = "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47";
const INPUT: SnapshotInput = { product_id: "3472875", canonical_url: GAME, expected: { card_number: "047/067", language: "Japanese" } };
const NOW = () => "2026-07-16T00:00:00Z";

interface FakeResp { status: number; headers?: Record<string, string>; body?: string }
function fakeFetch(resps: FakeResp | FakeResp[]) {
  const list = Array.isArray(resps) ? resps : [resps];
  const calls: string[] = [];
  const fn: PageFetch = async (url) => {
    calls.push(url);
    const r = list[Math.min(calls.length - 1, list.length - 1)];
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
  };
  return { fn, calls };
}

afterEach(() => resetPageBreaker());

describe("getProductPageSnapshot — orchestration", () => {
  it("(24) with the flag OFF, returns 'disabled' and performs NO fetch", async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: RAYQUAZA_HTML });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "false" });
    expect(snap.state).toBe("disabled");
    expect(calls.length).toBe(0); // never touched the network
    expect(snap.tiers).toEqual([]);
  });

  it("with the flag ON, fetches once, verifies identity, and returns normalized tiers + artwork", async () => {
    const beforeCalls: number[] = [];
    const { fn, calls } = fakeFetch({ status: 200, body: RAYQUAZA_HTML });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true", beforeRequest: async () => { beforeCalls.push(1); } });
    expect(snap.state).toBe("success");
    expect(snap.identity_status).toBe("VERIFIED");
    expect(snap.tiers.find((t) => t.tier === "cgc_10_pristine")!.value_cents).toBe(4539);
    expect(snap.artwork?.image_url).toMatch(/storage\.googleapis\.com/);
    expect(calls.length).toBe(1);
    expect(beforeCalls.length).toBe(1); // (21) rate-limit reservation awaited before the request
  });

  it("(23) the snapshot NEVER contains raw HTML", async () => {
    const { fn } = fakeFetch({ status: 200, body: RAYQUAZA_HTML });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/<table|<tr\b|<td\b|full-prices|<html/i);
    expect(serialized).toContain("$45.39"); // displayed text is fine; raw markup is not
  });

  it("rejects a page whose identity does not match the linked product", async () => {
    const { fn } = fakeFetch({ status: 200, body: WRONG_HTML }); // product 6910
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    expect(snap.state).toBe("product_mismatch");
    expect(snap.tiers).toEqual([]);
  });

  it("(21) surfaces rate limiting with Retry-After and does not retry it", async () => {
    const { fn, calls } = fakeFetch({ status: 429, headers: { "retry-after": "30" } });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    expect(snap.state).toBe("rate_limited");
    expect(calls.length).toBe(1); // never retried
  });

  it("reports provider_blocked on 403 without evasion", async () => {
    const { fn } = fakeFetch({ status: 403 });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    expect(snap.state).toBe("provider_blocked");
  });

  it("rejects a redirect to a non-PriceCharting host", async () => {
    const { fn } = fakeFetch({ status: 302, headers: { location: "https://evil.com/game/x/y" } });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    expect(snap.state).toBe("product_mismatch");
  });

  it("retries ONCE on a transient 5xx, then succeeds", async () => {
    const { fn, calls } = fakeFetch([{ status: 503 }, { status: 200, body: RAYQUAZA_HTML }]);
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    expect(snap.state).toBe("success");
    expect(calls.length).toBe(2);
  });

  it("captures the COMPLETE grade set in one snapshot (no per-tier re-fetch)", async () => {
    const { fn } = fakeFetch({ status: 200, body: RAYQUAZA_HTML });
    const snap = await getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    const map = snapshotTierMap(snap);
    expect(map).toMatchObject({
      raw: 500, grade_9_general: 3908, grade_9_5_general: 4300,
      psa_10: 10463, cgc_10: 2100, cgc_10_pristine: 4539,
      bgs_10: 19678, bgs_10_black_label: 98400, sgc_10: 827, tag_10: 4125, ace_10: 6006,
    });
  });
});

describe("API-first orchestration — the page is fetched ONLY on an API gap", () => {
  it("uses the API value and NEVER fetches the page when the API has the exact tier", async () => {
    let pageFetched = false;
    const fetchPage = async (): Promise<ProductPageSnapshot> => { pageFetched = true; throw new Error("should not be called"); };
    const { resolution, page_snapshot } = await valueGradedTierApiFirst({ tier: "cgc_10_pristine", api_cents: 4539, fetchPage });
    expect(pageFetched).toBe(false); // page adapter never ran
    expect(page_snapshot).toBeNull();
    expect(resolution.source).toBe("PRICECHARTING_API");
    expect(resolution.value_cents).toBe(4539);
  });

  it("falls back to the verified public-page tier ONLY when the API lacks it", async () => {
    let pageFetched = false;
    const { fn } = fakeFetch({ status: 200, body: RAYQUAZA_HTML });
    const fetchPage = async (): Promise<ProductPageSnapshot> => {
      pageFetched = true;
      return getProductPageSnapshot(INPUT, { fetch: fn, now: NOW, getEnv: () => "true" });
    };
    const { resolution, page_snapshot } = await valueGradedTierApiFirst({ tier: "cgc_10_pristine", api_cents: null, fetchPage });
    expect(pageFetched).toBe(true); // only now did it consult the page
    expect(resolution.source).toBe("PRICECHARTING_PUBLIC_PAGE");
    expect(resolution.value_cents).toBe(4539);
    expect(page_snapshot?.identity_status).toBe("VERIFIED");
  });
});
