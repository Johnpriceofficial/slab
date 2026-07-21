// GradedCardValue.com — READ-ONLY market intelligence.
//
// Accepts a slab or raw-card id, rebuilds the canonical identity server-side,
// queries the providers, passes every response through the merged adapters,
// classifies, and returns the assembled market object. It WRITES NOTHING,
// exposes no provider secrets, caches by a versioned/scoped descriptor, and
// degrades cleanly — every provider reports an explicit status so a failure is
// never rendered as "no market activity". Ownership is enforced by RLS: the row
// is read with the caller's JWT, so a customer only ever gets intelligence for
// their own item.
//
// Provider truth in this build:
//   - PriceCharting: aggregate grade-tier reference (ALL supported card tiers).
//   - eBay active:   public asking prices via a server-side application token
//                    (client_credentials); `not_configured` when creds absent.
//   - Connected-seller verified sales: NOT wired yet — reported honestly as
//     `not_configured`, never a fake empty success.

import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { getCallerUser, unauthorizedResponse } from "../_shared/auth.ts";
import { ebayApiBase, ebayBrowseConfigured, getEbayAppToken } from "../_shared/ebay-app-token.ts";
// deno-lint-ignore no-explicit-any
import * as engine from "../_shared/market-intelligence-bundle.js";

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
function toResult(source: string, candidates: any[], query: string, retrievedAt: string, error: any = null) {
  return {
    source,
    candidates,
    provenance: { source, query, retrieved_at: retrievedAt, candidate_count: candidates.length, exact_count: 0, url: null },
    error,
  };
}

// deno-lint-ignore no-explicit-any
function err(source: string, code: string, message: string, retryable: boolean): any {
  // A SAFE error: code + a short message only. Never a token, URL, or raw
  // provider body. The engine re-derives the user-facing message from the code.
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
    // ONE authoritative field→tier map: every supported card tier, not just 3.
    // `p` carries the raw hyphenated price fields (loose-price, graded-price,
    // manual-only-price, box-only-price, cib-price, new-price, bgs-10-price,
    // condition-17-price, condition-18-price). Absent fields stay null (dropped).
    const product = {
      product_id: String(p.id ?? ""),
      product_name: String(p["product-name"] ?? query),
      url: p.id ? `https://www.pricecharting.com/game/${p.id}` : null,
      tiers: engine.priceChartingCardTiers(p),
    };
    return toResult("pricecharting", engine.mapPriceCharting(product, retrievedAt), query, retrievedAt);
  } catch {
    // Never surface the raw error (a network error message can embed the URL+token).
    return toResult("pricecharting", [], query, retrievedAt, err("pricecharting", "network_error", "Request failed.", true));
  }
}

// deno-lint-ignore no-explicit-any
async function ebayActiveResult(identity: any, retrievedAt: string): Promise<any> {
  const query = engine.ebayExactQuery(identity);
  // Durable auth: a fresh application token from the client_credentials grant —
  // NOT a hand-pasted static token. Disabled (typed not_configured) when the
  // server-side eBay app credentials are absent; never faked.
  if (!ebayBrowseConfigured()) return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", "not_configured", "eBay is not configured.", false));
  try {
    const token = await getEbayAppToken();
    const url = `${ebayApiBase()}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=25`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 429 ? "rate_limited" : "provider_error", `HTTP ${res.status}`, res.status === 429 || res.status >= 500));
    return toResult("ebay_active", engine.mapEbayActive(await res.json(), retrievedAt), query, retrievedAt);
  } catch {
    return toResult("ebay_active", [], query, retrievedAt, err("ebay_active", "network_error", "Request failed.", true));
  }
}

// Connected-seller verified sales require the owner's linked eBay account and
// the completed-order adapter, which are HELD work (seller operations). Until
// wired, report the source HONESTLY as not_configured — never a fake empty
// success that reads like "zero sales".
// deno-lint-ignore no-explicit-any
function connectedSellerResult(identity: any, retrievedAt: string): any {
  const query = engine.ebayExactQuery(identity);
  return toResult("ebay_sold", [], query, retrievedAt, err("ebay_sold", "not_configured", "Connected-seller verified sales are not available.", false));
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

  // A versioned, scoped cache descriptor. This response contains ONLY public
  // evidence (PriceCharting aggregates + public eBay active listings), so it is
  // shared across users BY IDENTITY under the "public" scope. Connected-seller
  // (owner-private) data is not wired here; the day it is, the scope must become
  // "owner-private" with the owner id — `marketCacheKey` throws otherwise, so
  // private seller data can never leak across users through cache reuse.
  const key = engine.marketCacheKey({
    identityHash: identity.hash,
    tier: targetTier,
    providers: ["pricecharting", "ebay_active"],
    scope: "public",
  });
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return json(cached.body, 200);

  const retrievedAt = new Date().toISOString();
  // Providers run independently; each yields an explicit success/degraded state.
  const results = await Promise.all([
    pricechartingResult(identity, retrievedAt),
    ebayActiveResult(identity, retrievedAt),
    Promise.resolve(connectedSellerResult(identity, retrievedAt)),
  ]);

  const body = engine.buildMarketIntelligence(identity, targetTier, results, retrievedAt);
  cache.set(key, { at: now, body });
  return json(body, 200);
});
