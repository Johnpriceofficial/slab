import { describe, it, expect } from "vitest";
import { marketCacheKey, MARKET_QUERY_VERSION } from "@/lib/market/adapters/cache-key";

const HASH = "cardhash123";
const BASE = { identityHash: HASH, tier: "grade_10", providers: ["pricecharting", "ebay_active"] };

describe("marketCacheKey — versioned, scoped cache descriptor", () => {
  it("shares PUBLIC evidence across users by identity", () => {
    const a = marketCacheKey({ ...BASE, scope: "public" });
    const b = marketCacheKey({ ...BASE, scope: "public" });
    expect(a).toBe(b); // two different users, same card → same public cache slot
    expect(a).not.toMatch(/owner=/); // public keys never carry an owner
  });

  it("is order-insensitive in the provider set", () => {
    const a = marketCacheKey({ ...BASE, providers: ["pricecharting", "ebay_active"], scope: "public" });
    const b = marketCacheKey({ ...BASE, providers: ["ebay_active", "pricecharting"], scope: "public" });
    expect(a).toBe(b);
  });

  it("scopes OWNER-PRIVATE evidence to the owner — two users cannot collide", () => {
    const userA = marketCacheKey({ ...BASE, scope: "owner-private", ownerId: "user-A" });
    const userB = marketCacheKey({ ...BASE, scope: "owner-private", ownerId: "user-B" });
    expect(userA).not.toBe(userB); // same card, different owners → different slots
    expect(userA).toMatch(/owner=user-A/);
    // A private key is also distinct from the public key for the same identity.
    expect(userA).not.toBe(marketCacheKey({ ...BASE, scope: "public" }));
  });

  it("REFUSES to build an owner-private key without an ownerId", () => {
    expect(() => marketCacheKey({ ...BASE, scope: "owner-private" })).toThrow(/ownerId/);
    expect(() => marketCacheKey({ ...BASE, scope: "owner-private", ownerId: "  " })).toThrow(/ownerId/);
  });

  it("changes when the schema/query version changes", () => {
    const v1 = marketCacheKey({ ...BASE, scope: "public", queryVersion: 1 });
    const vCurrent = marketCacheKey({ ...BASE, scope: "public" });
    expect(v1).not.toBe(vCurrent);
    expect(vCurrent).toMatch(new RegExp(`v=${MARKET_QUERY_VERSION}`));
  });

  it("distinguishes different target tiers of the same card", () => {
    const ten = marketCacheKey({ ...BASE, tier: "grade_10", scope: "public" });
    const raw = marketCacheKey({ ...BASE, tier: "raw", scope: "public" });
    expect(ten).not.toBe(raw);
  });
});
