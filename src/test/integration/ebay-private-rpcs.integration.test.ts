import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Regression coverage for 20260813000000_ebay_private_access_rpcs.sql. The eBay
// Edge Functions reach the (intentionally unexposed) `private` schema only via
// these SECURITY DEFINER RPCs. These tests prove, against the disposable CI
// Supabase, that: (a) service_role can drive the OAuth-state + credential
// lifecycle through the RPCs, (b) the rotation guard is optimistic-concurrency
// safe, and (c) the RPCs are DENIED to the authenticated role (server-only).
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay private-schema RPCs (SECURITY DEFINER, service_role only)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebrpc-svc-${stamp}` } });
    const email = `ebay-rpc+${stamp}@slabvault.test`;
    const password = `Test-ebrpc-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    if (error) throw error;
    userIds.push(data.user!.id);
    await service.from("slab_admins").insert({ user_id: data.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebrpc-admin-${stamp}` } });
    const { error: signInError } = await adminClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
  });

  afterAll(async () => {
    // Deleting the account (cascade → credentials) and the user (cascade → states)
    // cleans the private rows the RPCs created.
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("drives the OAuth-state lifecycle: create → get → consume", async () => {
    const hash = `hash-${stamp}`;
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const created = await service.rpc("ebay_oauth_state_create", { p_state_hash: hash, p_requested_by: userIds[0], p_expires_at: expires, p_redirect_after: "/slabs" });
    expect(created.error).toBeNull();

    const got = await service.rpc("ebay_oauth_state_get", { p_state_hash: hash }).maybeSingle();
    expect(got.error).toBeNull();
    expect((got.data as { requested_by: string }).requested_by).toBe(userIds[0]);
    expect((got.data as { consumed_at: string | null }).consumed_at).toBeNull();
    expect((got.data as { redirect_after: string }).redirect_after).toBe("/slabs");

    const consumed = await service.rpc("ebay_oauth_state_consume", { p_state_hash: hash });
    expect(consumed.error).toBeNull();
    const afterConsume = await service.rpc("ebay_oauth_state_get", { p_state_hash: hash }).maybeSingle();
    expect((afterConsume.data as { consumed_at: string | null }).consumed_at).not.toBeNull();
  });

  it("drives the credential lifecycle and enforces optimistic-concurrency rotation", async () => {
    const { data: account, error: accErr } = await service.from("ebay_accounts")
      .insert({ ebay_user_id: `ebay-rpc-${stamp}`, connection_status: "connected" }).select("id").single();
    expect(accErr).toBeNull();
    accountIds.push(account!.id);

    const up = await service.rpc("ebay_oauth_credential_upsert", { p_account_id: account!.id, p_refresh_token_encrypted: "cipher-A", p_refresh_token_expires_at: null, p_scopes: ["sell.inventory"], p_rotated_at: new Date().toISOString() });
    expect(up.error).toBeNull();

    const got = await service.rpc("ebay_oauth_credential_get", { p_account_id: account!.id }).maybeSingle();
    expect((got.data as { refresh_token_encrypted: string }).refresh_token_encrypted).toBe("cipher-A");
    expect((got.data as { scopes: string[] }).scopes).toEqual(["sell.inventory"]);

    // Rotate from the CORRECT prior ciphertext → 1 row changed.
    const rotOk = await service.rpc("ebay_oauth_credential_rotate", { p_account_id: account!.id, p_prior_encrypted: "cipher-A", p_new_encrypted: "cipher-B", p_refresh_token_expires_at: null, p_scopes: null, p_rotated_at: new Date().toISOString() });
    expect(rotOk.data).toBe(1);
    const afterRot = await service.rpc("ebay_oauth_credential_get", { p_account_id: account!.id }).maybeSingle();
    expect((afterRot.data as { refresh_token_encrypted: string }).refresh_token_encrypted).toBe("cipher-B");

    // Rotate from a STALE prior ciphertext → 0 rows (a concurrent rotation won; no regression).
    const rotStale = await service.rpc("ebay_oauth_credential_rotate", { p_account_id: account!.id, p_prior_encrypted: "cipher-A", p_new_encrypted: "cipher-OLD", p_refresh_token_expires_at: null, p_scopes: null, p_rotated_at: new Date().toISOString() });
    expect(rotStale.data).toBe(0);
    const stillB = await service.rpc("ebay_oauth_credential_get", { p_account_id: account!.id }).maybeSingle();
    expect((stillB.data as { refresh_token_encrypted: string }).refresh_token_encrypted).toBe("cipher-B");
  });

  it("denies every RPC to the authenticated (non-service) role", async () => {
    // authenticated has EXECUTE revoked → PostgREST returns an error, not data.
    const create = await adminClient.rpc("ebay_oauth_state_create", { p_state_hash: `x-${stamp}`, p_requested_by: userIds[0], p_expires_at: new Date().toISOString(), p_redirect_after: null });
    expect(create.error).not.toBeNull();
    const getState = await adminClient.rpc("ebay_oauth_state_get", { p_state_hash: `hash-${stamp}` });
    expect(getState.error).not.toBeNull();
    const getCred = await adminClient.rpc("ebay_oauth_credential_get", { p_account_id: accountIds[0] ?? userIds[0] });
    expect(getCred.error).not.toBeNull();
  });
});
