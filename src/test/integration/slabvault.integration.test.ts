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
  // eslint-disable-next-line no-console
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
    ...overrides,
  };
}

suite("SlabVault live integration", () => {
  // Created in beforeAll (NOT at collection time — a skipped suite still runs its
  // factory, and createClient(undefined) would throw).
  let admin: SupabaseClient; // service role: seeds users, bypasses RLS
  let adminClient: SupabaseClient; // signed-in ADMIN user (JWT)
  let userClient: SupabaseClient; // signed-in NON-admin user (JWT)
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
  });

  afterAll(async () => {
    for (const id of createdSlabIds) await admin.from("slabs").delete().eq("id", id);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  async function createSlab(client: SupabaseClient, overrides: Record<string, unknown> = {}) {
    const { data, error } = await client.rpc("create_slab", {
      p: baseInput(overrides),
      p_front_ext: "jpg",
      p_back_ext: "png",
    });
    return { data: Array.isArray(data) ? data[0] : data, error };
  }

  it("an admin can create a slab", async () => {
    const { data, error } = await createSlab(adminClient, { certification_number: `A${stamp}1` });
    expect(error).toBeNull();
    expect(data?.inventory_number).toBeGreaterThan(0);
    if (data?.id) createdSlabIds.push(data.id);
  });

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
    const a = await adminClient.rpc("reserve_api_request_slot", { p_bucket: bucket, p_min_interval_ms: 1000 });
    const b = await adminClient.rpc("reserve_api_request_slot", { p_bucket: bucket, p_min_interval_ms: 1000 });
    const ta = new Date(a.data as string).getTime();
    const tb = new Date(b.data as string).getTime();
    expect(tb - ta).toBeGreaterThanOrEqual(950); // ≥ ~1s
    await admin.from("api_rate_limits").delete().eq("bucket", bucket);
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
});
