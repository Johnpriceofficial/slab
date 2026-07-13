/**
 * LIVE Supabase integration tests. These run ONLY when pointed at a dedicated
 * SlabVault test project via env vars; otherwise the whole suite is skipped so
 * `bun run test` stays green and NOTHING ever runs against a production (e.g.
 * party-rental) project.
 *
 * Required env (set to a DEDICATED, disposable SlabVault project only):
 *   SLABVAULT_TEST_URL           https://<ref>.supabase.co
 *   SLABVAULT_TEST_ANON_KEY      anon/public key
 *   SLABVAULT_TEST_SERVICE_KEY   service-role key (used only to seed users/admins)
 *
 * Run:  SLABVAULT_TEST_URL=… SLABVAULT_TEST_ANON_KEY=… SLABVAULT_TEST_SERVICE_KEY=… \
 *         bunx vitest run src/test/integration
 *
 * Coverage: admin authorization, non-admin rejection, grader-scoped composite
 * duplicate cert, leading-zero preservation, concurrent slab creation → unique
 * numbers, global PriceCharting request spacing (≥1s), storage MIME + size
 * enforcement, and archive / hard-delete cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ??
  {}) as Record<string, string | undefined>;

const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);

// Guard: never let this run against a project whose ref looks like production.
const looksProd = /joyrent|party|rhodeisland|mycousin|prod/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

if (LIVE && looksProd) {
  console.warn("[integration] Refusing to run: SLABVAULT_TEST_URL looks like a production project.");
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    card_name: "Charizard",
    grader: "PSA",
    grade: "9",
    certification_number: "12345678",
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

suite("SlabVault live integration", () => {
  // Created in beforeAll (NOT at collection time — a skipped suite still runs its
  // factory, and createClient(undefined) would throw).
  let admin: SupabaseClient; // service role: seeds users, bypasses RLS
  let adminClient: SupabaseClient; // signed-in ADMIN user (JWT)
  let userClient: SupabaseClient; // signed-in NON-admin user (JWT)
  let anonClient: SupabaseClient; // no session: verifies PUBLIC/anon cannot execute definer RPCs
  const createdUserIds: string[] = [];
  const createdSlabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  async function makeUser(email: string, makeAdmin: boolean): Promise<SupabaseClient> {
    const password = "Test-" + email;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    if (makeAdmin) {
      const { error: e } = await admin.from("slab_admins").insert({ user_id: data.user!.id });
      if (e) throw e;
    }
    // Each client gets its OWN isolated, non-persisted auth store. Under jsdom a
    // shared global localStorage would otherwise let one sign-in clobber the
    // other's session (admin RPCs would then carry the non-admin token).
    const client = createClient(URL!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `sbtest-${email}` },
    });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: "sbtest-service" },
    });
    adminClient = await makeUser(`admin+${stamp}@slabvault.test`, true);
    userClient = await makeUser(`user+${stamp}@slabvault.test`, false);
    anonClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  afterAll(async () => {
    for (const id of createdSlabIds) await admin.from("slabs").delete().eq("id", id);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  async function createSlab(client: SupabaseClient, overrides: Record<string, unknown> = {}, backExt: string | null = "png") {
    const { data, error } = await client.rpc("create_slab", {
      p: baseInput(overrides),
      p_front_ext: "jpg",
      p_back_ext: backExt,
    });
    return { data: Array.isArray(data) ? data[0] : data, error };
  }

  it("an admin can create a slab", async () => {
    const { data, error } = await createSlab(adminClient, { certification_number: `A${stamp}1` });
    expect(error).toBeNull();
    expect(data?.inventory_number).toBeGreaterThan(0);
    if (data?.id) createdSlabIds.push(data.id);
  });

  it("creates a front-only incomplete draft while keeping the back image optional", async () => {
    const { data, error } = await createSlab(adminClient, {
      card_name: null,
      grader: null,
      grade: null,
      certification_number: null,
      verification_status: "unverified",
      final_value_cents: null,
      valuation_confidence: null,
      valuation_provenance: "tier_unavailable",
    }, null);
    expect(error).toBeNull();
    expect(data?.front_image_path).toMatch(/\/front\.jpg$/);
    expect(data?.back_image_path).toBeNull();
    if (data?.id) createdSlabIds.push(data.id);
  });

  it.each(["card_name", "grader", "grade", "certification_number"])(
    "rejects a verified record missing %s at the database boundary",
    async (field) => {
      const { error } = await createSlab(adminClient, {
        certification_number: `MISS-${field}-${stamp}`,
        [field]: null,
      });
      expect(error).not.toBeNull();
      expect(String(error?.message)).toMatch(/check constraint|violates/i);
    },
  );

  it("a non-admin is rejected by create_slab", async () => {
    const { error } = await createSlab(userClient, { certification_number: `U${stamp}` });
    expect(error).not.toBeNull();
    expect(String(error?.message)).toMatch(/NOT_AUTHORIZED|permission|denied/i);
  });

  it("rejects a grader-scoped normalized duplicate but allows a different grader", async () => {
    const cert = `DUP${stamp}`;
    const first = await createSlab(adminClient, { grader: "PSA", certification_number: cert });
    expect(first.error).toBeNull();
    if (first.data?.id) createdSlabIds.push(first.data.id);

    // Same grader, whitespace/case variant → duplicate.
    const dup = await createSlab(adminClient, { grader: "psa", certification_number: ` ${cert} ` });
    expect(dup.error).not.toBeNull();
    expect(String(dup.error?.message)).toMatch(/DUPLICATE_CERTIFICATION|duplicate/i);

    // Different grader, same cert → allowed.
    const cgc = await createSlab(adminClient, { grader: "CGC", certification_number: cert });
    expect(cgc.error).toBeNull();
    if (cgc.data?.id) createdSlabIds.push(cgc.data.id);
  });

  it("preserves leading zeros in the certification number", async () => {
    const { data, error } = await createSlab(adminClient, { certification_number: `000${stamp}` });
    expect(error).toBeNull();
    expect(data?.certification_number).toBe(`000${stamp}`);
    if (data?.id) createdSlabIds.push(data.id);
  });

  it("gives concurrent creations distinct, unique inventory numbers", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createSlab(adminClient, { certification_number: `C${stamp}-${i}` })),
    );
    const nums: number[] = [];
    for (const r of results) {
      expect(r.error).toBeNull();
      if (r.data?.id) createdSlabIds.push(r.data.id);
      nums.push(r.data.inventory_number);
    }
    expect(new Set(nums).size).toBe(5); // all unique
  });

  it("spaces global PriceCharting reservations at least ~1s apart", async () => {
    const bucket = `pc-test-${stamp}`;
    const a = await admin.rpc("reserve_api_request_slot", { p_bucket: bucket, p_min_interval_ms: 1000 });
    const b = await admin.rpc("reserve_api_request_slot", { p_bucket: bucket, p_min_interval_ms: 1000 });
    const ta = new Date(a.data as string).getTime();
    const tb = new Date(b.data as string).getTime();
    expect(tb - ta).toBeGreaterThanOrEqual(950); // ≥ ~1s
    await admin.from("api_rate_limits").delete().eq("bucket", bucket);
  });

  it("enforces a durable daily quota via consume_daily_quota", async () => {
    const bucket = `quota-test-${stamp}`;
    const r1 = await admin.rpc("consume_daily_quota", { p_bucket: bucket, p_limit: 2 });
    const r2 = await admin.rpc("consume_daily_quota", { p_bucket: bucket, p_limit: 2 });
    const r3 = await admin.rpc("consume_daily_quota", { p_bucket: bucket, p_limit: 2 });
    expect(r1.data).toBe(true);
    expect(r2.data).toBe(true);
    expect(r3.data).toBe(false); // 3rd call over the limit of 2 → denied, no increment
    await admin.from("api_daily_usage").delete().eq("bucket", bucket);
  });

  it("enforces storage MIME + size limits on the private bucket", async () => {
    // Unsupported MIME rejected.
    const gif = new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: "image/gif" });
    const badMime = await adminClient.storage.from("slab-images").upload(`test/${stamp}/x.gif`, gif, { contentType: "image/gif" });
    expect(badMime.error).not.toBeNull();

    // Oversized (>15MB) rejected.
    const big = new Blob([new Uint8Array(16 * 1024 * 1024)], { type: "image/png" });
    const tooBig = await adminClient.storage.from("slab-images").upload(`test/${stamp}/big.png`, big, { contentType: "image/png" });
    expect(tooBig.error).not.toBeNull();
  });

  it("archives (preserving the number) and hard-deletes with cleanup", async () => {
    const created = await createSlab(adminClient, { certification_number: `ARCH${stamp}` });
    expect(created.error).toBeNull();
    const id = created.data.id as string;
    const num = created.data.inventory_number as number;

    const arch = await adminClient.rpc("archive_slab", { p_id: id });
    const archRow = Array.isArray(arch.data) ? arch.data[0] : arch.data;
    expect(arch.error).toBeNull();
    expect(archRow.archived_at).not.toBeNull();
    expect(archRow.inventory_number).toBe(num); // number preserved

    // Hard delete is gated: disabled by default → refused.
    const blocked = await adminClient.rpc("hard_delete_slab", { p_id: id });
    expect(blocked.error).not.toBeNull();
    expect(String(blocked.error?.message)).toMatch(/HARD_DELETE_DISABLED/i);

    // Enable the server-side flag (admin-only), then hard delete succeeds.
    await admin.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const del = await adminClient.rpc("hard_delete_slab", { p_id: id });
    await admin.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true); // reset
    expect(del.error).toBeNull();
    const { data: gone } = await admin.from("slabs").select("id").eq("id", id).maybeSingle();
    expect(gone).toBeNull();
    // (already deleted — don't double-clean)
  });

  it("apply_slab_pricing: atomic tiers+scalars, stale guard, and hand-entered-guide preservation", async () => {
    const created = await createSlab(adminClient, {
      certification_number: `PC${stamp}`,
      final_value_cents: 4250,
      pricecharting_value_cents: 4250,
      valuation_provenance: "pricecharting_exact_tier",
      valuation_confidence: "high",
    });
    expect(created.error).toBeNull();
    const id = created.data.id as string;
    createdSlabIds.push(id);

    const tiers = (retrieved_at: string) => ({
      source: "PriceCharting",
      retrieved_at,
      tiers: [{ tier: "ungraded", label: "Ungraded", grader: null, grade: null, designation: null, value_cents: 413, available: true, exact_match: false, source: "PriceCharting" }],
    });
    const t1 = new Date().toISOString();

    // 1. Happy path (proves the old `boolean > integer` bug is gone): applied=true,
    //    columns written atomically.
    const applied1 = await adminClient.rpc("apply_slab_pricing", {
      p_slab_id: id, p_tiers: tiers(t1), p_raw: { ok: true }, p_priced_at: t1,
      p_scalars: { product_id: "5427932", product_name: "Charmander #289/S-P", grade_field: "condition-17-price", sales_volume: 3, match_status: "exact", apply_value: true, value_cents: 5000, variance: -15, apply_provenance: true, valuation_provenance: "pricecharting_exact_tier", valuation_confidence: "high" },
    });
    expect(applied1.error).toBeNull();
    expect(applied1.data).toBe(true);
    const { data: row1 } = await admin.from("slabs").select("pricecharting_value_cents, pricecharting_product_id, price_variance_percent, pricecharting_tiers").eq("id", id).single();
    expect(row1.pricecharting_value_cents).toBe(5000);
    expect(row1.pricecharting_product_id).toBe("5427932");
    expect(Number(row1.price_variance_percent)).toBe(-15);
    expect(row1.pricecharting_tiers.tiers[0].value_cents).toBe(413);

    // 2. Stale guard: an OLDER retrieved_at is rejected wholesale — no scalar clobber.
    const older = new Date(Date.parse(t1) - 60_000).toISOString();
    const applied2 = await adminClient.rpc("apply_slab_pricing", {
      p_slab_id: id, p_tiers: tiers(older), p_raw: null, p_priced_at: older,
      p_scalars: { product_id: "OLD", product_name: "stale", grade_field: null, sales_volume: null, match_status: "likely", apply_value: true, value_cents: 9999, variance: 0, apply_provenance: true, valuation_provenance: "pricecharting_estimate", valuation_confidence: "moderate" },
    });
    expect(applied2.data).toBe(false);
    const { data: row2 } = await admin.from("slabs").select("pricecharting_value_cents, pricecharting_product_id").eq("id", id).single();
    expect(row2.pricecharting_value_cents).toBe(5000); // unchanged
    expect(row2.pricecharting_product_id).toBe("5427932"); // scalar NOT clobbered by the stale write

    // 3. A manual guide is preserved while linked metadata/tier comparisons refresh.
    await admin.from("slabs").update({
      pricecharting_value_cents: 4250,
      valuation_provenance: "manual_guide",
      valuation_confidence: "manual",
    }).eq("id", id);
    const t3 = new Date(Date.parse(t1) + 60_000).toISOString();
    const applied3 = await adminClient.rpc("apply_slab_pricing", {
      p_slab_id: id, p_tiers: tiers(t3), p_raw: null, p_priced_at: t3,
      p_scalars: { product_id: "5427932", product_name: "Refreshed Name", grade_field: null, sales_volume: null, match_status: "likely", apply_value: false, value_cents: null, variance: null, apply_provenance: false, valuation_provenance: null, valuation_confidence: null },
    });
    expect(applied3.data).toBe(true);
    const { data: row3 } = await admin.from("slabs").select("pricecharting_value_cents, pricecharting_product_name").eq("id", id).single();
    expect(row3.pricecharting_value_cents).toBe(4250); // operator guide preserved
    expect(row3.pricecharting_product_name).toBe("Refreshed Name"); // provenance refreshed

    // 4. Non-admin is rejected.
    const denied = await userClient.rpc("apply_slab_pricing", { p_slab_id: id, p_tiers: tiers(new Date().toISOString()), p_raw: null, p_priced_at: new Date().toISOString(), p_scalars: null });
    expect(denied.error).not.toBeNull();
  });

  it("§2 record_pricecharting_confirmation: atomic state+audit, RLS, append-only, CHECK constraints", async () => {
    const created = await createSlab(adminClient, { certification_number: `CONF${stamp}` });
    expect(created.error).toBeNull();
    const id = created.data.id as string;
    createdSlabIds.push(id);

    const patch = (over: Record<string, unknown> = {}) => ({
      candidate_image_url: "https://storage.googleapis.com/images.pricecharting.com/x/240.jpg",
      candidate_image_source: "marketplace_offer",
      candidate_image_type: "marketplace_offer_image",
      candidate_image_retrieved_at: new Date().toISOString(),
      candidate_image_available: true,
      visual_confirmation_status: "user_confirmed",
      visual_confirmation_method: "side_by_side",
      visual_confirmation_at: new Date().toISOString(),
      visual_rejection_reason: null,
      visual_rejection_note: null,
      product_confirmation_source: "search_manual",
      product_confirmed_at: new Date().toISOString(),
      scoring_version: 2,
      ...over,
    });

    // 1. Happy path: slab state written AND one audit event inserted, together.
    const ok = await adminClient.rpc("record_pricecharting_confirmation", {
      p_slab_id: id,
      p_patch: patch(),
      p_event: { event_type: "visual_confirmed", product_id: "5427932", source: "search_manual", detail: { visual_confirmation_status: "user_confirmed" } },
    });
    expect(ok.error).toBeNull();
    const { data: row } = await admin.from("slabs").select("visual_confirmation_status, product_confirmed_at, visual_confirmation_by").eq("id", id).single();
    expect(row.visual_confirmation_status).toBe("user_confirmed");
    expect(row.product_confirmed_at).not.toBeNull();
    expect(row.visual_confirmation_by).not.toBeNull(); // actor stamped server-side
    const { data: events } = await admin.from("slab_pricecharting_events").select("event_type").eq("slab_id", id);
    expect(events!.length).toBe(1);

    // 2. Non-admin is rejected (RLS + explicit is_admin gate).
    const denied = await userClient.rpc("record_pricecharting_confirmation", {
      p_slab_id: id, p_patch: patch(), p_event: { event_type: "visual_confirmed", product_id: "x", source: null, detail: {} },
    });
    expect(denied.error).not.toBeNull();

    // Anonymous/PUBLIC callers do not have EXECUTE at all (before body checks).
    const anonDenied = await anonClient.rpc("record_pricecharting_confirmation", {
      p_slab_id: id, p_patch: patch(), p_event: { event_type: "visual_confirmed", product_id: "x", source: null, detail: {} },
    });
    expect(anonDenied.error).not.toBeNull();
    expect(String(anonDenied.error?.message)).toMatch(/permission denied|function .* does not exist/i);

    // 3. Atomicity: a bad event_type (CHECK violation on the event) rolls the whole
    //    call back — the slab's confirmation status is NOT changed to the new value.
    const before = await admin.from("slabs").select("visual_confirmation_status").eq("id", id).single();
    const rolledBack = await adminClient.rpc("record_pricecharting_confirmation", {
      p_slab_id: id,
      p_patch: patch({ visual_confirmation_status: "user_rejected", visual_rejection_reason: "wrong_card" }),
      p_event: { event_type: "NOT_A_VALID_EVENT", product_id: "x", source: null, detail: {} },
    });
    expect(rolledBack.error).not.toBeNull();
    const after = await admin.from("slabs").select("visual_confirmation_status").eq("id", id).single();
    expect(after.data!.visual_confirmation_status).toBe(before.data!.visual_confirmation_status); // unchanged → rollback

    // 4. CHECK constraint: an invalid enum on the slab column is rejected.
    const badEnum = await adminClient.rpc("record_pricecharting_confirmation", {
      p_slab_id: id, p_patch: patch({ visual_confirmation_status: "totally_made_up" }),
      p_event: { event_type: "visual_confirmed", product_id: "x", source: null, detail: {} },
    });
    expect(badEnum.error).not.toBeNull();

    // 5. Append-only: the events table exposes no UPDATE or DELETE path to an admin user.
    const upd = await adminClient.from("slab_pricecharting_events").update({ event_type: "image_refreshed" }).eq("slab_id", id);
    expect(upd.error ?? upd.count === 0).toBeTruthy();
    const delErr = await adminClient.from("slab_pricecharting_events").delete().eq("slab_id", id);
    expect(delErr.error ?? delErr.count === 0).toBeTruthy();
    const { data: stillThere } = await admin.from("slab_pricecharting_events").select("id").eq("slab_id", id);
    expect(stillThere!.length).toBeGreaterThanOrEqual(1); // history preserved
  });
});
