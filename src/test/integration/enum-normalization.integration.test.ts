import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Regression coverage for 20260812000000_reconcile_production_audit_repairs.sql,
// which re-commits the enum-normalization trigger that was only ever applied
// directly to production (undocumented migration 20260716083710). These tests run
// ONLY against the disposable CI Supabase (skipped on production by looksProd), so
// they prove a database built purely from the repo migrations reproduces the
// production behavior — i.e. the drift is actually closed.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("slab enum-input normalization (production reconciliation)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  async function makeAdmin(): Promise<SupabaseClient> {
    const email = `enum-admin+${stamp}@slabvault.test`;
    const password = `Test-enum-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true },
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    await service.from("slab_admins").insert({ user_id: data.user!.id });
    const client = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `enum-admin-${stamp}` } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    return client;
  }

  async function createSlab(cert: string) {
    const { data, error } = await adminClient.rpc("create_slab", {
      p: {
        card_name: "Enum Norm Test", grader: "PSA", grade: "9", certification_number: cert,
        set_name: "Test Set", card_number: "1", year: 2026, language: "English",
        final_value_cents: 1000, verification_status: "verified",
        valuation_confidence: "manual", valuation_provenance: "manual_value",
      },
      p_front_ext: "jpg", p_back_ext: null,
    });
    expect(error).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as { id: string };
    slabIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `enum-service-${stamp}` } });
    adminClient = await makeAdmin();
  });

  afterAll(async () => {
    if (slabIds.length) await service.from("slabs").delete().in("id", slabIds);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("rewrites candidate_image_type 'catalog_product_image' -> 'official_product_image' before the CHECK constraint", async () => {
    const slab = await createSlab(`ENUM-IMG-${stamp}`);
    // Without the reconciled trigger this update would fail slabs_candidate_image_type_chk (23514),
    // because the constraint only permits marketplace_offer_image / official_product_image.
    const res = await service.from("slabs")
      .update({ candidate_image_type: "catalog_product_image" })
      .eq("id", slab.id).select("candidate_image_type").single();
    expect(res.error).toBeNull();
    expect(res.data?.candidate_image_type).toBe("official_product_image");
  });

  it("normalizes mixed-case / padded inventory_status to the canonical enum value", async () => {
    const slab = await createSlab(`ENUM-STATUS-${stamp}`);
    const res = await service.from("slabs")
      .update({ inventory_status: "  Active  " })
      .eq("id", slab.id).select("inventory_status").single();
    expect(res.error).toBeNull();
    expect(res.data?.inventory_status).toBe("active");
  });

  it("leaves already-valid enum values unchanged (no over-normalization)", async () => {
    const slab = await createSlab(`ENUM-OK-${stamp}`);
    const res = await service.from("slabs")
      .update({ candidate_image_type: "marketplace_offer_image", inventory_status: "listed" })
      .eq("id", slab.id).select("candidate_image_type, inventory_status").single();
    expect(res.error).toBeNull();
    expect(res.data?.candidate_image_type).toBe("marketplace_offer_image");
    expect(res.data?.inventory_status).toBe("listed");
  });
});
