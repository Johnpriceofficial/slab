import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as
  | { env?: Record<string, string | undefined> }
  | undefined)?.env ?? {}) as Record<string, string | undefined>;

const URL_ = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const DB_URL = ENV.SLABVAULT_TEST_DB_URL;
const hasCredentials = Boolean(URL_ && ANON && SERVICE && DB_URL);
const productionLike = !URL_ || /joyrent|party|rhodeisland|mycousin|prod|production|live|rcbwemkfcefarqnlgrmv|gradedcardvalue/i.test(URL_);
const suite = hasCredentials && !productionLike ? describe : describe.skip;

type SaveResult = {
  result: "created" | "already_saved" | "duplicate_certification";
  created: boolean;
  analysis_run_id: string;
  analysis_run_linked: boolean;
  owner_id: string;
  slab_id: string;
  inventory_number: number;
  inventory_code: string | null;
  front_image_path: string | null;
  back_image_path: string | null;
};

suite("atomic confirmed save — schema-current boundary cases", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let admin: SupabaseClient;
  let aliceId = "";
  let bobId = "";
  let adminId = "";
  const users: string[] = [];
  const runs = new Set<string>();
  const slabs = new Set<string>();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let serial = 0;

  const payload = (overrides: Record<string, unknown> = {}) => ({
    card_name: "Boundary Charizard",
    grader: "PSA",
    grade: "10",
    certification_number: `boundary-${stamp}-${++serial}`,
    set_name: "Base Set",
    card_number: "4",
    year: 1999,
    language: "English",
    final_value_cents: 12500,
    verification_status: "verified",
    valuation_confidence: "manual",
    valuation_provenance: "manual_value",
    ...overrides,
  });

  async function makeUser(tag: string, appMetadata: Record<string, unknown> = {}) {
    const email = `${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const created = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (created.error) throw created.error;
    const id = created.data.user!.id;
    users.push(id);
    const client = createClient(URL_!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `boundary-${tag}-${stamp}` },
    });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id, client };
  }

  async function insertRun(ownerId: string, status = "succeeded") {
    const inserted = await service
      .from("ai_analysis_runs")
      .insert({
        provider: "OPENAI",
        model: "boundary-model",
        schema_version: "test",
        analysis_type: "multi_pass_slab_identity",
        status,
        structured_result: {},
        owner_id: ownerId,
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    runs.add(inserted.data.id);
    return inserted.data.id as string;
  }

  async function save(
    client: SupabaseClient,
    runId: string,
    p: Record<string, unknown>,
    backExt: string | null = null,
  ) {
    const result = await client.rpc("save_confirmed_slab_from_analysis", {
      p_analysis_run_id: runId,
      p,
      p_front_ext: "jpg",
      p_back_ext: backExt,
    });
    const data = (result.data ?? null) as SaveResult | null;
    if (data?.slab_id) slabs.add(data.slab_id);
    return { data, error: result.error };
  }

  async function linkedSlab(runId: string) {
    const result = await service.from("ai_analysis_runs").select("slab_id").eq("id", runId).single();
    if (result.error) throw result.error;
    return result.data.slab_id as string | null;
  }

  const correct = (client: SupabaseClient, slabId: string | null, corrections: unknown, key: string | null) =>
    client.rpc("correct_slab_identification", {
      p_slab_id: slabId,
      p_corrections: corrections,
      p_idempotency_key: key,
    });

  beforeAll(async () => {
    service = createClient(URL_!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `boundary-service-${stamp}` },
    });
    const a = await makeUser("boundary-alice");
    const b = await makeUser("boundary-bob");
    const adm = await makeUser("boundary-admin", { graded_card_value_admin: true });
    aliceId = a.id;
    alice = a.client;
    bobId = b.id;
    bob = b.client;
    adminId = adm.id;
    admin = adm.client;
    const adminRow = await service.from("slab_admins").upsert({ user_id: adminId });
    if (adminRow.error) throw adminRow.error;
  }, 120_000);

  afterAll(async () => {
    for (const id of runs) {
      await service.from("ai_field_evidence").delete().eq("analysis_run_id", id);
      await service.from("ai_analysis_runs").delete().eq("id", id);
    }
    for (const id of slabs) await service.from("slabs").delete().eq("id", id);
    if (adminId) await service.from("slab_admins").delete().eq("user_id", adminId);
    for (const id of users) {
      const deleted = await service.auth.admin.deleteUser(id);
      if (deleted.error) throw deleted.error;
    }
  }, 120_000);

  it("leaves the duplicate run unlinked", async () => {
    const p = payload();
    await save(alice, await insertRun(aliceId), p);
    const duplicateRun = await insertRun(aliceId);
    expect((await save(alice, duplicateRun, p)).data?.result).toBe("duplicate_certification");
    expect(await linkedSlab(duplicateRun)).toBeNull();
  });

  it("writes no save audit for the duplicate run", async () => {
    const p = payload();
    await save(alice, await insertRun(aliceId), p);
    const duplicateRun = await insertRun(aliceId);
    await save(alice, duplicateRun, p);
    const rows = await service
      .from("audit_log")
      .select("id")
      .eq("action", "slab.save_confirmed_from_analysis")
      .contains("detail", { analysis_run_id: duplicateRun });
    expect(rows.error).toBeNull();
    expect(rows.data ?? []).toHaveLength(0);
  });

  it("keeps inventory identity stable across replay", async () => {
    const run = await insertRun(aliceId);
    const p = payload();
    const first = await save(alice, run, p);
    const replay = await save(alice, run, p);
    expect(replay.data?.inventory_number).toBe(first.data?.inventory_number);
    expect(replay.data?.inventory_code).toBe(first.data?.inventory_code);
  });

  it("does not expose image paths across owners", async () => {
    const created = await save(alice, await insertRun(aliceId), payload(), "jpg");
    const result = await bob
      .from("slabs")
      .select("id,front_image_path,back_image_path")
      .eq("id", created.data!.slab_id);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("leaves the run unlinked after an invalid back extension", async () => {
    const run = await insertRun(aliceId);
    const result = await save(alice, run, payload(), "exe");
    expect(result.error).not.toBeNull();
    expect(await linkedSlab(run)).toBeNull();
  });

  it("rejects reuse of one idempotency key for another slab", async () => {
    const first = await save(alice, await insertRun(aliceId), payload());
    const second = await save(alice, await insertRun(aliceId), payload());
    const key = `conflict-${stamp}`;
    expect((await correct(alice, first.data!.slab_id, { card_name: "First" }, key)).data).toMatchObject({ ok: true });
    expect((await correct(alice, second.data!.slab_id, { card_name: "Second" }, key)).data).toMatchObject({
      ok: false,
      error: "idempotency_conflict",
    });
  });

  it("normalizes whitespace around an idempotency key", async () => {
    const created = await save(alice, await insertRun(aliceId), payload());
    const key = `trimmed-${stamp}`;
    const first = await correct(alice, created.data!.slab_id, { variation: "Holo" }, `  ${key}  `);
    const replay = await correct(alice, created.data!.slab_id, { variation: "Holo" }, key);
    expect(first.data).toMatchObject({ ok: true, replayed: false });
    expect(replay.data).toMatchObject({ ok: true, replayed: true });
  });

  it("rejects a null correction payload", async () => {
    const created = await save(alice, await insertRun(aliceId), payload());
    expect((await correct(alice, created.data!.slab_id, null, null)).data).toMatchObject({
      ok: false,
      error: "corrections_object_required",
    });
  });

  it("rejects an array correction payload", async () => {
    const created = await save(alice, await insertRun(aliceId), payload());
    expect((await correct(alice, created.data!.slab_id, [], null)).data).toMatchObject({
      ok: false,
      error: "corrections_object_required",
    });
  });

  it("rejects a null slab id", async () => {
    expect((await correct(alice, null, { card_name: "x" }, null)).data).toMatchObject({
      ok: false,
      error: "slab_required",
    });
  });

  it("refuses corrections from a suspended account", async () => {
    const created = await save(bob, await insertRun(bobId), payload());
    await service.from("customer_profiles").update({ account_status: "suspended" }).eq("id", bobId);
    try {
      expect((await correct(bob, created.data!.slab_id, { card_name: "x" }, null)).data).toMatchObject({
        ok: false,
        error: "account_suspended",
      });
    } finally {
      await service.from("customer_profiles").update({ account_status: "active" }).eq("id", bobId);
    }
  });

  it("refuses corrections from a closed account", async () => {
    const created = await save(bob, await insertRun(bobId), payload());
    await service.from("customer_profiles").update({ account_status: "closed" }).eq("id", bobId);
    try {
      expect((await correct(bob, created.data!.slab_id, { card_name: "x" }, null)).data).toMatchObject({
        ok: false,
        error: "account_closed",
      });
    } finally {
      await service.from("customer_profiles").update({ account_status: "active" }).eq("id", bobId);
    }
  });

  it("lets an administrator correct their own slab", async () => {
    const created = await save(admin, await insertRun(adminId), payload());
    const result = await correct(admin, created.data!.slab_id, { card_name: "Admin Corrected" }, `admin-${stamp}`);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: true, replayed: false });
  });

  it("does not let an administrator correct another owner's slab", async () => {
    const created = await save(alice, await insertRun(aliceId), payload());
    expect((await correct(admin, created.data!.slab_id, { card_name: "Admin Theft" }, `admin-cross-${stamp}`)).data).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("writes a minimal correction audit detail", async () => {
    const created = await save(alice, await insertRun(aliceId), payload());
    const key = `audit-${stamp}`;
    await correct(alice, created.data!.slab_id, { card_name: "Audited", variation: "Reverse Holo" }, key);
    const audit = await service
      .from("audit_log")
      .select("detail,source,actor_user_id,owner_id")
      .eq("action", "slab.identification_corrected")
      .eq("entity_id", created.data!.slab_id)
      .single();
    expect(audit.error).toBeNull();
    expect(Object.keys(audit.data!.detail as object).sort()).toEqual([
      "corrected_fields",
      "idempotency_key_present",
      "slab_id",
    ]);
    expect(audit.data).toMatchObject({
      source: "rpc:correct_slab_identification",
      actor_user_id: aliceId,
      owner_id: aliceId,
    });
  });

  it("never surfaces a raw 23505 for duplicate certification", async () => {
    const p = payload();
    await save(alice, await insertRun(aliceId), p);
    const duplicate = await save(alice, await insertRun(aliceId), p);
    expect(duplicate.error).toBeNull();
    expect(duplicate.data?.result).toBe("duplicate_certification");
  });
});
