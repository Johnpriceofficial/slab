import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "../_shared/auth.ts";
import { makePriceChartingReserver } from "../_shared/rate-limit.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.2";
// deno-lint-ignore no-explicit-any
import { handleMarketplaceRequest } from "../_shared/pricecharting-marketplace-bundle.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error_code: "INVALID_PARAMETER", message: "POST required" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const isServiceRequest = serviceKey.length > 0 && bearer === serviceKey;
  const { user, isAdmin } = isServiceRequest ? { user: null, isAdmin: true } : await isCallerAdmin(req);
  if (!isServiceRequest && !user) return unauthorizedResponse(corsHeaders);
  if (!isAdmin) return json({ status: "error", error_code: "NOT_AUTHORIZED", message: "Admin access required" }, 403);

  const token = Deno.env.get("PRICECHARTING_API_TOKEN");
  if (!token) return json({ status: "error", error_code: "SUBSCRIPTION_REQUIRED", message: "PriceCharting is not configured." }, 502);

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ status: "error", error_code: "INVALID_PARAMETER", message: "Invalid JSON body." }, 400);
  }

  try {
    if ((input as { action?: string }).action === "sync_all") {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
      const { data: run, error: runError } = await admin
        .from("pricecharting_sync_runs")
        .insert({ trigger_kind: isServiceRequest ? "scheduled" : "manual", status: "running", created_by: user?.id ?? null })
        .select("id")
        .single();
      if (runError) return json({ status: "error", error_code: "SYNC_FAILED", message: "Could not start marketplace sync." }, 500);

      const { data: offers, error: offersError } = await admin
        .from("pricecharting_offers")
        .select("slab_id,offer_id")
        .neq("offer_status", "refunded")
        .order("last_synced_at", { ascending: true })
        .limit(100);
      if (offersError) {
        await admin.from("pricecharting_sync_runs").update({ status: "failed", error_message: "Could not load offers.", finished_at: new Date().toISOString() }).eq("id", run.id);
        return json({ status: "error", error_code: "SYNC_FAILED", message: "Could not load marketplace offers." }, 500);
      }

      let updated = 0;
      let failed = 0;
      const reserver = makePriceChartingReserver();
      for (const offer of offers ?? []) {
        const result = await handleMarketplaceRequest(
          { action: "details", offer_id: offer.offer_id },
          { tokenProvider: () => token, beforeRequest: reserver },
        );
        if (result.statusCode !== 200 || result.body.status !== "success" || !result.body.snapshot) {
          failed += 1;
          continue;
        }
        const { error: applyError } = await admin.rpc("apply_pricecharting_offer_snapshot", {
          p_slab_id: offer.slab_id,
          p_snapshot: result.body.snapshot,
          p_event_type: "synced",
        });
        if (applyError) failed += 1;
        else updated += 1;
      }

      const status = failed === 0 ? "success" : updated > 0 ? "partial" : "failed";
      await admin.from("pricecharting_sync_runs").update({
        status,
        offers_seen: offers?.length ?? 0,
        offers_updated: updated,
        error_message: failed > 0 ? `${failed} offer(s) could not be synchronized.` : null,
        finished_at: new Date().toISOString(),
      }).eq("id", run.id);
      await admin.from("pricecharting_marketplace_settings").update({ last_synced_at: new Date().toISOString() }).eq("singleton", true);
      return json({ status: "success", action: "sync_all", offers_seen: offers?.length ?? 0, offers_updated: updated, failed }, 200);
    }

    if (isServiceRequest) return json({ status: "error", error_code: "NOT_AUTHORIZED", message: "Service requests may only synchronize offers." }, 403);
    const result = await handleMarketplaceRequest(input, {
      tokenProvider: () => token,
      beforeRequest: makePriceChartingReserver(),
    });
    return json(result.body, result.statusCode);
  } catch {
    return json({ status: "error", error_code: "UNKNOWN_API_ERROR", message: "Unexpected marketplace error." }, 500);
  }
});
