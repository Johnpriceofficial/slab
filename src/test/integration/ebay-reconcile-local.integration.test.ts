import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260825000000_ebay_listing_reconcile_local_rpc.sql against
// the disposable CI Supabase: the transactional local-reconciliation RPC proves
// identity + fingerprint under a row lock, writes the mapping AND the intent
// atomically, rejects stale/foreign requests with ZERO writes, rolls back on a
// mid-write failure, and is service_role-only.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("ebay_listing_reconcile_local (atomic, identity+fingerprint-gated, service-only)", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";
  let slabId = "";
  let seq = 0;

  const FP = "fp-canonical";
  const makeIntent = async (sku: string, fingerprint = FP, status = "preparing", imagesSubmittedAt: string | null = null) => {
    const { data } = await service.from("ebay_listing_intents").insert({ ebay_account_id: accountId, slab_id: slabId, sku, fingerprint, fingerprint_version: 3, status, images_submitted_at: imagesSubmittedAt }).select("id").single();
    return data!.id as string;
  };
  const call = (over: Record<string, unknown>) => service.rpc("ebay_listing_reconcile_local", {
    p_account_id: accountId, p_slab_id: slabId, p_sku: "GCV000047", p_intent_id: "", p_offer_id: `O-${seq++}`,
    p_listing_id: "L9", p_listing_status: "published", p_asking_price_cents: 19999, p_currency: "USD",
    p_expected_fingerprint: FP, p_expected_fingerprint_version: 3,
    p_expected_status: null, p_expected_offer_id: null, p_expected_listing_id: null, p_expected_updated_at: null, ...over,
  });

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rl-svc-${stamp}` } });
    const email = `ebay-rl+${stamp}@slabvault.test`;
    const password = `Test-rl-${stamp}`;
    const { data: u } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rl-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });
    const { data: acct } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-rl-${stamp}`, connection_status: "connected" }).select("id").single();
    accountId = acct!.id; accountIds.push(accountId);
    // Create the slab via the RPC (a raw insert would trip owner/trigger rules).
    const { data: slab, error: slabErr } = await adminClient.rpc("create_slab", {
      p: { card_name: "RL Test", grader: "PSA", grade: "9", certification_number: `RL${stamp}`, set_name: "Base Set", card_number: "4", year: 1999, language: "English", final_value_cents: 12500, verification_status: "verified", valuation_confidence: "manual", valuation_provenance: "manual_value" },
      p_front_ext: "jpg", p_back_ext: "png",
    });
    if (slabErr) throw slabErr;
    const slabRow = (Array.isArray(slab) ? slab[0] : slab) as { id: string };
    slabId = slabRow.id;
  });

  afterAll(async () => {
    await service.from("ebay_listing_mappings").delete().eq("ebay_account_id", accountId);
    await service.from("ebay_listing_intents").delete().eq("ebay_account_id", accountId);
    if (slabId) await service.from("slabs").delete().eq("id", slabId);
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("service role: a valid call atomically writes the intent AND the mapping; advances method ONLY with prior provenance", async () => {
    // Prior submission provenance present → method advances to provider_reference_match.
    const id = await makeIntent("GCV000047", FP, "offer_created", "2026-07-20T00:00:00Z");
    const r = await call({ p_sku: "GCV000047", p_intent_id: id });
    expect((r.data as { ok?: boolean }).ok).toBe(true);
    const { data: intent } = await service.from("ebay_listing_intents").select("status, offer_id, images_submitted_at, image_verification_method").eq("id", id).single();
    expect(intent!.status).toBe("published");
    expect(intent!.images_submitted_at).not.toBeNull(); // preserved, NOT fabricated
    expect(intent!.image_verification_method).toBe("provider_reference_match");
    const { data: map } = await service.from("ebay_listing_mappings").select("id, offer_id").eq("ebay_account_id", accountId).eq("sku", "GCV000047").maybeSingle();
    expect(map).not.toBeNull();
  });

  it("NEVER fabricates images_submitted_at: an intent with no prior provenance keeps it null", async () => {
    const id = await makeIntent("GCV000048"); // no images_submitted_at
    const r = await call({ p_sku: "GCV000048", p_intent_id: id });
    expect((r.data as { ok?: boolean }).ok).toBe(true);
    const { data: intent } = await service.from("ebay_listing_intents").select("images_submitted_at, image_verification_method").eq("id", id).single();
    expect(intent!.images_submitted_at).toBeNull();
    expect(intent!.image_verification_method).not.toBe("provider_reference_match");
  });

  it("stale fingerprint → rejected structurally, NO mapping written", async () => {
    const id = await makeIntent("GCV000050");
    const r = await call({ p_sku: "GCV000050", p_intent_id: id, p_expected_fingerprint: "WRONG" });
    expect((r.data as { ok?: boolean; error_code?: string })).toMatchObject({ ok: false, error_code: "fingerprint_mismatch" });
    const { data: map } = await service.from("ebay_listing_mappings").select("id").eq("ebay_account_id", accountId).eq("sku", "GCV000050").maybeSingle();
    expect(map).toBeNull();
  });

  it("wrong account / wrong sku / wrong intent → structured reject, no writes", async () => {
    const id = await makeIntent("GCV000051");
    expect((await call({ p_sku: "GCV000051", p_intent_id: id, p_account_id: "00000000-0000-0000-0000-000000000000" })).data).toMatchObject({ ok: false, error_code: "intent_identity_mismatch" });
    expect((await call({ p_sku: "GCV999999", p_intent_id: id })).data).toMatchObject({ ok: false, error_code: "intent_identity_mismatch" });
    expect((await call({ p_sku: "GCV000051", p_intent_id: "00000000-0000-0000-0000-000000000000" })).data).toMatchObject({ ok: false, error_code: "intent_not_found" });
    const { data: map } = await service.from("ebay_listing_mappings").select("id").eq("ebay_account_id", accountId).eq("sku", "GCV000051").maybeSingle();
    expect(map).toBeNull();
  });

  it("a forced mapping-CHECK failure (negative price) ROLLS BACK the intent update", async () => {
    const id = await makeIntent("GCV000052", FP, "preparing");
    const r = await call({ p_sku: "GCV000052", p_intent_id: id, p_asking_price_cents: -1 });
    expect(r.error).not.toBeNull(); // the CHECK violation raises → transaction rolls back
    const { data: intent } = await service.from("ebay_listing_intents").select("status").eq("id", id).single();
    expect(intent!.status).toBe("preparing"); // intent update rolled back
    const { data: map } = await service.from("ebay_listing_mappings").select("id").eq("ebay_account_id", accountId).eq("sku", "GCV000052").maybeSingle();
    expect(map).toBeNull();
  });

  it("a stale optimistic-concurrency fence (wrong expected updated_at) → stale_intent, NO writes", async () => {
    const id = await makeIntent("GCV000053");
    const r = await call({ p_sku: "GCV000053", p_intent_id: id, p_expected_status: "preparing", p_expected_offer_id: null, p_expected_listing_id: null, p_expected_updated_at: "1999-01-01T00:00:00Z" });
    expect(r.data).toMatchObject({ ok: false, error_code: "stale_intent" });
    const { data: map } = await service.from("ebay_listing_mappings").select("id").eq("ebay_account_id", accountId).eq("sku", "GCV000053").maybeSingle();
    expect(map).toBeNull();
  });

  it("anon and authenticated cannot execute the RPC", async () => {
    const rpcArgs = { p_account_id: accountId, p_slab_id: slabId, p_sku: "x", p_intent_id: "00000000-0000-0000-0000-000000000000", p_offer_id: "x", p_listing_id: "", p_listing_status: "published", p_asking_price_cents: 1, p_currency: "USD", p_expected_fingerprint: "x", p_expected_fingerprint_version: 3, p_expected_status: null, p_expected_offer_id: null, p_expected_listing_id: null, p_expected_updated_at: null };
    const anon = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `rl-anon-${stamp}` } });
    expect((await anon.rpc("ebay_listing_reconcile_local", rpcArgs)).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_listing_reconcile_local", rpcArgs)).error).not.toBeNull();
  });
});
