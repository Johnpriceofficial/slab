import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

/**
 * Extract and verify the caller's Supabase JWT. Returns the user or null.
 */
export async function getCallerUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const client = createClient(SUPABASE_URL, ANON_KEY || SERVICE_KEY);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/**
 * Returns true if the caller's JWT belongs to an admin user.
 * Uses the existing public.is_admin(uuid) SECURITY DEFINER function via service role.
 */
export async function isCallerAdmin(req: Request): Promise<{ user: { id: string } | null; isAdmin: boolean }> {
  const user = await getCallerUser(req);
  if (!user) return { user: null, isAdmin: false };
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.rpc("is_admin", { _user_id: user.id });
  if (error) return { user, isAdmin: false };
  return { user, isAdmin: data === true };
}

export function unauthorizedResponse(corsHeaders: Record<string, string>, message = "Unauthorized") {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function forbiddenResponse(corsHeaders: Record<string, string>, message = "Forbidden") {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
