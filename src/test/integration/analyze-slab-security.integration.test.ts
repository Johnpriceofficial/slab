/**
 * LIVE integration tests for the 20260905000000 analyze-slab hardening:
 * customer-safe link_ai_analysis_run and per-user quota enforcement.
 *
 * Same env gating as every other integration suite: runs only against the
 * disposable test stack (SLABVAULT_TEST_*), never production.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { grantAdministrator } from "./support/admin-role";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ??
  {}) as Record<string, string | undefined>;

const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

function slabInput(overrides: Record<string, unknown> = {}) {
  return {
    card_name: "Charizard",
    grader: "PSA",
    grade: "9",
    certification_number: "77777777",
    set_name: "Base Set",
    card_number: "4",
    year: 1999,
    language: "English",
    final_value_cents: 12500,
    verification_status: "verified",
    valuation_confidence: "manual",
    valuation_provenance: "manual_value",
    ...overrides,
  };
}

suite("analyze-slab security hardening (link RPC + per-user quota)", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let adminClient: SupabaseClient;
  let anonClient: SupabaseClient;
  let aliceId = "";
  let bobId = "";
  let aliceSlabId = "";
  let bobSlabId = "";
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const runIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  async function makeUser(tag: string, isAdmin: boolean): Promise<{ client: SupabaseClient; id: string }> {
    const email = `${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: isAdmin ? { graded_card_value_admin: true } : {},
    });
    if (error) throw error;
    const id = data.user!.id;
    userIds.push(id);
    if (isAdmin) await grantAdministrator(service, id);
    const client = createClient(URL!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `asec-${tag}-${stamp}` },
    });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    return { client, id };
  }

  async function createSlab(client: SupabaseClient, cert: string): Promise<string> {
    const { data, error } = await client.rpc("create_slab", {
      p: slabInput({ certification_number: cert }),
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    slabIds.push(row.id);
    return row.id;
  }

  async function insertRun(fields: Record<string, unknown>): Promise<string> {
    const { data, error } = await service
      .from("ai_analysis_runs")
      .insert({
        provider: "OPENAI",
        model: "test-model",
        schema_version: "test",
        analysis_type: "multi_pass_slab_identity",
        status: "succeeded",
        structured_result: {},
        ...fields,
      })
      .select("id")
      .single();
    if (error) throw error;
    runIds.push(data.id);
    return data.id;
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `asec-svc-${stamp}` },
    });
    anonClient = createClient(URL!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `asec-anon-${stamp}` },
    });
    const a = await makeUser("asec-alice", false);
    const b = await makeUser("asec-bob", false);
    const adm = await makeUser("asec-admin", true);
    alice = a.client;
    aliceId = a.id;
    bob = b.client;
    bobId = b.id;
    adminClient = adm.client;
    aliceSlabId = await createSlab(alice, "70000001");
    bobSlabId = await createSlab(bob, "70000002");
  }, 60_000);

  afterAll(async () => {
    for (const id of runIds) {
      await service.from("ai_field_evidence").delete().eq("analysis_run_id", id);
      await service.from("ai_analysis_runs").delete().eq("id", id);
    }
    for (const id of slabIds) await service.from("slabs").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("links an owned, succeeded run (and its evidence) to an owned slab", async () => {
    const runId = await insertRun({ owner_id: aliceId });
    await service.from("ai_field_evidence").insert({
      analysis_run_id: runId,
      owner_id: aliceId,
      field_name: "card_name",
      value: "Charizard",
      confidence: 0.9,
    });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).toBeNull();
    const { data: run } = await service.from("ai_analysis_runs").select("slab_id, owner_id").eq("id", runId).single();
    expect(run?.slab_id).toBe(aliceSlabId);
    expect(run?.owner_id).toBe(aliceId);
    const { data: evidence } = await service.from("ai_field_evidence").select("slab_id").eq("analysis_run_id", runId);
    expect(evidence?.every((row) => row.slab_id === aliceSlabId)).toBe(true);
  });

  it("rejects re-linking an already-linked run", async () => {
    const runId = await insertRun({ owner_id: aliceId });
    await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("55000");
  });

  it("Account B cannot link Account A's run (and vice versa)", async () => {
    const aliceRun = await insertRun({ owner_id: aliceId });
    const bobRun = await insertRun({ owner_id: bobId });

    const asBob = await bob.rpc("link_ai_analysis_run", { p_run_id: aliceRun, p_slab_id: bobSlabId });
    expect(asBob.error).not.toBeNull();
    expect(asBob.error?.code).toBe("42501");

    const asAlice = await alice.rpc("link_ai_analysis_run", { p_run_id: bobRun, p_slab_id: aliceSlabId });
    expect(asAlice.error).not.toBeNull();
    expect(asAlice.error?.code).toBe("42501");
  });

  it("rejects linking an owned run to a foreign slab", async () => {
    const runId = await insertRun({ owner_id: aliceId });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: bobSlabId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("rejects an ownerless run for a customer", async () => {
    const runId = await insertRun({ owner_id: null });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("rejects a missing run and a missing slab distinctly", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const missingRun = await alice.rpc("link_ai_analysis_run", { p_run_id: ghost, p_slab_id: aliceSlabId });
    expect(missingRun.error?.code).toBe("P0002");
    const someRun = await insertRun({ owner_id: aliceId });
    const missingSlab = await alice.rpc("link_ai_analysis_run", { p_run_id: someRun, p_slab_id: ghost });
    expect(missingSlab.error?.code).toBe("P0002");
  });

  it("rejects a run that is not in a linkable status", async () => {
    const runId = await insertRun({ owner_id: aliceId, status: "running" });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("55000");
  });

  it("rejects evidence whose owner does not match the run owner", async () => {
    const runId = await insertRun({ owner_id: aliceId });
    await service.from("ai_field_evidence").insert({
      analysis_run_id: runId,
      owner_id: bobId, // deliberately mismatched
      field_name: "grade",
      value: "9",
      confidence: 0.9,
    });
    const { error } = await alice.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("denies anonymous callers entirely", async () => {
    const runId = await insertRun({ owner_id: aliceId });
    const { error } = await anonClient.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: aliceSlabId });
    expect(error).not.toBeNull();
  });

  it("preserves explicitly authorized admin linking", async () => {
    const runId = await insertRun({ owner_id: bobId });
    const { error } = await adminClient.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: bobSlabId });
    expect(error).toBeNull();
    const { data: run } = await service.from("ai_analysis_runs").select("slab_id, owner_id").eq("id", runId).single();
    expect(run?.slab_id).toBe(bobSlabId);
    expect(run?.owner_id).toBe(bobId);
  });

  it("enforces the per-user daily quota and fails closed for inactive accounts", async () => {
    const q = await makeUser("asec-quota", false);
    const bucket = `analyze-slab-test-${stamp}`;
    const consume = () =>
      service.rpc("consume_user_daily_quota", { p_user_id: q.id, p_bucket: bucket, p_hard_limit: 2 });

    expect((await consume()).data).toBe(true);
    expect((await consume()).data).toBe(true);
    expect((await consume()).data).toBe(false); // hard limit reached

    await service.from("customer_profiles").update({ account_status: "suspended" }).eq("id", q.id);
    const suspended = await service.rpc("consume_user_daily_quota", {
      p_user_id: q.id,
      p_bucket: `${bucket}-b`,
      p_hard_limit: 2,
    });
    expect(suspended.data).toBe(false); // inactive profiles never consume
  });
});
