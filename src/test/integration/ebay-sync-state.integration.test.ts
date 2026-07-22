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

  const complete = (runId: string, token: string, wm: string) => service.rpc("ebay_sync_complete", { p_account_id: accountId, p_resource_type: "orders", p_run_id: runId, p_lease_token: token, p_high_watermark_at: wm, p_overlap_start_at: null, p_pages: 2, p_records_fetched: 5, p_records_persisted: 5, p_durable_total: 5, p_latency_ms: 10 });
  // Begin-run is now FENCED (20260832): it requires the caller's active, unexpired lease token.
  const load = (resource: string, token: string) => service.rpc("ebay_sync_state_load", { p_account_id: accountId, p_resource_type: resource, p_lease_token: token });
  const stateRunId = async (resource: string) => { const { data } = await service.from("ebay_sync_state").select("run_id").eq("ebay_account_id", accountId).eq("resource_type", resource).single(); return (data as { run_id: string | null } | null)?.run_id ?? null; };

  it("load stamps a run_id; ATOMIC complete (lease-fenced) advances the watermark; fail retains it", async () => {
    await service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "orders", p_token: "owner", p_ttl_seconds: 120 });
    const loaded = await load("orders", "owner");
    expect((loaded.data as { ok?: boolean }).ok).toBe(true);
    const runId = (loaded.data as { run_id: string; high_watermark_at: string | null }).run_id;
    expect(runId).toBeTruthy();
    expect((loaded.data as { high_watermark_at?: string | null }).high_watermark_at ?? null).toBeNull();
    // A stale runner (wrong run_id) cannot complete.
    expect((await complete(crypto.randomUUID(), "owner", "2026-07-20T00:00:00Z")).data).toMatchObject({ ok: false, error_code: "stale_runner" });
    // A lease-less runner cannot complete.
    expect((await complete(runId, "not-owner", "2026-07-20T00:00:00Z")).data).toMatchObject({ ok: false, error_code: "lease_lost" });
    // The active runner holding the lease completes atomically.
    expect((await complete(runId, "owner", "2026-07-20T00:00:00Z")).data).toMatchObject({ ok: true });
    const reload = await load("orders", "owner");
    expect(new Date((reload.data as { high_watermark_at: string }).high_watermark_at).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    // A failed run (active run_id) retains the watermark.
    const run2 = (reload.data as { run_id: string }).run_id;
    expect((await service.rpc("ebay_sync_state_fail", { p_account_id: accountId, p_resource_type: "orders", p_run_id: run2, p_error_code: "provider_timeout" })).data).toMatchObject({ ok: true });
    const afterFail = await load("orders", "owner");
    expect(new Date((afterFail.data as { high_watermark_at: string }).high_watermark_at).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("finding #2: begin-run is FENCED — only the active, unexpired lease token may begin a run; a stale token cannot overwrite a newer run_id", async () => {
    // 1) Hold the finances lease with token begin-A and begin a run.
    await service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "begin-A", p_ttl_seconds: 120 });
    const a = await load("finances", "begin-A");
    expect((a.data as { ok?: boolean }).ok).toBe(true);
    const r1 = (a.data as { run_id: string }).run_id;
    expect(r1).toBeTruthy();
    expect(await stateRunId("finances")).toBe(r1);
    // 2) A caller WITHOUT a matching lease token is rejected and changes NO state.
    const ghost = await load("finances", "ghost-token");
    expect(ghost.data).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(await stateRunId("finances")).toBe(r1); // run_id unchanged by the rejected caller
    // 3) The lease is released + re-acquired by a NEW token (models expiry/replacement); the new owner begins run R2.
    await service.rpc("ebay_sync_lease_release", { p_account_id: accountId, p_resource_type: "finances", p_token: "begin-A" });
    await service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "begin-B", p_ttl_seconds: 120 });
    const b = await load("finances", "begin-B");
    expect((b.data as { ok?: boolean }).ok).toBe(true);
    const r2 = (b.data as { run_id: string }).run_id;
    expect(r2).not.toBe(r1);
    // 4) The STALE runner (old begin-A token, no longer the active lease) cannot begin/overwrite R2.
    const stale = await load("finances", "begin-A");
    expect(stale.data).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(await stateRunId("finances")).toBe(r2); // newer run_id preserved; stale caller did not overwrite
    // cleanup so the single-flight test below starts from a clean finances lease.
    await service.rpc("ebay_sync_lease_release", { p_account_id: accountId, p_resource_type: "finances", p_token: "begin-B" });
    await service.from("ebay_sync_state").delete().eq("ebay_account_id", accountId).eq("resource_type", "finances");
  });

  it("the sync lease is single-flight, assert-and-extend is token-scoped, release is checked", async () => {
    const [a, b] = await Promise.all([
      service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "tok-A", p_ttl_seconds: 120 }),
      service.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: "finances", p_token: "tok-B", p_ttl_seconds: 120 }),
    ]);
    expect([a.data, b.data].filter((r) => (r as { acquired?: boolean })?.acquired)).toHaveLength(1);
    const owner = ((a.data as { acquired?: boolean })?.acquired ? "tok-A" : "tok-B");
    expect((await service.rpc("ebay_sync_lease_assert_and_extend", { p_account_id: accountId, p_resource_type: "finances", p_token: owner, p_ttl_seconds: 120 })).data).toMatchObject({ held: true });
    expect((await service.rpc("ebay_sync_lease_assert_and_extend", { p_account_id: accountId, p_resource_type: "finances", p_token: "not-owner", p_ttl_seconds: 120 })).data).toMatchObject({ held: false });
    const wrong = await service.rpc("ebay_sync_lease_release", { p_account_id: accountId, p_resource_type: "finances", p_token: "not-owner" });
    expect((wrong.data as { released?: boolean }).released).toBe(false);
  });

  it("sync-state + lease RPCs are denied to anon and authenticated; the state table is not writable by clients", async () => {
    expect((await adminClient.rpc("ebay_sync_complete", { p_account_id: accountId, p_resource_type: "orders", p_run_id: crypto.randomUUID(), p_lease_token: "x", p_high_watermark_at: null, p_overlap_start_at: null, p_pages: 0, p_records_fetched: 0, p_records_persisted: 0, p_durable_total: 0, p_latency_ms: 0 })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_sync_lease_assert_and_extend", { p_account_id: accountId, p_resource_type: "orders", p_token: "x", p_ttl_seconds: 1 })).error).not.toBeNull();
    // Admin may READ sync state (RLS select policy) but cannot mutate it: a direct
    // update is RLS-filtered to zero rows, so the durable watermark is UNCHANGED.
    await adminClient.from("ebay_sync_state").update({ high_watermark_at: "2000-01-01T00:00:00Z" }).eq("ebay_account_id", accountId);
    const { data: row } = await service.from("ebay_sync_state").select("high_watermark_at").eq("ebay_account_id", accountId).eq("resource_type", "orders").single();
    expect(new Date(row!.high_watermark_at as string).toISOString()).toBe("2026-07-20T00:00:00.000Z"); // committed value preserved
  });
});
