import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const { user, isAdmin } = await isCallerAdmin(req);
  if (!user) return unauthorizedResponse(corsHeaders);
  if (!isAdmin) return new Response(JSON.stringify({ status: "error", message: "Admin access required." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pricecharting-marketplace`, {
    method: "POST",
    headers: {
      Authorization: req.headers.get("Authorization")!,
      apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "sync_all" }),
  });
  return new Response(await response.text(), { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
