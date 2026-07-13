import { createClient } from "npm:@supabase/supabase-js@2.110.2";

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

/**
 * Consume a per-user allowance for public customer traffic. Unlike the legacy
 * admin quota, this fails CLOSED when the database counter is unavailable so a
 * provider outage cannot turn into unbounded OpenAI spend.
 */
export async function consumeUserDailyQuota(userId: string, bucket: string, hardLimit: number): Promise<boolean> {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await admin.rpc("consume_user_daily_quota", {
      p_user_id: userId,
      p_bucket: bucket,
      p_hard_limit: hardLimit,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
