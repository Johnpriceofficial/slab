import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260820000000_ebay_publish_lease_private.sql against the
// disposable CI Supabase: the per-(account, SKU) publish lease lives in the PRIVATE
// (deny-all) schema, only one concurrent acquire wins, fencing (assert-and-extend)
// is token-scoped, and release is token-scoped + reports deletion.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay publish lease (private, single-flight, fenced)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `eblease-svc-${stamp}` } });
    const email = `ebay-lease+${stamp}@slabvault.test`;
    const password = `Test-eblease-${stamp}`;
    const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `eblease-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });
    const { data: acct } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-lease-${stamp}`, connection_status: "connected" }).select("id").single();
    accountId = acct!.id;
    accountIds.push(accountId);
  });

  afterAll(async () => {
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("grants exactly ONE lease when two callers race for the same account+SKU", async () => {
    const sku = `GCV-RACE-${stamp}`;
    const [a, b] = await Promise.all([
      service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-A", p_ttl_seconds: 120 }),
      service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-B", p_ttl_seconds: 120 }),
    ]);
    expect([a.data, b.data].filter((r) => (r as { acquired?: boolean })?.acquired)).toHaveLength(1);
  });

  it("fencing (assert_and_extend) holds only for the owning token", async () => {
    const sku = `GCV-FENCE-${stamp}`;
    const acq = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "owner", p_ttl_seconds: 120 });
    expect((acq.data as { acquired?: boolean }).acquired).toBe(true);
    const held = await service.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: sku, p_token: "owner", p_ttl_seconds: 120 });
    expect((held.data as { held?: boolean }).held).toBe(true);
    const stale = await service.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: sku, p_token: "not-owner", p_ttl_seconds: 120 });
    expect((stale.data as { held?: boolean }).held).toBe(false);
  });

  it("release is token-scoped and reports deletion; a released lease is reacquirable", async () => {
    const sku = `GCV-REL-${stamp}`;
    await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "rel-owner", p_ttl_seconds: 120 });
    const wrong = await service.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: "wrong" });
    expect((wrong.data as { released?: boolean }).released).toBe(false); // still held
    const right = await service.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: "rel-owner" });
    expect((right.data as { released?: boolean }).released).toBe(true);
    const reacq = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "rel-new", p_ttl_seconds: 120 });
    expect((reacq.data as { acquired?: boolean }).acquired).toBe(true);
  });

  it("the lease table is NOT reachable through the Data API (private schema), and RPCs are service_role-only", async () => {
    // The table is in `private`, which PostgREST does not expose — even to an admin.
    expect((await adminClient.from("ebay_publish_leases").select("id").limit(1)).error).not.toBeNull();
    expect((await service.from("ebay_publish_leases").select("id").limit(1)).error).not.toBeNull();
    // The RPCs are denied to the authenticated (non-service) role.
    expect((await adminClient.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: "x", p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: "x", p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: "x", p_token: "x" })).error).not.toBeNull();
  });
});
