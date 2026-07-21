import type { MarketIntelligence } from "@/server/market-intelligence/engine";
import type { MarketDataPoint, MarketSummary } from "./types";
import type { GradeTier } from "./grade-tier";
import { isRecord } from "@/lib/providers/response-schema";

const EMPTY_SUMMARY: MarketSummary = {
  count: 0,
  last_sale_cents: null,
  last_sale_at: null,
  highest_cents: null,
  lowest_cents: null,
  median_cents: null,
  average_cents: null,
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function marketPoint(value: Record<string, unknown>): MarketDataPoint | null {
  const price = nullableMoney(value.price_cents);
  if (price === null || price <= 0) return null;
  return {
    source: stringValue(value.source, "manual") as MarketDataPoint["source"],
    kind: value.kind === "listing" ? "listing" : "sale",
    price_cents: price,
    currency: stringValue(value.currency, "USD"),
    observed_at: stringValue(value.observed_at, new Date(0).toISOString()),
    sold_at: typeof value.sold_at === "string" ? value.sold_at : null,
    grade_tier: stringValue(value.grade_tier, "raw") as GradeTier,
    match: value.match === "compatible" || value.match === "rejected" ? value.match : "exact",
    url: typeof value.url === "string" ? value.url : null,
    title: typeof value.title === "string" ? value.title : null,
  };
}

export function normalizeMarketIntelligenceResponse(payload: unknown): MarketIntelligence {
  const body = isRecord(payload) ? payload : {};
  const summaryBody = isRecord(body.summary) ? body.summary : {};
  const completeness = isRecord(body.identity_completeness) ? body.identity_completeness : {};
  const summary: MarketSummary = {
    count: Math.max(0, Math.round(finiteNumber(summaryBody.count, 0))),
    last_sale_cents: nullableMoney(summaryBody.last_sale_cents),
    last_sale_at: typeof summaryBody.last_sale_at === "string" ? summaryBody.last_sale_at : null,
    highest_cents: nullableMoney(summaryBody.highest_cents),
    lowest_cents: nullableMoney(summaryBody.lowest_cents),
    median_cents: nullableMoney(summaryBody.median_cents),
    average_cents: nullableMoney(summaryBody.average_cents),
  };

  const normalized = {
    identity_hash: stringValue(body.identity_hash, "unavailable"),
    grade_tier: stringValue(body.grade_tier, "raw") as GradeTier,
    verified_sales: records(body.verified_sales).map(marketPoint).filter((value): value is MarketDataPoint => value !== null),
    active_listings: records(body.active_listings).map(marketPoint).filter((value): value is MarketDataPoint => value !== null),
    grade_tiers: records(body.grade_tiers).flatMap((tier) => {
      const value = nullableMoney(tier.value_cents);
      return value === null
        ? []
        : [{
            tier: stringValue(tier.tier, "raw") as GradeTier,
            label: stringValue(tier.label, "Unknown tier"),
            value_cents: value,
            source: "pricecharting" as const,
          }];
    }),
    summary: isRecord(body.summary) ? summary : EMPTY_SUMMARY,
    last_sold_cents: nullableMoney(body.last_sold_cents),
    median_sold_cents: nullableMoney(body.median_sold_cents),
    low_sold_cents: nullableMoney(body.low_sold_cents),
    high_sold_cents: nullableMoney(body.high_sold_cents),
    lowest_active_cents: nullableMoney(body.lowest_active_cents),
    liquidity: Math.max(0, Math.min(1, finiteNumber(body.liquidity, 0))),
    confidence: Math.max(0, Math.min(1, finiteNumber(body.confidence, 0))),
    provenance: records(body.provenance).map((row) => ({
      source: stringValue(row.source, "manual"),
      query: stringValue(row.query),
      retrieved_at: stringValue(row.retrieved_at, new Date(0).toISOString()),
      candidate_count: Math.max(0, Math.round(finiteNumber(row.candidate_count, 0))),
      exact_count: Math.max(0, Math.round(finiteNumber(row.exact_count, 0))),
      url: typeof row.url === "string" ? row.url : null,
    })),
    sources: records(body.sources).flatMap((row) => {
      if (typeof row.source !== "string") return [];
      return [{
        source: row.source,
        status: stringValue(row.status, "provider_error"),
        query: stringValue(row.query),
        retrieved_at: stringValue(row.retrieved_at, new Date(0).toISOString()),
        candidate_count: Math.max(0, Math.round(finiteNumber(row.candidate_count, 0))),
        exact_count: Math.max(0, Math.round(finiteNumber(row.exact_count, 0))),
        retryable: row.retryable === true,
        message: stringValue(row.message, "Provider returned an invalid response."),
      }];
    }),
    identity_completeness: {
      status: completeness.status === "complete" || completeness.status === "partial" || completeness.status === "ambiguous"
        ? completeness.status
        : "ambiguous",
      missing: Array.isArray(completeness.missing)
        ? completeness.missing.filter((value): value is string => typeof value === "string")
        : [],
      notes: records(completeness.notes).flatMap((note) => {
        if (typeof note.field !== "string" || typeof note.detail !== "string") return [];
        const effect = note.effect;
        if (effect !== "blocks_all" && effect !== "blocks_exact" && effect !== "downgrades_exact" && effect !== "irrelevant") return [];
        return [{ field: note.field, effect, detail: note.detail }];
      }),
    },
    generated_at: stringValue(body.generated_at, new Date().toISOString()),
  };

  return normalized as MarketIntelligence;
}
