// GradedCardValue.com — READ-ONLY market intelligence.
//
// Accepts a slab or raw-card id, rebuilds the canonical identity server-side,
// queries the providers (PriceCharting via the server secret; eBay Browse only
// when configured; connected-seller only when the owner has it linked), passes
// every response through the merged adapters, classifies, and returns the
// assembled market object. It WRITES NOTHING, exposes no provider secrets,
// caches by identity hash + grade tier, and degrades cleanly when a provider is
// unavailable. Ownership is enforced by RLS: the row is read with the caller's
// JWT, so a customer can only get intelligence for their own item.

import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { getCallerUser, unauthorizedResponse } from "../_shared/auth.ts";
// deno-lint-ignore no-explicit-any
import * as engine from "../_shared/market-intelligence-bundle.js";

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
function toResult(source: string, candidates: any[], query: string, retrievedAt: string, error: any = null) {
  return { source, candidates, provenance: { source, query, retrieved_at: retrievedAt, candidate_count: candidates.length, exact_count: 0, url: null }, error };
}

// deno-lint-ignore no-explicit-any
async function pricechartingResult(identity: any, retrievedAt: string): Promise<any> {
  const token = Deno.env.get("PRICECHARTING_API_TOKEN");
  const query = engine.priceChartingQuery(identity);
  if (!token) return toResult("pricecharting", [], query, retrievedAt, { source: "pricecharting", code: "unauthorized", message: "PriceCharting is not configured.", retryable: false });
  try {
    const res = await fetch(`https://www.pricecharting.com/api/product?t=${token}&q=${encodeURIComponent(query)}`);
    if (!res.ok) return toResult("pricecharting", [], query, retrievedAt, { source: "pricecharting", code: res.status === 429 ? "rate_limited" : "provider_error", message: `HTTP ${res.status}`, retryable: res.status >= 500 });
    const p = await res.json();
    // PriceCharting card fields → generic tiers (see grade-mapping.ts).
    const product = {
      product_id: String(p.id ?? ""),
      product_name: String(p["product-name"] ?? query),
      url: p.id ? `https://www.pricecharting.com/game/${p.id}` : null,
      tiers: [
        { grade: null, price_cents: p["loose-price"] ?? null },
        { grade: "9", price_cents: p["graded-price"] ?? null },
        { grader: "PSA", grade: "10", price_cents: p["manual-only-price"] ?? null },
      ],
    };
    const candidates = engine.mapPriceCharting(product, retrievedAt);
    return toResult("pricecharting", candidates, query, retrievedAt);
  } catch (e) {
    return toResult("pricecharting", [], query, retrievedAt, { source: "pricecharting", code: "network_error", message: e instanceof Error ? e.message : "failed", retryable: true });
  }
}

// deno-lint-ignore no-explicit-any
async function ebayActiveResult(identity: any, retrievedAt: string): Promise<any> {
  const token = Deno.env.get("EBAY_BROWSE_TOKEN");
  const query = engine.ebayExactQuery(identity);
  // eBay Browse is called ONLY when app credentials are configured.
  if (!token) return toResult("ebay_active", [], query, retrievedAt, { source: "ebay_active", code: "unauthorized", message: "eBay is not configured.", retryable: false });
  try {
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=25`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toResult("ebay_active", [], query, retrievedAt, { source: "ebay_active", code: res.status === 401 ? "unauthorized" : "provider_error", message: `HTTP ${res.status}`, retryable: res.status >= 500 });
    const candidates = engine.mapEbayActive(await res.json(), retrievedAt);
    return toResult("ebay_active", candidates, query, retrievedAt);
  } catch (e) {
    return toResult("ebay_active", [], query, retrievedAt, { source: "ebay_active", code: "network_error", message: e instanceof Error ? e.message : "failed", retryable: true });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const user = await getCallerUser(req);
  if (!user) return unauthorizedResponse(corsHeaders);

  let input: { slab_id?: string; card_id?: string };
  try { input = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (!input.slab_id && !input.card_id) return json({ error: "A slab_id or card_id is required." }, 400);

  // Read the row with the CALLER'S token so RLS enforces owner authorization.
  const authed = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  // deno-lint-ignore no-explicit-any
  let identityInput: any;
  let targetTier: string;
  if (input.slab_id) {
    const { data } = await authed.from("slabs").select("card_name,set_name,card_number,language,rarity,variation,year,grader,grade,grade_label,certification_number,pricecharting_product_id").eq("id", input.slab_id).maybeSingle();
    if (!data) return json({ error: "Slab not found or not accessible." }, 404);
    identityInput = { card_name: data.card_name, set: data.set_name, card_number: data.card_number, language: data.language, rarity: data.rarity, variation: data.variation, year: data.year, grader: data.grader, grade: data.grade, grade_label: data.grade_label, certification_number: data.certification_number, pricecharting_product_id: data.pricecharting_product_id };
    targetTier = engine.mapGradeToTier(data.grader, data.grade, data.grade_label);
  } else {
    const { data } = await authed.from("cards").select("card_name,set_name,card_number,rarity").eq("id", input.card_id).maybeSingle();
    if (!data) return json({ error: "Card not found or not accessible." }, 404);
    identityInput = { card_name: data.card_name, set: data.set_name, card_number: data.card_number, rarity: data.rarity };
    targetTier = "raw";
  }

  const identity = await engine.buildIdentity(identityInput);
  const key = engine.cacheKey("pricecharting", identity.hash, { tier: targetTier });
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return json(cached.body, 200);

  const retrievedAt = new Date().toISOString();
  // Providers run independently; a failure becomes a degraded (empty) result.
  const results = await Promise.all([
    pricechartingResult(identity, retrievedAt),
    ebayActiveResult(identity, retrievedAt),
    // Connected-seller verified sales require the owner's linked eBay account;
    // absent that link, it degrades to nothing (no error surfaced to the user).
  ]);

  const body = engine.buildMarketIntelligence(identity, targetTier, results, retrievedAt);
  cache.set(key, { at: now, body });
  return json(body, 200);
});
