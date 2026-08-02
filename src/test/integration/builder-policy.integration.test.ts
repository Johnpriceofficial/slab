import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdministrator } from "./support/admin-role";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for the builder admin-read policies after the 20260902
// initplan rewrite: authorization outcomes must be identical to 20260901 —
// admins read, non-admins and anon see nothing, browser roles never write.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("builder admin-read policies (initplan form, unchanged authorization)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  let customerClient: SupabaseClient;
  let anonClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  let probeRunId = "";

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `bp-svc-${stamp}` } });

    const adminEmail = `builder-pol-admin+${stamp}@slabvault.test`;
    const adminPassword = `Test-bp-a-${stamp}`;
    const { data: au } = await service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    await grantAdministrator(service, au.user!.id);
    userIds.push(au.user!.id);
    await service.from("slab_admins").insert({ user_id: au.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `bp-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });

    const custEmail = `builder-pol-cust+${stamp}@slabvault.test`;
    const custPassword = `Test-bp-c-${stamp}`;
    const { data: cu } = await service.auth.admin.createUser({ email: custEmail, password: custPassword, email_confirm: true });
    userIds.push(cu.user!.id);
    customerClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `bp-cust-${stamp}` } });
    await customerClient.auth.signInWithPassword({ email: custEmail, password: custPassword });

    anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `bp-anon-${stamp}` } });

    const { data: run, error } = await service
      .from("builder_runs")
      .insert({ project: "slab", instruction: `policy probe ${stamp}`, correlation_id: `bp-${stamp}` })
      .select("id")
      .single();
    expect(error).toBeNull();
    probeRunId = (run as { id: string }).id;
  });

  afterAll(async () => {
    if (probeRunId) await service.from("builder_runs").delete().eq("id", probeRunId);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("an admin can read builder runs through RLS", async () => {
    const { data, error } = await adminClient.from("builder_runs").select("id").eq("id", probeRunId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => (r as { id: string }).id)).toContain(probeRunId);
  });

  it("a signed-in non-admin sees zero builder rows (filtered, not erroring)", async () => {
    const { data, error } = await customerClient.from("builder_runs").select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("anon sees no builder rows under any grant state", async () => {
    const { data, error } = await anonClient.from("builder_runs").select("id");
    // Policy is TO authenticated: anon gets an empty result under default
    // grants, or a permission error if table grants are later revoked —
    // either way, no row is ever visible.
    if (error) expect(error).toBeTruthy();
    else expect(data ?? []).toHaveLength(0);
  });

  it("browser roles cannot write builder tables (writes are service_role only)", async () => {
    const { error } = await adminClient
      .from("builder_runs")
      .insert({ project: "slab", instruction: "forbidden", correlation_id: `bp-w-${stamp}` });
    expect(error).not.toBeNull();
  });
});
