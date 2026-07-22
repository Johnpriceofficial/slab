import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260823000000_private_schema_enable_rls.sql against the
// disposable CI Supabase. With RLS ENABLED (and NO client policies) on
// private.slab_storage_cleanup_queue and private.ebay_publish_leases, prove that:
//   * the SECURITY DEFINER lease RPCs (owned by the service role, which BYPASSES
//     RLS) still acquire / fence / release;
//   * the SECURITY DEFINER storage-cleanup RPCs still work for an admin;
//   * neither private table is reachable through the Data API (service OR admin);
//   * anon/authenticated get NO access (RPCs denied).
// relrowsecurity=true itself is asserted by the migration-text test and verified
// post-deploy via the Supabase security advisor.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("private-schema RLS defense-in-depth (service bypass preserved, clients denied)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rls-svc-${stamp}` } });
    const email = `ebay-rls+${stamp}@slabvault.test`;
    const password = `Test-rls-${stamp}`;
    const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rls-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });
    const { data: acct } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-rls-${stamp}`, connection_status: "connected" }).select("id").single();
    accountId = acct!.id;
    accountIds.push(accountId);
  });

  afterAll(async () => {
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("service-role lease RPCs still acquire, fence, and release with RLS enabled", async () => {
    const sku = `GCV-RLS-${stamp}`;
    const acq = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok", p_ttl_seconds: 120 });
    expect((acq.data as { acquired?: boolean }).acquired).toBe(true);
    const held = await service.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: sku, p_token: "tok", p_ttl_seconds: 120 });
    expect((held.data as { held?: boolean }).held).toBe(true);
    const rel = await service.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: "tok" });
    expect((rel.data as { released?: boolean }).released).toBe(true);
  });

  it("neither private table is reachable through the Data API (service OR admin)", async () => {
    expect((await service.from("ebay_publish_leases").select("id").limit(1)).error).not.toBeNull();
    expect((await adminClient.from("ebay_publish_leases").select("id").limit(1)).error).not.toBeNull();
    expect((await service.from("slab_storage_cleanup_queue").select("storage_path").limit(1)).error).not.toBeNull();
    expect((await adminClient.from("slab_storage_cleanup_queue").select("storage_path").limit(1)).error).not.toBeNull();
  });

  it("the storage-cleanup SECURITY DEFINER RPC works for an admin, is denied to anon", async () => {
    // Admin can list (empty is fine) — the SECURITY DEFINER path reaches the RLS-on table.
    const listed = await adminClient.rpc("list_pending_slab_storage_cleanup");
    expect(listed.error).toBeNull();
    expect(Array.isArray(listed.data)).toBe(true);
    // Anon is denied the admin-only cleanup RPCs.
    const anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rls-anon-${stamp}` } });
    expect((await anonClient.rpc("list_pending_slab_storage_cleanup")).error).not.toBeNull();
  });

  it("anon/authenticated cannot call the lease RPCs at all", async () => {
    expect((await adminClient.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: "x", p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: "x", p_token: "x" })).error).not.toBeNull();
  });
});
