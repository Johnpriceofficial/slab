// Supabase Edge Function: pricecharting-search
//
// The ONLY place PRICECHARTING_API_TOKEN is read. The browser never calls
// PriceCharting directly and never sees the token. Admin-only. All PriceCharting
// access goes through the bundled server-side handler, which uses the completed
// src/lib/pricecharting library (rate limiter, retries, error normalization).
//
// Regenerate the bundle after changing the handler/library:
//   node scripts/build-pricecharting-edge-bundle.mjs

import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "../_shared/auth.ts";
import { makePriceChartingReserver } from "../_shared/rate-limit.ts";
// deno-lint-ignore no-explicit-any
import { handlePriceChartingRequest, getProductPageSnapshot } from "../_shared/pricecharting-bundle.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error_code: "INVALID_PARAMETER", message: "POST required" }, 405);

  // Admin-only. This inventory tool is not exposed to storefront customers.
  const { user, isAdmin } = await isCallerAdmin(req);
  if (!user) return unauthorizedResponse(corsHeaders);
  if (!isAdmin) return json({ status: "error", error_code: "NOT_AUTHORIZED", message: "Admin access required" }, 403);

  // The token lives ONLY in the function environment. Never logged or returned.
  const token = Deno.env.get("PRICECHARTING_API_TOKEN");
  if (!token) {
    // Do not reveal configuration specifics to the client.
    return json({ status: "error", error_code: "SUBSCRIPTION_REQUIRED", message: "PriceCharting is not configured." }, 502);
  }

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ status: "error", error_code: "INVALID_PARAMETER", message: "Invalid JSON body." }, 400);
  }

  try {
    // Durable, DB-backed 1 req/sec reservation across all isolates + retries.
    const reserve = makePriceChartingReserver();

    // The public-page adapter is DISABLED BY DEFAULT and explicitly operator-
    // controlled: it is injected ONLY when PRICECHARTING_PAGE_ADAPTER_ENABLED is
    // exactly "true". Enabling it in production is gated behind the PriceCharting
    // Terms / production-request-policy review — it never defaults on. When on, the
    // page is fetched server-side for every confirmed graded product to supply the
    // full grade table + reference artwork, reusing the same ≤1 req/s reserver; it
    // never returns raw HTML. Anything other than "true" ⇒ API-only.
    const pageEnabled = (Deno.env.get("PRICECHARTING_PAGE_ADAPTER_ENABLED") ?? "").trim().toLowerCase() === "true";
    // deno-lint-ignore no-explicit-any
    const fetchPageSnapshot = pageEnabled
      ? (pageInput: any) =>
          getProductPageSnapshot(pageInput, {
            // deno-lint-ignore no-explicit-any
            fetch: (u: string, init: any) => fetch(u, init),
            beforeRequest: () => reserve("pricecharting-page"),
            now: () => new Date().toISOString(),
            getEnv: (name: string) => Deno.env.get(name),
          })
      : undefined;

    const result = await handlePriceChartingRequest(input, {
      tokenProvider: () => token,
      beforeRequest: reserve,
      fetchPageSnapshot,
    });
    // result.body never contains the token (guaranteed by the handler/library).
    return json(result.body, result.statusCode);
  } catch (_err) {
    // Never leak internals (which could include the token in a raw error/url).
    return json({ status: "error", error_code: "UNKNOWN_API_ERROR", message: "Unexpected error." }, 500);
  }
});
