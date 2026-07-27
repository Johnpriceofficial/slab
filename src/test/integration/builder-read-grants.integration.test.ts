import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260903 builder read grants: authenticated holds
// SELECT only (rows still gated by the admin-read RLS policies), anon holds no
// table privilege at all, and every browser-role write path is denied.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("builder read grants (SELECT-only for authenticated, anon fully revoked)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  let customerClient: SupabaseClient;
  let anonClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  let probeRunId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `brg-svc-${stamp}` } });

    const adminEmail = `builder-rg-admin+${stamp}@slabvault.test`;
    const adminPassword = `Test-brg-a-${stamp}`;
    const { data: au } = await service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(au.user!.id);
    await service.from("slab_admins").insert({ user_id: au.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `brg-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });

    const custEmail = `builder-rg-cust+${stamp}@slabvault.test`;
    const custPassword = `Test-brg-c-${stamp}`;
    const { data: cu } = await service.auth.admin.createUser({ email: custEmail, password: custPassword, email_confirm: true });
    userIds.push(cu.user!.id);
    customerClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `brg-cust-${stamp}` } });
    await customerClient.auth.signInWithPassword({ email: custEmail, password: custPassword });

    anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `brg-anon-${stamp}` } });

    const { data: run, error } = await service
      .from("builder_runs")
      .insert({ project: "slab", instruction: `read-grants probe ${stamp}`, correlation_id: `brg-${stamp}` })
      .select("id")
      .single();
    expect(error).toBeNull();
    probeRunId = (run as { id: string }).id;
  });

  afterAll(async () => {
    if (probeRunId) await service.from("builder_runs").delete().eq("id", probeRunId);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("an authenticated administrator reads builder runs through RLS (the /builder path)", async () => {
    const { data, error } = await adminClient.from("builder_runs").select("id").eq("id", probeRunId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => (r as { id: string }).id)).toContain(probeRunId);
  });

  it("a signed-in non-admin gets zero rows and no authorization leak", async () => {
    const { data, error } = await customerClient.from("builder_runs").select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("anon holds no table privilege on any of the seven builder tables", async () => {
    for (const table of [
      "builder_connections", "builder_runs", "builder_steps", "builder_approvals",
      "builder_tool_calls", "builder_audit_events", "builder_policy_rules",
    ]) {
      const { error } = await anonClient.from(table).select("*").limit(1);
      expect(error, `anon must be denied on ${table}`).not.toBeNull();
    }
  });

  it("authenticated INSERT is denied even for admins", async () => {
    const { error } = await adminClient
      .from("builder_runs")
      .insert({ project: "slab", instruction: "forbidden", correlation_id: `brg-w-${stamp}` });
    expect(error).not.toBeNull();
  });

  it("authenticated UPDATE is denied even for admins", async () => {
    const { error } = await adminClient
      .from("builder_runs")
      .update({ instruction: "forbidden" })
      .eq("id", probeRunId);
    expect(error).not.toBeNull();
  });

  it("authenticated DELETE is denied even for admins", async () => {
    const { error } = await adminClient.from("builder_runs").delete().eq("id", probeRunId);
    expect(error).not.toBeNull();
    // The probe row must still exist afterward.
    const { data } = await service.from("builder_runs").select("id").eq("id", probeRunId);
    expect(data ?? []).toHaveLength(1);
  });
});
