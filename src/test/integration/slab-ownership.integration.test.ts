/**
 * LIVE cross-account RLS tests for customer-owned slab inventories.
 *
 * These prove the boundary that the 20260803000000_customer_slab_ownership
 * migration establishes: Customer A and Customer B are strangers. B must not be
 * able to read, write, archive, price, confirm, or even *learn of the existence
 * of* A's slabs, images, valuation records, or scan intake — while an admin
 * still sees everything.
 *
 * Runs ONLY against a dedicated, disposable test project (same env gating as
 * slabvault.integration.test.ts); otherwise the suite is skipped so `bun run
 * test` stays green and nothing ever touches production.
 *
 *   SLABVAULT_TEST_URL=… SLABVAULT_TEST_ANON_KEY=… SLABVAULT_TEST_SERVICE_KEY=… \
 *     bunx vitest run src/test/integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ??
  {}) as Record<string, string | undefined>;

const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

function slabInput(overrides: Record<string, unknown> = {}) {
  return {
    card_name: "Charizard",
    grader: "PSA",
    grade: "9",
    certification_number: "88888888",
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

suite("cross-account slab ownership (RLS)", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient; // customer A
  let bob: SupabaseClient; // customer B
  let adminClient: SupabaseClient;
  let aliceId = "";
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  /** app_metadata is the sole admin authority (see public.is_admin). */
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
    const client = createClient(URL!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `own-${tag}-${stamp}` },
    });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    return { client, id };
  }

  let aliceSlabId = "";
  let aliceFrontPath = "";
  let aliceInventoryNumber = 0;

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `own-service-${stamp}` },
    });
    const a = await makeUser("alice", false);
    const b = await makeUser("bob", false);
    const adm = await makeUser("admin", true);
    alice = a.client;
    aliceId = a.id;
    bob = b.client;
    adminClient = adm.client;

    // Alice creates a slab through the ordinary customer intake RPC.
    const { data, error } = await alice.rpc("create_slab", {
      p: slabInput(),
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    aliceSlabId = row.id;
    aliceFrontPath = row.front_image_path;
    aliceInventoryNumber = row.inventory_number;
    slabIds.push(aliceSlabId);
  });

  afterAll(async () => {
    for (const id of slabIds) await service.from("slabs").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("stamps the creating customer as the owner", async () => {
    const { data } = await service.from("slabs").select("owner_id").eq("id", aliceSlabId).single();
    expect(data!.owner_id).toBe(aliceId);
  });

  it("lets the owner read their own slab", async () => {
    const { data, error } = await alice.from("slabs").select("id").eq("id", aliceSlabId).maybeSingle();
    expect(error).toBeNull();
    expect(data?.id).toBe(aliceSlabId);
  });

  it("hides Customer A's slab from Customer B entirely", async () => {
    // Not "permission denied" — the row is simply not there. B cannot even learn
    // it exists.
    const { data, error } = await bob.from("slabs").select("id").eq("id", aliceSlabId).maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();

    const { data: all } = await bob.from("slabs").select("id");
    expect(all ?? []).toHaveLength(0);
  });

  it("stops Customer B updating or deleting Customer A's slab", async () => {
    const { data: updated } = await bob
      .from("slabs")
      .update({ card_name: "HACKED" })
      .eq("id", aliceSlabId)
      .select("id");
    expect(updated ?? []).toHaveLength(0);

    await bob.from("slabs").delete().eq("id", aliceSlabId);
    const { data: still } = await service.from("slabs").select("card_name").eq("id", aliceSlabId).single();
    expect(still!.card_name).toBe("Charizard"); // untouched
  });

  it("refuses Customer B's archive / pricing / confirmation RPCs on Customer A's slab", async () => {
    const archive = await bob.rpc("archive_slab", { p_id: aliceSlabId });
    expect(archive.error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);

    const pricing = await bob.rpc("apply_slab_pricing", {
      p_slab_id: aliceSlabId,
      p_tiers: {},
      p_raw: {},
      p_priced_at: new Date().toISOString(),
      p_scalars: null,
    });
    expect(pricing.error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);

    const confirmation = await bob.rpc("record_pricecharting_confirmation", {
      p_slab_id: aliceSlabId,
      p_patch: {},
      p_event: { event_type: "product_confirmed", source: "search_manual" },
    });
    expect(confirmation.error?.message ?? "").toMatch(/not authorized/i);
  });

  it("lets the owner archive their own slab", async () => {
    const { error } = await alice.rpc("archive_slab", { p_id: aliceSlabId });
    expect(error).toBeNull();
    await alice.rpc("unarchive_slab", { p_id: aliceSlabId });
  });

  it("hides Customer A's images, valuation records, and evidence from Customer B", async () => {
    // Seed child records as the service role so they exist regardless of the
    // client write path, then assert B cannot see any of them.
    await service.from("slab_images").insert({
      slab_id: aliceSlabId,
      image_role: "front",
      storage_path: aliceFrontPath,
      mime_type: "image/jpeg",
      width: 800,
      height: 1120,
      sha256: "a".repeat(64),
      is_original: true,
    });

    for (const table of ["slab_images", "slab_comps", "valuation_snapshots", "slab_product_links", "ai_field_evidence", "slab_pricecharting_events"]) {
      const { data, error } = await bob.from(table).select("*").eq("slab_id", aliceSlabId);
      expect(error, `${table} should not error for B`).toBeNull();
      expect(data ?? [], `${table} must be empty for B`).toHaveLength(0);
    }

    // The owner does see her own image row.
    const { data: mine } = await alice.from("slab_images").select("id").eq("slab_id", aliceSlabId);
    expect((mine ?? []).length).toBeGreaterThan(0);
  });

  it("stops Customer B reading Customer A's slab image from storage", async () => {
    const { data, error } = await bob.storage.from("slab-images").createSignedUrl(aliceFrontPath, 60);
    expect(data?.signedUrl ?? null).toBeNull();
    expect(error).not.toBeNull();
  });

  it("never leaks Customer A's certification through the duplicate check", async () => {
    // B checks the very cert A owns: it must look completely unused to B.
    const { data } = await bob.rpc("check_slab_certification", { p_grader: "PSA", p_cert: "88888888" });
    expect(Array.isArray(data) ? data : data ? [data] : []).toHaveLength(0);

    // …and A still sees her own.
    const { data: own } = await alice.rpc("check_slab_certification", { p_grader: "PSA", p_cert: "88888888" });
    const ownRows = Array.isArray(own) ? own : own ? [own] : [];
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0].inventory_number).toBe(aliceInventoryNumber);
  });

  it("lets Customer B hold the same certification in their own inventory", async () => {
    // Per-owner uniqueness: the same physical cert string in a different account
    // is not a duplicate, and B is never told A's inventory number.
    const { data, error } = await bob.rpc("create_slab", {
      p: slabInput({ certification_number: "88888888" }),
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.id).not.toBe(aliceSlabId);
    slabIds.push(row.id);

    // But a genuine duplicate WITHIN B's own inventory is still rejected.
    const dup = await bob.rpc("create_slab", {
      p: slabInput({ certification_number: "88888888" }),
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    expect(dup.error?.message ?? "").toMatch(/DUPLICATE_CERTIFICATION/i);
  });

  it("keeps scan intake owner-isolated", async () => {
    const { data } = await bob.from("card_scans").select("id").eq("created_by", aliceId);
    expect(data ?? []).toHaveLength(0);
  });

  it("still lets an admin see every customer's slabs", async () => {
    const { data, error } = await adminClient.from("slabs").select("id").eq("id", aliceSlabId).maybeSingle();
    expect(error).toBeNull();
    expect(data?.id).toBe(aliceSlabId);
  });

  it("keeps marketplace tables admin-only for customers", async () => {
    const { data } = await bob.from("pricecharting_offers").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});
