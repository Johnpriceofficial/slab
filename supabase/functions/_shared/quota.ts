import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Consume one unit of a durable, global per-day quota (enforced in the DB across
 * all isolates). Returns true if allowed (and increments), false if the daily
 * limit is already reached.
 *
 * Fails OPEN on a DB error: a transient counter hiccup should not block a
 * legitimate operator. The quota is a spend ceiling, not a hard external limit.
 */
export async function consumeDailyQuota(bucket: string, limit: number): Promise<boolean> {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await admin.rpc("consume_daily_quota", { p_bucket: bucket, p_limit: limit });
    if (error) return true;
    return data === true;
  } catch {
    return true;
  }
}
