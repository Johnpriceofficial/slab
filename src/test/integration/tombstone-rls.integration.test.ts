import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdministrator } from "./support/admin-role";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260904: the tombstone ledger accepts no direct
// client access from any role, while the two trusted postgres-owned DEFINER
// paths — purge_slabs (write) and get_slab_deletion_tombstone (admin read) —
// keep working with RLS enabled.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("slab_deletion_tombstones RLS (deny-all direct, trusted paths intact)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  let customerClient: SupabaseClient;
  let anonClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  let slabId = "";
  let priorHardDelete: boolean | null = null;

  async function createSlab(cert: string) {
    const result = await adminClient.rpc("create_slab", {
      p: {
        card_name: "Kyurem ex",
        grader: "CGC",
        grade: "10",
        grade_label: "PRISTINE",
        certification_number: cert,
        set_name: "Black Bolt",
        card_number: "160/086",
        year: 2025,
        language: "Japanese",
        rarity: "Super Rare",
        variation: "Super Rare - Holo",
        label_description: "Kyurem ex Pokémon Japanese Black Bolt Super Rare - Holo",
        verification_status: "unverified",
        valuation_provenance: "tier_unavailable",
      },
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    expect(result.error).toBeNull();
    const row = (Array.isArray(result.data) ? result.data[0] : result.data) as { id: string };
    return row.id;
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ts-svc-${stamp}` } });

    const adminEmail = `tombstone-admin+${stamp}@slabvault.test`;
    const adminPassword = `Test-ts-a-${stamp}`;
    const { data: au } = await service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    await grantAdministrator(service, au.user!.id);
    userIds.push(au.user!.id);
    await service.from("slab_admins").insert({ user_id: au.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ts-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });

    const custEmail = `tombstone-cust+${stamp}@slabvault.test`;
    const custPassword = `Test-ts-c-${stamp}`;
    const { data: cu } = await service.auth.admin.createUser({ email: custEmail, password: custPassword, email_confirm: true });
    userIds.push(cu.user!.id);
    customerClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ts-cust-${stamp}` } });
    await customerClient.auth.signInWithPassword({ email: custEmail, password: custPassword });

    anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ts-anon-${stamp}` } });

    slabId = await createSlab(`TSRLS-${stamp}`);

    const { data: settings } = await service.from("slab_settings").select("allow_hard_delete").eq("id", true).single();
    priorHardDelete = (settings as { allow_hard_delete: boolean } | null)?.allow_hard_delete ?? false;
    await service.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
  });

  afterAll(async () => {
    if (priorHardDelete !== null) {
      await service.from("slab_settings").update({ allow_hard_delete: priorHardDelete }).eq("id", true);
    }
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("no client role reaches the tombstone table directly through the API surface", async () => {
    for (const [label, client] of [
      ["anon", anonClient],
      ["authenticated non-admin", customerClient],
      ["authenticated admin", adminClient],
      ["service_role", service],
    ] as const) {
      const sel = await client.from("slab_deletion_tombstones").select("*").limit(1);
      expect(sel.error, `${label} direct SELECT must fail`).not.toBeNull();
      const ins = await client.from("slab_deletion_tombstones").insert({ slab_id: crypto.randomUUID() });
      expect(ins.error, `${label} direct INSERT must fail`).not.toBeNull();
      const upd = await client.from("slab_deletion_tombstones").update({ slab_id: crypto.randomUUID() }).eq("slab_id", crypto.randomUUID());
      expect(upd.error, `${label} direct UPDATE must fail`).not.toBeNull();
      const del = await client.from("slab_deletion_tombstones").delete().eq("slab_id", crypto.randomUUID());
      expect(del.error, `${label} direct DELETE must fail`).not.toBeNull();
    }
  });

  it("the trusted purge path still inserts the tombstone transactionally with RLS enabled", async () => {
    const purged = await adminClient.rpc("purge_slabs", { p_ids: [slabId] });
    expect(purged.error).toBeNull();
    const gone = await service.from("slabs").select("id").eq("id", slabId).maybeSingle();
    expect(gone.data).toBeNull();
  });

  it("the admin-only reader RPC returns the evidence for an administrator", async () => {
    const tombstone = await adminClient.rpc("get_slab_deletion_tombstone", { p_slab_id: slabId });
    expect(tombstone.error).toBeNull();
    const rows = (tombstone.data ?? []) as Array<{ slab_id?: string }>;
    expect(rows.length).toBe(1);
  });

  it("the reader RPC yields nothing for a non-admin", async () => {
    const res = await customerClient.rpc("get_slab_deletion_tombstone", { p_slab_id: slabId });
    // Admin gate: either an explicit error or an empty result — never the evidence.
    if (res.error) expect(res.error).toBeTruthy();
    else expect(((res.data ?? []) as unknown[]).length).toBe(0);
  });
});
