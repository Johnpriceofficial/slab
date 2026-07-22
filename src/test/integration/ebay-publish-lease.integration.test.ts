import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260819000000_ebay_publish_lease.sql against the
// disposable CI Supabase: the per-(account, SKU) publish lease is a real
// single-flight — only one concurrent acquire wins, it is token-released, and an
// expired lease is reclaimable. This is what closes the check-then-create race.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay publish lease (single-flight)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";
  const sku = `GCV-LEASE-${stamp}`;

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
    const [a, b] = await Promise.all([
      service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-A", p_ttl_seconds: 120 }),
      service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-B", p_ttl_seconds: 120 }),
    ]);
    const acquired = [a.data, b.data].filter((r) => (r as { acquired?: boolean })?.acquired);
    expect(acquired).toHaveLength(1); // exactly one winner — the race is closed
  });

  it("a third caller is refused while the lease is held, then can reclaim after release", async () => {
    const held = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-C", p_ttl_seconds: 120 });
    expect((held.data as { acquired?: boolean })?.acquired).toBe(false); // still held from the prior test

    // The active token releases; the row is freed and a new caller can acquire.
    const { data: row } = await service.from("ebay_publish_leases").select("lease_token").eq("ebay_account_id", accountId).eq("sku", sku).single();
    await service.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: (row as { lease_token: string }).lease_token });
    const reacquire = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "tok-D", p_ttl_seconds: 120 });
    expect((reacquire.data as { acquired?: boolean })?.acquired).toBe(true);
  });

  it("an expired lease is reclaimable", async () => {
    const other = `GCV-LEASE-EXP-${stamp}`;
    await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: other, p_token: "tok-old", p_ttl_seconds: 120 });
    // Force expiry, then a new acquire should succeed.
    await service.from("ebay_publish_leases").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("ebay_account_id", accountId).eq("sku", other);
    const reclaimed = await service.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: other, p_token: "tok-new", p_ttl_seconds: 120 });
    expect((reclaimed.data as { acquired?: boolean })?.acquired).toBe(true);
  });

  it("denies the lease RPCs to the authenticated (non-service) role", async () => {
    expect((await adminClient.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: "x" })).error).not.toBeNull();
  });
});
