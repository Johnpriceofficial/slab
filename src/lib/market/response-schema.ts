import type { MarketIntelligence, SourceState, SourceStatus } from "@/server/market-intelligence/engine";
import type { MarketDataPoint, MarketSource, MarketSummary } from "./types";
import type { GradeTier } from "./grade-tier";
import type { CompletenessNote, CompletenessStatus } from "@/lib/identity/completeness";
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

const MARKET_SOURCES = new Set<MarketSource>(["pricecharting", "ebay_sold", "ebay_active", "population", "manual"]);
const SOURCE_STATUSES = new Set<SourceStatus>([
  "success",
  "no_results",
  "not_configured",
  "unauthorized",
  "rate_limited",
  "provider_error",
  "network_error",
]);
const COMPLETENESS_STATUSES = new Set<CompletenessStatus>(["complete", "partial", "ambiguous"]);

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

function marketSource(value: unknown): MarketSource {
  return typeof value === "string" && MARKET_SOURCES.has(value as MarketSource)
    ? (value as MarketSource)
    : "manual";
}

function sourceStatus(value: unknown): SourceStatus {
  return typeof value === "string" && SOURCE_STATUSES.has(value as SourceStatus)
    ? (value as SourceStatus)
    : "provider_error";
}

function marketPoint(value: Record<string, unknown>): MarketDataPoint | null {
  const price = nullableMoney(value.price_cents);
  if (price === null || price <= 0) return null;
  return {
    source: marketSource(value.source),
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

function sourceState(value: Record<string, unknown>): SourceState | null {
  if (typeof value.source !== "string") return null;
  return {
    source: marketSource(value.source),
    status: sourceStatus(value.status),
    query: stringValue(value.query),
    retrieved_at: stringValue(value.retrieved_at, new Date(0).toISOString()),
    candidate_count: Math.max(0, Math.round(finiteNumber(value.candidate_count, 0))),
    exact_count: Math.max(0, Math.round(finiteNumber(value.exact_count, 0))),
    retryable: value.retryable === true,
    message: stringValue(value.message, "Provider returned an invalid response."),
  };
}

function completenessNotes(value: unknown): CompletenessNote[] {
  return records(value).flatMap((note) => {
    const effect = note.effect;
    if (typeof note.field !== "string" || typeof note.detail !== "string") return [];
    if (effect !== "blocks_all" && effect !== "blocks_exact" && effect !== "downgrades_exact" && effect !== "irrelevant") return [];
    return [{ field: note.field, effect, detail: note.detail }];
  });
}

export function normalizeMarketIntelligenceResponse(payload: unknown): MarketIntelligence {
  const body = isRecord(payload) ? payload : {};
  const summaryBody = isRecord(body.summary) ? body.summary : {};
  const summary: MarketSummary = {
    count: Math.max(0, Math.round(finiteNumber(summaryBody.count, 0))),
    last_sale_cents: nullableMoney(summaryBody.last_sale_cents),
    last_sale_at: typeof summaryBody.last_sale_at === "string" ? summaryBody.last_sale_at : null,
    highest_cents: nullableMoney(summaryBody.highest_cents),
    lowest_cents: nullableMoney(summaryBody.lowest_cents),
    median_cents: nullableMoney(summaryBody.median_cents),
    average_cents: nullableMoney(summaryBody.average_cents),
  };
  const completeness = isRecord(body.identity_completeness) ? body.identity_completeness : {};
  const completenessStatus =
    typeof completeness.status === "string" && COMPLETENESS_STATUSES.has(completeness.status as CompletenessStatus)
      ? (completeness.status as CompletenessStatus)
      : "ambiguous";

  return {
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
      source: marketSource(row.source),
      query: stringValue(row.query),
      retrieved_at: stringValue(row.retrieved_at, new Date(0).toISOString()),
      candidate_count: Math.max(0, Math.round(finiteNumber(row.candidate_count, 0))),
      exact_count: Math.max(0, Math.round(finiteNumber(row.exact_count, 0))),
      url: typeof row.url === "string" ? row.url : null,
    })),
    sources: records(body.sources).map(sourceState).filter((value): value is SourceState => value !== null),
    identity_completeness: {
      status: completenessStatus,
      missing: Array.isArray(completeness.missing)
        ? completeness.missing.filter((value): value is string => typeof value === "string")
        : [],
      notes: completenessNotes(completeness.notes),
    },
    generated_at: stringValue(body.generated_at, new Date().toISOString()),
  };
}
