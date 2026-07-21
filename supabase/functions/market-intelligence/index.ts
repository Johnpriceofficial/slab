// GradedCardValue.com — READ-ONLY market intelligence.
import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { getCallerUser, unauthorizedResponse } from "../_shared/auth.ts";
import { ebayApiBase, ebayBrowseConfigured, getEbayAppToken } from "../_shared/ebay-app-token.ts";
// deno-lint-ignore no-explicit-any
import * as engine from "../_shared/market-intelligence-bundle.js";

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 250;
const cache = new Map<string, { at: number; body: MarketIntelligenceBody }>();

type MarketIntelligenceBody = {
  identity_hash: string;
  grade_tier: string;
  verified_sales: unknown[];
  active_listings: unknown[];
  grade_tiers: unknown[];
  summary: { count: number } & Record<string, unknown>;
  provenance: unknown[];
  generated_at: string;
} & Record<string, unknown>;

function json(body: unknown, status: number, requestId?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
  });
}

function logEvent(level: "info" | "error", event: Record<string, unknown>) {
  const payload = JSON.stringify({ function: "market-intelligence", function_version: "6", ...event });
  level === "error" ? console.error(payload) : console.log(payload);
}

function isMarketIntelligenceBody(value: unknown): value is MarketIntelligenceBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const summary = body.summary;
  return typeof body.identity_hash === "string"
    && typeof body.grade_tier === "string"
    && Array.isArray(body.verified_sales)
    && Array.isArray(body.active_listings)
    && Array.isArray(body.grade_tiers)
    && Array.isArray(body.provenance)
    && typeof body.generated_at === "string"
    && !!summary
    && typeof summary === "object"
    && !Array.isArray(summary)
    && typeof (summary as Record<string, unknown>).count === "number";
}

function pruneCache(now: number) {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

// deno-lint-ignore no-explicit-any
function toResult(source: string, candidates: any[], query: string, retrievedAt: string, error: any = null) {
  return { source, candidates, provenance: { source, query, retrieved_at: retrievedAt, candidate_count: candidates.length, exact_count: 0, url: null }, error };
}

// deno-lint-ignore no-explicit-any
function err(source: string, code: string, message: string, retryable: boolean): any {
  return { source, code, message, retryable };
}

// deno-lint-ignore no-explicit-any
async function pricechartingResult(identity: any, retrievedAt: string): Promise<any> {
  const token = Deno.env.get("PRICECHARTING_API_TOKEN");
  const query = engine.priceChartingQuery(identity);
  if (!token) return toResult("pricecharting", [], query, retrievedAt, err("pricecharting", "not_configured", "PriceCharting is not configured.", false));
  try {
    const res = await fetch(`https://www.pricecharting.com/api/product?t=${token}&q=${encodeURIComponent(query)}`);
    if (!res.ok) return toResult("pricecharting", [], query, retrievedAt, err("pricecharting", res.status === 429 ? "rate_limited" : "provider_error", `HTTP ${res.status}`, res.status === 429 || res.status >= 500));
    const p = await res.json();
    const product = { product_id: String(p.id ?? ""), product_name: String(p["product-name"] ?? query), url: p.id ? `https://www.pricecharting.com/game/${p.id}` : null, tiers: engine.priceChartingCardTiers(p) };
    return toResult("pricecharting", engine.mapPriceCharting(product, retrievedAt), query, retrievedAt);
  } catch {
    return toResult("pricecharting", [], query, retrievedAt, err("pricecharting", "network_error", "Request failed.", true));
  }
}

// deno-lint-ignore no-explicit-any
async function ebayActiveResult(identity: any, retrievedAt: string): Promise<any> {
  const query = engine.ebayExactQuery(identity);
  if (!ebayBrowseConfigured()) return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", "not_configured", "eBay is not configured.", false));
  try {
    const token = await getEbayAppToken();
    const res = await fetch(`${ebayApiBase()}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=25`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 429 ? "rate_limited" : "provider_error", `HTTP ${res.status}`, res.status === 429 || res.status >= 500));
    return toResult("ebay_active", engine.mapEbayActive(await res.json(), retrievedAt), query, retrievedAt);
  } catch {
    return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", "network_error", "Request failed.", true));
  }
}

// deno-lint-ignore no-explicit-any
function connectedSellerResult(identity: any, retrievedAt: string): any {
  return toResult("ebay_sold", [], engine.ebayExactQuery(identity), retrievedAt, err("ebay_sold", "not_configured", "Connected-seller verified sales are not available.", false));
}

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  let stage = "request";
  let itemType: "slab" | "card" | null = null;
  let itemId: string | null = null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    stage = "authentication";
    const user = await getCallerUser(req);
    if (!user) return unauthorizedResponse(corsHeaders);

    stage = "request_body";
    let input: { slab_id?: string; card_id?: string };
    try { input = await req.json(); } catch { return json({ error: "Invalid request body.", request_id: requestId }, 400, requestId); }
    if (!input.slab_id && !input.card_id) return json({ error: "A slab_id or card_id is required.", request_id: requestId }, 400, requestId);
    itemType = input.slab_id ? "slab" : "card";
    itemId = input.slab_id ?? input.card_id ?? null;

    stage = "database_read";
    const authed = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    // deno-lint-ignore no-explicit-any
    let identityInput: any;
    let targetTier: string;
    if (input.slab_id) {
      const { data, error } = await authed.from("slabs").select("card_name,set_name,card_number,language,rarity,variation,year,grader,grade,grade_label,certification_number,pricecharting_product_id").eq("id", input.slab_id).maybeSingle();
      if (error) throw new Error("slab_query_failed");
      if (!data) return json({ error: "Slab not found or not accessible.", request_id: requestId }, 404, requestId);
      identityInput = { card_name: data.card_name, set: data.set_name, card_number: data.card_number, language: data.language, rarity: data.rarity, variation: data.variation, year: data.year, grader: data.grader, grade: data.grade, grade_label: data.grade_label, certification_number: data.certification_number, pricecharting_product_id: data.pricecharting_product_id };
      targetTier = engine.mapGradeToTier(data.grader, data.grade, data.grade_label);
    } else {
      const { data, error } = await authed.from("cards").select("card_name,set_name,card_number,rarity").eq("id", input.card_id).maybeSingle();
      if (error) throw new Error("card_query_failed");
      if (!data) return json({ error: "Card not found or not accessible.", request_id: requestId }, 404, requestId);
      identityInput = { card_name: data.card_name, set: data.set_name, card_number: data.card_number, rarity: data.rarity };
      targetTier = "raw";
    }

    stage = "identity_build";
    const identity = await engine.buildIdentity(identityInput);
    const key = engine.marketCacheKey({ identityHash: identity.hash, tier: targetTier, providers: ["pricecharting", "ebay_active"], scope: "public" });
    const now = Date.now();
    pruneCache(now);
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS) return json(cached.body, 200, requestId);

    stage = "provider_requests";
    const retrievedAt = new Date().toISOString();
    const results = await Promise.all([pricechartingResult(identity, retrievedAt), ebayActiveResult(identity, retrievedAt), Promise.resolve(connectedSellerResult(identity, retrievedAt))]);

    stage = "response_assembly";
    const body = engine.buildMarketIntelligence(identity, targetTier, results, retrievedAt);
    stage = "response_validation";
    if (!isMarketIntelligenceBody(body)) {
      logEvent("error", { request_id: requestId, stage, item_type: itemType, item_id: itemId, error_class: "SchemaValidationError", error_message: "Assembled response failed schema validation." });
      return json({ error: "Market intelligence response was invalid.", code: "invalid_response", request_id: requestId }, 502, requestId);
    }

    cache.set(key, { at: now, body });
    logEvent("info", { request_id: requestId, stage: "complete", item_type: itemType, item_id: itemId, response_schema_valid: true });
    return json(body, 200, requestId);
  } catch (error) {
    logEvent("error", { request_id: requestId, stage, item_type: itemType, item_id: itemId, error_class: error instanceof Error ? error.name : "UnknownError", error_message: error instanceof Error ? error.message : "Unknown failure", response_schema_valid: false });
    return json({ error: "Market intelligence is temporarily unavailable.", code: "internal_error", request_id: requestId }, 500, requestId);
  }
});
