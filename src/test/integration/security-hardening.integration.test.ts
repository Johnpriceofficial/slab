/**
 * Security-hardening invariants (Phase 2), verified against the disposable
 * Supabase stack. The search_path pinning is self-validated by CI applying the
 * migration (a broken DO block fails `supabase db reset`); here we verify the
 * client-observable invariant: service-only tables deny BOTH anon and an
 * authenticated (non-admin) customer. Env-gated exactly like the other suites.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

// Client-reachable service-only tables (public schema; private.* are not exposed
// via PostgREST at all, so anon/authenticated can never even reference them).
const SERVICE_ONLY_PUBLIC = ["api_rate_limits", "api_daily_usage", "api_user_daily_usage"];

suite("security hardening — service-only tables deny all client access", () => {
  let admin: SupabaseClient;
  let anonClient: SupabaseClient;
  let userClient: SupabaseClient;
  const createdUserIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "sec-service" } });
    anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `sec-${stamp}@example.com`;
    const password = `Test-${email}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: {} });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    userClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `sec-${email}` } });
    const { error: signInErr } = await userClient.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
  });

  for (const table of SERVICE_ONLY_PUBLIC) {
    it(`denies an ANONYMOUS caller from reading ${table}`, async () => {
      const { data, error } = await anonClient.from(table).select("*").limit(1);
      // Either an explicit permission error, or no rows/no data — never leaks a row.
      expect(error !== null || (data?.length ?? 0) === 0).toBe(true);
    });

    it(`denies an AUTHENTICATED customer from reading ${table}`, async () => {
      const { data, error } = await userClient.from(table).select("*").limit(1);
      expect(error !== null || (data?.length ?? 0) === 0).toBe(true);
    });

    it(`denies an AUTHENTICATED customer from writing ${table}`, async () => {
      const { error } = await userClient.from(table).insert({ id: "00000000-0000-0000-0000-000000000000" } as never);
      expect(error).not.toBeNull(); // revoked INSERT / RLS deny
    });
  }

  it("a customer cannot alter their own usage counters directly", async () => {
    // Even if a counter row exists, the client has no UPDATE privilege on it.
    const { error } = await userClient.from("api_user_daily_usage").update({ count: 0 } as never).eq("user_id", createdUserIds[0] ?? "x");
    expect(error).not.toBeNull();
  });
});
