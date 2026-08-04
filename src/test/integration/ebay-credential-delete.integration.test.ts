import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as {
  env?: Record<string, string | undefined>;
} | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay credential delete RPC", () => {
  let service: SupabaseClient;
  let authenticated: SupabaseClient;
  let accountId = "";
  let userId = "";
  const stamp = `${Date.now()}-${Math.floor(performance.now())}`;

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        storageKey: `ebdisc-delete-svc-${stamp}`,
      },
    });

    const email = `ebay-delete+${stamp}@slabvault.test`;
    const password = `Test-ebay-delete-${stamp}`;
    const created = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    userId = created.data.user!.id;

    authenticated = createClient(URL!, ANON!, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        storageKey: `ebdisc-delete-user-${stamp}`,
      },
    });
    await authenticated.auth.signInWithPassword({ email, password });

    const account = await service
      .from("ebay_accounts")
      .insert({
        ebay_user_id: `ebay-delete-${stamp}`,
        connection_status: "connected",
        privilege_status: "enabled",
        authorization_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    accountId = account.data!.id;

    const upsert = await service.rpc("ebay_oauth_credential_upsert", {
      p_account_id: accountId,
      p_refresh_token_encrypted: "disposable-test-ciphertext",
      p_refresh_token_expires_at: null,
      p_scopes: ["sell.inventory"],
      p_rotated_at: new Date().toISOString(),
    });
    expect(upsert.error).toBeNull();
  });

  afterAll(async () => {
    if (accountId) await service.from("ebay_accounts").delete().eq("id", accountId);
    if (userId) await service.auth.admin.deleteUser(userId).catch(() => {});
  });

  it("denies direct execution to authenticated callers", async () => {
    const result = await authenticated.rpc("ebay_credential_delete", {
      p_account_id: accountId,
    });
    expect(result.error).not.toBeNull();
  });

  it("deletes the private credential, marks the account disconnected, and records an audit atomically", async () => {
    const deleted = await service.rpc("ebay_credential_delete", {
      p_account_id: accountId,
    });
    expect(deleted.error).toBeNull();
    expect(deleted.data).toBe(1);

    const credential = await service
      .rpc("ebay_oauth_credential_get", { p_account_id: accountId })
      .maybeSingle();
    expect(credential.error).toBeNull();
    expect(credential.data).toBeNull();

    const account = await service
      .from("ebay_accounts")
      .select("connection_status, privilege_status, authorization_expires_at")
      .eq("id", accountId)
      .single();
    expect(account.error).toBeNull();
    expect(account.data).toEqual({
      connection_status: "disconnected",
      privilege_status: null,
      authorization_expires_at: null,
    });

    const audit = await service
      .from("ebay_api_runs")
      .select("operation, status, error_code")
      .eq("ebay_account_id", accountId)
      .eq("operation", "disconnect");
    expect(audit.error).toBeNull();
    expect(audit.data).toEqual([
      { operation: "disconnect", status: "success", error_code: null },
    ]);
  });

  it("is idempotent for repeated and unknown-account service-role calls", async () => {
    const repeated = await service.rpc("ebay_credential_delete", {
      p_account_id: accountId,
    });
    expect(repeated.error).toBeNull();
    expect(repeated.data).toBe(0);

    const unknown = await service.rpc("ebay_credential_delete", {
      p_account_id: crypto.randomUUID(),
    });
    expect(unknown.error).toBeNull();
    expect(unknown.data).toBe(0);
  });
});
