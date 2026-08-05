import { describe, it, expect } from "vitest";
import {
  classifySlabForBackfill,
  classifyRefreshOutcome,
  decodeJwtExpiry,
  estimateRunSeconds,
  isAuthFailureMessage,
  isFreshValuation,
  selectBackfillCandidates,
  type BackfillSlabFields,
  type BackfillSelectionOptions,
} from "@/lib/slabs/backfill-selection";

const NOW = "2026-08-04T12:00:00.000Z";
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

let seq = 0;
const slab = (over: Partial<BackfillSlabFields> = {}): BackfillSlabFields => {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    inventory_number: seq,
    archived_at: null,
    pricecharting_product_id: null,
    pricecharting_priced_at: null,
    valuation_status: null,
    ...over,
  };
};

const opts = (over: Partial<BackfillSelectionOptions> = {}): BackfillSelectionOptions => ({
  onlyUnlinked: false,
  onlyNeedsReview: false,
  maxAgeDays: 7,
  limit: 25,
  nowIso: NOW,
  ...over,
});

describe("isFreshValuation", () => {
  it("is never fresh without a timestamp (missing, null, or garbage)", () => {
    expect(isFreshValuation(null, NOW, 7)).toBe(false);
    expect(isFreshValuation(undefined, NOW, 7)).toBe(false);
    expect(isFreshValuation("not-a-date", NOW, 7)).toBe(false);
  });

  it("is fresh strictly inside the window and stale at/after the boundary", () => {
    expect(isFreshValuation(daysAgo(1), NOW, 7)).toBe(true);
    expect(isFreshValuation(daysAgo(7), NOW, 7)).toBe(false); // exactly 7 days → refresh again
    expect(isFreshValuation(daysAgo(30), NOW, 7)).toBe(false);
  });

  it("treats a future timestamp (clock skew) as fresh — the non-spending direction", () => {
    expect(isFreshValuation(daysAgo(-1), NOW, 7)).toBe(true);
  });
});

describe("classifySlabForBackfill", () => {
  it("processes an unlinked slab with 2 API calls (search + value)", () => {
    expect(classifySlabForBackfill(slab(), opts())).toEqual({ action: "process", api_calls: 2 });
  });

  it("processes a linked-but-stale slab with 1 API call (value only, never re-search)", () => {
    const s = slab({ pricecharting_product_id: "5427932", pricecharting_priced_at: daysAgo(30) });
    expect(classifySlabForBackfill(s, opts())).toEqual({ action: "process", api_calls: 1 });
  });

  it("processes a linked slab that has never been priced", () => {
    const s = slab({ pricecharting_product_id: "5427932", pricecharting_priced_at: null });
    expect(classifySlabForBackfill(s, opts())).toEqual({ action: "process", api_calls: 1 });
  });

  it("skips a linked slab with a fresh snapshot (the resume-safety rule)", () => {
    const s = slab({ pricecharting_product_id: "5427932", pricecharting_priced_at: daysAgo(1) });
    expect(classifySlabForBackfill(s, opts())).toEqual({ action: "skip", reason: "fresh_valuation" });
  });

  it("never processes an archived slab (defense in depth behind the query filter)", () => {
    const s = slab({ archived_at: daysAgo(2) });
    expect(classifySlabForBackfill(s, opts())).toEqual({ action: "skip", reason: "archived" });
  });

  it("--only-unlinked skips every linked slab, even a stale one", () => {
    const stale = slab({ pricecharting_product_id: "5427932", pricecharting_priced_at: daysAgo(30) });
    expect(classifySlabForBackfill(stale, opts({ onlyUnlinked: true }))).toEqual({
      action: "skip",
      reason: "not_unlinked",
    });
    expect(classifySlabForBackfill(slab(), opts({ onlyUnlinked: true }))).toEqual({
      action: "process",
      api_calls: 2,
    });
  });

  it("--only-needs-review keeps only valuation_status='needs_review'", () => {
    const needsReview = slab({ valuation_status: "needs_review" });
    const exact = slab({ valuation_status: "exact_api_tier" });
    expect(classifySlabForBackfill(needsReview, opts({ onlyNeedsReview: true })).action).toBe("process");
    expect(classifySlabForBackfill(exact, opts({ onlyNeedsReview: true }))).toEqual({
      action: "skip",
      reason: "not_needs_review",
    });
  });

  it("combined filters AND together", () => {
    const linkedNeedsReview = slab({
      pricecharting_product_id: "5427932",
      valuation_status: "needs_review",
    });
    const both = opts({ onlyUnlinked: true, onlyNeedsReview: true });
    expect(classifySlabForBackfill(linkedNeedsReview, both)).toEqual({
      action: "skip",
      reason: "not_unlinked",
    });
    expect(classifySlabForBackfill(slab({ valuation_status: "needs_review" }), both).action).toBe("process");
  });
});

describe("selectBackfillCandidates", () => {
  it("orders candidates by inventory_number regardless of input order", () => {
    const a = slab({ inventory_number: 30 });
    const b = slab({ inventory_number: 10 });
    const c = slab({ inventory_number: 20 });
    const sel = selectBackfillCandidates([a, b, c], opts());
    expect(sel.candidates.map((x) => x.slab.inventory_number)).toEqual([10, 20, 30]);
  });

  it("caps at limit; skips never consume the limit; the rest is deferred", () => {
    const fresh = slab({
      inventory_number: 1,
      pricecharting_product_id: "P1",
      pricecharting_priced_at: daysAgo(1),
    });
    const actionable = [2, 3, 4, 5].map((n) => slab({ inventory_number: n }));
    const sel = selectBackfillCandidates([fresh, ...actionable], opts({ limit: 2 }));
    expect(sel.candidates.map((x) => x.slab.inventory_number)).toEqual([2, 3]);
    expect(sel.skipped).toEqual([{ slab: fresh, reason: "fresh_valuation" }]);
    expect(sel.deferred).toBe(2);
    expect(sel.total_api_calls).toBe(4); // both candidates unlinked → 2 calls each
  });

  it("counts 1 API call for linked candidates and 2 for unlinked ones", () => {
    const linked = slab({
      inventory_number: 1,
      pricecharting_product_id: "P1",
      pricecharting_priced_at: daysAgo(30),
    });
    const unlinked = slab({ inventory_number: 2 });
    const sel = selectBackfillCandidates([linked, unlinked], opts());
    expect(sel.total_api_calls).toBe(3);
  });

  it("re-running after an interruption resumes where it stopped (refreshed slabs now skip)", () => {
    const rows = [1, 2, 3].map((n) => slab({ inventory_number: n, pricecharting_product_id: `P${n}` }));
    const first = selectBackfillCandidates(rows, opts({ limit: 2 }));
    expect(first.candidates.map((x) => x.slab.inventory_number)).toEqual([1, 2]);
    // A successful apply updates pricecharting_priced_at on the processed rows…
    const afterRun = rows.map((r) =>
      r.inventory_number <= 2 ? { ...r, pricecharting_priced_at: NOW } : r,
    );
    // …so the identical command now starts at the first untouched slab.
    const second = selectBackfillCandidates(afterRun, opts({ limit: 2 }));
    expect(second.candidates.map((x) => x.slab.inventory_number)).toEqual([3]);
  });
});

describe("classifyRefreshOutcome", () => {
  it("distinguishes a new auto-confirmed link from a plain re-valuation", () => {
    expect(classifyRefreshOutcome("applied", false)).toEqual({
      outcome: "linked",
      reason: "auto_confirmed_match",
    });
    expect(classifyRefreshOutcome("applied", true)).toEqual({ outcome: "valued", reason: null });
  });

  it("maps ambiguity to conflict and non-matches / stale writes to skips", () => {
    expect(classifyRefreshOutcome("needs_confirmation", false)).toEqual({
      outcome: "conflict",
      reason: "needs_confirmation",
    });
    expect(classifyRefreshOutcome("no_product", false)).toEqual({ outcome: "skipped", reason: "no_match" });
    expect(classifyRefreshOutcome("stale", true)).toEqual({ outcome: "skipped", reason: "stale_write" });
    expect(classifyRefreshOutcome("error", true).outcome).toBe("error");
  });
});

describe("isAuthFailureMessage", () => {
  it.each([
    "401 Unauthorized",
    "HTTP 403",
    "NOT_AUTHORIZED: admin required",
    "Admin access required",
    "Invalid JWT",
    "jwt expired",
    "token is expired",
    "permission denied for table slabs",
  ])("stops the run on %j", (msg) => {
    expect(isAuthFailureMessage(msg)).toBe(true);
  });

  it.each([
    "network timeout",
    "fetch failed",
    "PRODUCT_NOT_FOUND",
    "Edge Function returned a non-2xx status code",
    "",
    null,
  ])("fails soft on %j", (msg) => {
    expect(isAuthFailureMessage(msg)).toBe(false);
  });
});

describe("decodeJwtExpiry", () => {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("reads exp from an unverified JWT payload", () => {
    const token = [b64url({ alg: "HS256" }), b64url({ exp: 1_790_000_000 }), "sig"].join(".");
    expect(decodeJwtExpiry(token)).toBe(1_790_000_000);
  });

  it("returns null for garbage or a payload without a numeric exp", () => {
    expect(decodeJwtExpiry("not-a-jwt")).toBeNull();
    expect(decodeJwtExpiry("")).toBeNull();
    const noExp = [b64url({ alg: "HS256" }), b64url({ sub: "u" }), "sig"].join(".");
    expect(decodeJwtExpiry(noExp)).toBeNull();
    const badExp = [b64url({ alg: "HS256" }), b64url({ exp: "soon" }), "sig"].join(".");
    expect(decodeJwtExpiry(badExp)).toBeNull();
  });
});

describe("estimateRunSeconds", () => {
  it("budgets ~1.2s per API call plus fixed overhead", () => {
    expect(estimateRunSeconds(0)).toBe(30);
    expect(estimateRunSeconds(100)).toBe(150);
  });
});
