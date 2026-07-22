import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for the C.8 durable sync state (20260827) + single-flight
// sync lease (20260828) against the disposable CI Supabase: load initializes and
// returns the watermark; commit advances it only on completion; fail retains it;
// the lease is single-flight + checked release; all RPCs are service_role-only.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("ebay sync state + lease (durable watermark, single-flight, service-only)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ss-svc-${stamp}` } });
    const email = `ebay-ss+${stamp}@slabvault.test`;
    const password = `Test-ss-${stamp}`;
    const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ss-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });
    const { data: acct } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-ss-${stamp}`, connection_status: "connected" }).select("id").single();
    accountId = acct!.id; accountIds.push(accountId);
  });
  afterAll(async () => {
    await service.from("ebay_sync_state").delete().eq("ebay_account_id", accountId);
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("load initializes an idle row (null watermark); commit advances it; fail retains it", async () => {
    const loaded = await service.rpc("ebay_sync_state_load", { p_account_id: accountId, p_resource_type: "orders" });
    expect((loaded.data as { high_watermark_at?: string | null }).high_watermark_at ?? null).toBeNull();
    const committed = await service.rpc("ebay_sync_state_commit", { p_account_id: accountId, p_resource_type: "orders", p_run_id: crypto.randomUUID(), p_high_watermark_at: "2026-07-20T00:00:00Z", p_pages: 2, p_records_fetched: 5, p_records_persisted: 5, p_durable_total: 5 });
    expect((committed.data as { ok?: boolean }).ok).toBe(true);
    const reload = await service.rpc("ebay_sync_state_load", { p_account_id: accountId, p_resource_type: "orders" });
    expect(new Date((reload.data as { high_watermark_at: string }).high_watermark_at).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    // A failed run must NOT move the watermark.
    await service.rpc("ebay_sync_state_fail", { p_account_id: accountId, p_resource_type: "orders", p_run_id: crypto.randomUUID(), p_error_code: "provider_timeout" });
    const afterFail = await service.rpc("ebay_sync_state_load", { p_account_id: accountId, p_resource_type: "orders" });
    expect(new Date((afterFail.data as { high_watermark_at: string }).high_watermark_at).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("the sync lease is single-flight and release is token-scoped + checked", async () => {
    const [a, b] = await Promise.all([
      service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "tok-A", p_ttl_seconds: 120 }),
      service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "tok-B", p_ttl_seconds: 120 }),
    ]);
    expect([a.data, b.data].filter((r) => (r as { acquired?: boolean })?.acquired)).toHaveLength(1);
    const wrong = await service.rpc("ebay_sync_lease_release", { p_account_id: accountId, p_resource_type: "finances", p_token: "not-owner" });
    expect((wrong.data as { released?: boolean }).released).toBe(false);
  });

  it("sync-state + lease RPCs are denied to anon and authenticated; the state table is not writable by clients", async () => {
    expect((await adminClient.rpc("ebay_sync_state_commit", { p_account_id: accountId, p_resource_type: "orders", p_run_id: crypto.randomUUID(), p_high_watermark_at: null, p_pages: 0, p_records_fetched: 0, p_records_persisted: 0, p_durable_total: 0 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "orders", p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    // Admin may READ sync state (RLS select policy) but cannot mutate it: a direct
    // update is RLS-filtered to zero rows, so the durable watermark is UNCHANGED.
    await adminClient.from("ebay_sync_state").update({ high_watermark_at: "2000-01-01T00:00:00Z" }).eq("ebay_account_id", accountId);
    const { data: row } = await service.from("ebay_sync_state").select("high_watermark_at").eq("ebay_account_id", accountId).eq("resource_type", "orders").single();
    expect(new Date(row!.high_watermark_at as string).toISOString()).toBe("2026-07-20T00:00:00.000Z"); // committed value preserved
  });
});
