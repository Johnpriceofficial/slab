import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260814000000_ebay_account_discovery.sql against the
// disposable CI Supabase: discovery persistence (upsert + prune), honest scope
// provenance, single-flight OAuth state, and service_role-only access.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay account-discovery RPCs", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebdisc-svc-${stamp}` } });
    const email = `ebay-disc+${stamp}@slabvault.test`;
    const password = `Test-ebdisc-${stamp}`;
    const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebdisc-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });
    const { data: acct } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-disc-${stamp}`, connection_status: "connected" }).select("id").single();
    accountId = acct!.id;
    accountIds.push(accountId);
    await service.rpc("ebay_oauth_credential_upsert", { p_account_id: accountId, p_refresh_token_encrypted: "cipher", p_refresh_token_expires_at: null, p_scopes: [], p_rotated_at: new Date().toISOString() });
  });

  afterAll(async () => {
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("locations replace upserts then prunes stale keys", async () => {
    const first = await service.rpc("ebay_inventory_locations_replace", { p_account_id: accountId, p_locations: [{ merchant_location_key: "LOC-A", status: "ENABLED" }, { merchant_location_key: "LOC-B", status: "ENABLED" }] });
    expect(first.data).toBe(2);
    const second = await service.rpc("ebay_inventory_locations_replace", { p_account_id: accountId, p_locations: [{ merchant_location_key: "LOC-B", status: "DISABLED" }] });
    expect(second.data).toBe(1); // LOC-A pruned
    const { count } = await service.from("ebay_inventory_locations").select("*", { count: "exact", head: true }).eq("ebay_account_id", accountId);
    expect(count).toBe(1);
  });

  it("business policies replace persists all three types", async () => {
    const res = await service.rpc("ebay_business_policies_replace", { p_account_id: accountId, p_policies: [
      { policy_id: "F1", policy_type: "fulfillment", name: "Ship", marketplace_id: "EBAY_US" },
      { policy_id: "P1", policy_type: "payment", name: "Pay", marketplace_id: "EBAY_US" },
      { policy_id: "R1", policy_type: "return", name: "Return", marketplace_id: "EBAY_US" },
    ] });
    expect(res.data).toBe(3);
  });

  it("scope provenance set/get round-trips (requested vs token-reported)", async () => {
    await service.rpc("ebay_credential_scopes_set", { p_account_id: accountId, p_requested_scopes: ["a", "b", "c"], p_token_reported_scopes: null, p_scope_source: "requested_fallback" });
    const got = await service.rpc("ebay_credential_scopes_get", { p_account_id: accountId }).maybeSingle();
    expect((got.data as { requested_scopes: string[] }).requested_scopes).toEqual(["a", "b", "c"]);
    expect((got.data as { token_reported_scopes: string[] | null }).token_reported_scopes).toBeNull();
    expect((got.data as { scope_source: string }).scope_source).toBe("requested_fallback");
  });

  it("single-flight expires the prior unconsumed state so only one stays active", async () => {
    const h1 = `sf1-${stamp}`, h2 = `sf2-${stamp}`;
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await service.rpc("ebay_oauth_state_create_single_flight", { p_state_hash: h1, p_requested_by: userIds[0], p_expires_at: soon, p_redirect_after: "/slabs" });
    await service.rpc("ebay_oauth_state_create_single_flight", { p_state_hash: h2, p_requested_by: userIds[0], p_expires_at: soon, p_redirect_after: "/slabs" });
    const s1 = await service.rpc("ebay_oauth_state_get", { p_state_hash: h1 }).maybeSingle();
    const s2 = await service.rpc("ebay_oauth_state_get", { p_state_hash: h2 }).maybeSingle();
    // The first state was expired (expires_at pulled back to ~now); the second is still active.
    expect(new Date((s1.data as { expires_at: string }).expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(new Date((s2.data as { expires_at: string }).expires_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("denies the new RPCs to the authenticated (non-service) role", async () => {
    expect((await adminClient.rpc("ebay_inventory_locations_replace", { p_account_id: accountId, p_locations: [] })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_oauth_state_create_single_flight", { p_state_hash: "x", p_requested_by: userIds[0], p_expires_at: new Date().toISOString(), p_redirect_after: null })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: "x", p_status: "x", p_http_status: null, p_request_id: null, p_latency_ms: 0, p_error_code: null })).error).not.toBeNull();
  });
});
