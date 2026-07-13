import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!serviceKey || bearer !== serviceKey) return new Response(JSON.stringify({ status: "error", message: "Service authorization required." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/pricecharting-marketplace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sync_all" }),
  });
  return new Response(await response.text(), { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
