import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("slab inventory maintenance", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  let userClient: SupabaseClient;
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  async function makeUser(tag: string, makeAdmin: boolean): Promise<SupabaseClient> {
    const email = `${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: makeAdmin ? { graded_card_value_admin: true } : {},
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    if (makeAdmin) await service.from("slab_admins").insert({ user_id: data.user!.id });
    const client = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `maint-${tag}-${stamp}` } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    return client;
  }

  async function createSlab(cert: string) {
    const { data, error } = await adminClient.rpc("create_slab", {
      p: {
        card_name: "Maintenance Test",
        grader: "PSA",
        grade: "9",
        certification_number: cert,
        set_name: "Test Set",
        card_number: "1",
        year: 2026,
        language: "English",
        final_value_cents: 1000,
        verification_status: "verified",
        valuation_confidence: "manual",
        valuation_provenance: "manual_value",
      },
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    expect(error).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as { id: string; inventory_sequence: number };
    slabIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `maint-service-${stamp}` } });
    adminClient = await makeUser("maint-admin", true);
    userClient = await makeUser("maint-user", false);
  });

  afterAll(async () => {
    await service.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true);
    if (slabIds.length) await service.from("slabs").delete().in("id", slabIds);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("rejects inventory-ID changes from a non-admin", async () => {
    const slab = await createSlab(`MAINT-U-${stamp}`);
    const { error } = await userClient.rpc("reassign_slab_inventory_id", { p_slab_id: slab.id, p_sequence: slab.inventory_sequence + 1000 });
    expect(error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);
  });

  it("lets an admin correct a visible inventory ID and rejects duplicates", async () => {
    const first = await createSlab(`MAINT-A-${stamp}`);
    const second = await createSlab(`MAINT-B-${stamp}`);
    const target = Math.max(first.inventory_sequence, second.inventory_sequence) + 500;
    const changed = await adminClient.rpc("reassign_slab_inventory_id", { p_slab_id: first.id, p_sequence: target });
    expect(changed.error).toBeNull();
    const duplicate = await adminClient.rpc("reassign_slab_inventory_id", { p_slab_id: second.id, p_sequence: target });
    expect(duplicate.error?.message ?? "").toMatch(/INVENTORY_ID_ALREADY_USED|duplicate/i);
  });

  it("compacts all remaining visible IDs to a consecutive sequence", async () => {
    await createSlab(`MAINT-C-${stamp}`);
    const result = await adminClient.rpc("compact_slab_inventory_ids");
    expect(result.error).toBeNull();
    const { data, error } = await service.from("slabs").select("inventory_sequence").order("inventory_sequence");
    expect(error).toBeNull();
    const sequences = (data ?? []).map((row) => row.inventory_sequence as number);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it("requires the delete switch and then purges the selected slab", async () => {
    const slab = await createSlab(`MAINT-D-${stamp}`);
    await service.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true);
    const blocked = await adminClient.rpc("purge_slabs", { p_ids: [slab.id] });
    expect(blocked.error?.message ?? "").toMatch(/HARD_DELETE_DISABLED/i);

    await adminClient.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const purged = await adminClient.rpc("purge_slabs", { p_ids: [slab.id] });
    expect(purged.error).toBeNull();
    const { data } = await service.from("slabs").select("id").eq("id", slab.id).maybeSingle();
    expect(data).toBeNull();
    const index = slabIds.indexOf(slab.id);
    if (index >= 0) slabIds.splice(index, 1);
  });
});
