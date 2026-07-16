/**
 * LIVE Supabase integration — valuation-status INTEGRITY (migration 20260809000000).
 *
 * Proves the capture trigger decides exact_api_tier from the CURRENT evidence in
 * pricecharting_raw (tier_availability / designation_exact / guide_value_cents),
 * never from the valuation_provenance string, and CLEARS stale provider scalars
 * when the evidence no longer supports a trusted value. Env-gated like the rest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("valuation-status integrity (evidence-based exact_api_tier)", () => {
  let admin: SupabaseClient;
  let adminClient: SupabaseClient;
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;
  let t = Date.parse("2026-07-16T00:00:00Z");
  const nextTs = () => new Date((t += 60_000)).toISOString();

  const scalars = (over: Record<string, unknown> = {}) => ({
    product_id: "5327894", product_name: "Gyarados V #20", grade_field: "condition-19-price",
    sales_volume: null, match_status: "exact", apply_value: true, value_cents: 3432, variance: 0,
    apply_provenance: true, valuation_provenance: "pricecharting_exact_tier", valuation_confidence: "high", ...over,
  });
  const tiers = (retrieved_at: string) => ({ source: "PriceCharting", retrieved_at, tiers: [] });

  async function price(id: string, raw: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const ts = nextTs();
    const r = await adminClient.rpc("apply_slab_pricing", {
      p_slab_id: id, p_tiers: tiers(ts), p_raw: raw, p_priced_at: ts, p_scalars: scalars(over),
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(true);
  }
  async function statusOf(id: string) {
    const { data } = await admin.from("slabs")
      .select("valuation_status, pricecharting_value_cents, final_value_cents, quick_sale_value_cents, replacement_value_cents")
      .eq("id", id).single();
    return data as Record<string, unknown>;
  }

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "vi-svc" } });
    const email = `vintegrity+${stamp}@slabvault.test`;
    const password = "Test-" + email;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    if (error) throw error;
    userIds.push(data.user!.id);
    await admin.from("slab_admins").insert({ user_id: data.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "vi-admin" } });
    await adminClient.auth.signInWithPassword({ email, password });
  });
  afterAll(async () => {
    for (const id of slabIds) await admin.from("slabs").delete().eq("id", id);
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  async function makeSlab(cert: string) {
    const { data, error } = await adminClient.rpc("create_slab", {
      p: { card_name: "Gyarados V", grader: "CGC", grade: "10", grade_label: "PRISTINE", certification_number: cert,
        set_name: "Pokemon Japanese Blue Sky Stream", card_number: "020/067", language: "Japanese",
        final_value_cents: 3432, verification_status: "verified", valuation_confidence: "high", valuation_provenance: "pricecharting_exact_tier" },
      p_front_ext: "jpg", p_back_ext: "png",
    });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    slabIds.push(row.id);
    return row.id as string;
  }

  it("exact provenance + full evidence → exact_api_tier, value kept", async () => {
    const id = await makeSlab(`VI${stamp}A`);
    await price(id, { tier_availability: "available", designation_exact: true, guide_value_cents: 3432, available_values_cents: { cgc_10_pristine: 3432 }, reference_artwork: { image_url: "https://storage.googleapis.com/images.pricecharting.com/x/240.jpg", image_source: "pricecharting_public_page_product_image" }, public_page: { identity_status: "VERIFIED" } });
    const s = await statusOf(id);
    expect(s.valuation_status).toBe("exact_api_tier");
    expect(s.pricecharting_value_cents).toBe(3432);
  });

  it("exact provenance but tier_availability=tier_unavailable → needs_review, scalars CLEARED", async () => {
    const id = await makeSlab(`VI${stamp}B`);
    await price(id, { tier_availability: "available", designation_exact: true, guide_value_cents: 3432, public_page: { identity_status: "VERIFIED" } });
    expect((await statusOf(id)).valuation_status).toBe("exact_api_tier");
    // A later read finds the exact tier unavailable — the stale scalar must NOT survive as exact.
    await price(id, { tier_availability: "tier_unavailable", designation_exact: false, guide_value_cents: null }, { value_cents: 3432 });
    const s = await statusOf(id);
    expect(s.valuation_status).toBe("needs_review");
    expect(s.pricecharting_value_cents).toBeNull();
    expect(s.final_value_cents).toBeNull();
    expect(s.quick_sale_value_cents).toBeNull();
    expect(s.replacement_value_cents).toBeNull();
  });

  it("exact provenance + designation_exact=false → needs_review (no false exact)", async () => {
    const id = await makeSlab(`VI${stamp}C`);
    await price(id, { tier_availability: "available", designation_exact: false, guide_value_cents: 1913 });
    expect((await statusOf(id)).valuation_status).toBe("needs_review");
  });

  it("persists reference artwork + tier snapshot; last_verified_at only when page VERIFIED", async () => {
    const id = await makeSlab(`VI${stamp}D`);
    await price(id, { tier_availability: "available", designation_exact: true, guide_value_cents: 3432, available_values_cents: { cgc_10_pristine: 3432, cgc_10: 1913 }, reference_artwork: { image_url: "https://storage.googleapis.com/images.pricecharting.com/y/240.jpg", image_source: "pricecharting_public_page_product_image" }, public_page: { identity_status: "VERIFIED" } });
    const { data: p } = await admin.from("pricecharting_products")
      .select("reference_image_url, reference_image_source, tier_snapshot, last_verified_at, provider_evidence_at")
      .eq("product_id", "5327894").single();
    const prod = p as Record<string, unknown>;
    expect(prod.reference_image_url).toContain("pricecharting.com");
    expect((prod.tier_snapshot as Record<string, number>).cgc_10_pristine).toBe(3432);
    expect(prod.last_verified_at).not.toBeNull(); // page identity VERIFIED
    expect(prod.provider_evidence_at).not.toBeNull();
  });
});
