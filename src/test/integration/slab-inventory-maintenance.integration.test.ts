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
    const row = (Array.isArray(data) ? data[0] : data) as { id: string; inventory_sequence: number; front_image_path: string | null };
    slabIds.push(row.id);
    return row;
  }

  async function acknowledge(paths: string[]) {
    if (paths.length === 0) return;
    const result = await adminClient.rpc("acknowledge_slab_storage_cleanup", { p_paths: paths });
    expect(result.error).toBeNull();
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `maint-service-${stamp}` } });
    adminClient = await makeUser("maint-admin", true);
    userClient = await makeUser("maint-user", false);
  });

  afterAll(async () => {
    await service.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true);
    if (slabIds.length) await service.from("slabs").delete().in("id", slabIds);
    await service.schema("private").from("slab_storage_cleanup_queue").delete().like("storage_path", `%${stamp}%`);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("rejects inventory maintenance and cleanup queue access from a non-admin", async () => {
    const slab = await createSlab(`MAINT-U-${stamp}`);
    const reassigned = await userClient.rpc("reassign_slab_inventory_id", { p_slab_id: slab.id, p_sequence: slab.inventory_sequence + 1000 });
    expect(reassigned.error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);
    const queued = await userClient.rpc("list_pending_slab_storage_cleanup");
    expect(queued.error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);
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

  it("keeps mixed valid and missing purge requests atomic", async () => {
    const slab = await createSlab(`MAINT-ATOMIC-${stamp}`);
    await service.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const result = await adminClient.rpc("purge_slabs", { p_ids: [slab.id, crypto.randomUUID()] });
    expect(result.error?.message ?? "").toMatch(/SLAB_NOT_FOUND_OR_DUPLICATE_INPUT/i);
    const { data } = await service.from("slabs").select("id").eq("id", slab.id).maybeSingle();
    expect(data?.id).toBe(slab.id);
  });

  it("requires the delete switch, purges atomically, and queues storage cleanup", async () => {
    const slab = await createSlab(`MAINT-D-${stamp}`);
    await service.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true);
    const blocked = await adminClient.rpc("purge_slabs", { p_ids: [slab.id] });
    expect(blocked.error?.message ?? "").toMatch(/HARD_DELETE_DISABLED/i);

    await adminClient.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const purged = await adminClient.rpc("purge_slabs", { p_ids: [slab.id] });
    expect(purged.error).toBeNull();
    const { data } = await service.from("slabs").select("id").eq("id", slab.id).maybeSingle();
    expect(data).toBeNull();

    const paths = ((purged.data ?? []) as Array<{ front_image_path: string | null }>).map((row) => row.front_image_path).filter(Boolean) as string[];
    expect(paths).toContain(slab.front_image_path);
    const pending = await adminClient.rpc("list_pending_slab_storage_cleanup");
    expect(pending.error).toBeNull();
    expect((pending.data as Array<{ storage_path: string }>).map((row) => row.storage_path)).toEqual(expect.arrayContaining(paths));
    await acknowledge(paths);

    const index = slabIds.indexOf(slab.id);
    if (index >= 0) slabIds.splice(index, 1);
  });

  it("routes the legacy hard-delete RPC through the same durable cleanup queue", async () => {
    const slab = await createSlab(`MAINT-LEGACY-${stamp}`);
    await adminClient.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const deleted = await adminClient.rpc("hard_delete_slab", { p_id: slab.id });
    expect(deleted.error).toBeNull();
    const rows = (deleted.data ?? []) as Array<{ front_image_path: string | null }>;
    const paths = rows.map((row) => row.front_image_path).filter(Boolean) as string[];
    expect(paths).toContain(slab.front_image_path);

    const pending = await adminClient.rpc("list_pending_slab_storage_cleanup");
    expect(pending.error).toBeNull();
    expect((pending.data as Array<{ storage_path: string }>).map((row) => row.storage_path)).toEqual(expect.arrayContaining(paths));
    await acknowledge(paths);

    const { data } = await service.from("slabs").select("id").eq("id", slab.id).maybeSingle();
    expect(data).toBeNull();
    const index = slabIds.indexOf(slab.id);
    if (index >= 0) slabIds.splice(index, 1);
  });
});
