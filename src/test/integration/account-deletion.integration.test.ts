/**
 * LIVE integration tests for the 20260906000000 account-deletion workflow:
 * public.purge_customer_account_data + the service-role Auth deletion that
 * follows it.
 *
 * Same env gating as every other integration suite: runs only against the
 * disposable test stack (SLABVAULT_TEST_*), never production.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    certification_number: `${Math.floor(performance.now())}`.slice(-8).padStart(8, "9"),
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

suite("account deletion (purge_customer_account_data + auth deletion)", () => {
  let service: SupabaseClient;
  let anonClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];

  async function makeUser(tag: string, isAdmin = false) {
    const email = `acctdel-${tag}-${stamp}@slabvault.test`;
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
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `acctdel-${tag}-${stamp}` },
    });
    await client.auth.signInWithPassword({ email, password });
    return { client, id, email, password };
  }

  async function makeSlab(client: SupabaseClient): Promise<string> {
    const { data, error } = await client.rpc("create_slab", {
      p: slabInput(),
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row.id;
  }

  async function makeCardScan(userId: string): Promise<{ id: string; path: string }> {
    // card_scans is service-role only; a scan row is enough to exercise the
    // created_by RESTRICT FK that blocks direct auth deletion.
    const path = `${userId}/${stamp}-${Math.floor(performance.now())}.jpg`;
    const { data, error } = await service
      .from("card_scans")
      .insert({
        created_by: userId,
        image_storage_path: path,
        image_sha256: "a".repeat(64),
        mime_type: "image/jpeg",
        byte_size: 1024,
        status: "processing",
        confidence: 0,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, path };
  }

  let adminReader: SupabaseClient; // reads private/admin-gated evidence RPCs

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `acctdel-svc-${stamp}` },
    });
    anonClient = createClient(URL!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `acctdel-anon-${stamp}` },
    });
    // The tombstone reader and cleanup-queue list are admin-gated on
    // is_admin(auth.uid()); the service role has no auth.uid(), so evidence is
    // verified through a real admin JWT client.
    adminReader = (await makeUser("reader", true)).client;
  });

  afterAll(async () => {
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("a user who owns a slab cannot be deleted directly (RESTRICT fails safely)", async () => {
    const u = await makeUser("restrict");
    await makeSlab(u.client);
    const { error } = await service.auth.admin.deleteUser(u.id);
    expect(error).not.toBeNull(); // blocked by owner_id RESTRICT
    // The account and its data still exist and are consistent.
    const { data } = await service.from("slabs").select("id").eq("owner_id", u.id);
    expect((data ?? []).length).toBe(1);
  });

  it("purges owned slab + card-scan data, then the auth user deletes cleanly", async () => {
    const u = await makeUser("full");
    const slabId = await makeSlab(u.client);
    const scan = await makeCardScan(u.id);

    const { data: summary, error } = await u.client.rpc("purge_customer_account_data", {});
    expect(error).toBeNull();
    expect(summary.slabs_deleted).toBe(1);
    expect(summary.card_scans_deleted).toBe(1);
    // At least the slab front image (slab-images) + the card scan (card-scans).
    expect(summary.storage_paths_queued).toBeGreaterThanOrEqual(2);

    // Owned rows are gone.
    expect((await service.from("slabs").select("id").eq("id", slabId)).data).toEqual([]);
    expect((await service.from("card_scans").select("id").eq("id", scan.id)).data).toEqual([]);

    // Evidence is retained (read through an admin JWT — the reader is
    // admin-gated and the service role has no auth.uid()).
    const tomb = await adminReader.rpc("get_slab_deletion_tombstone", { p_slab_id: slabId });
    expect(((tomb.data ?? []) as unknown[]).length).toBe(1);
    const audit = await service.from("audit_log").select("action").eq("entity_id", u.id).eq("action", "account_data_purged");
    expect((audit.data ?? []).length).toBe(1);

    // The card-scans object was queued for cleanup (its path is "<uid>/…",
    // which slab-images paths ("slabs/<n>/…") never match).
    const queue = await adminReader.rpc("list_pending_slab_storage_cleanup");
    const paths = ((queue.data ?? []) as Array<{ storage_path: string }>).map((r) => r.storage_path);
    expect(paths).toContain(scan.path);

    // Phase 2: the Auth user now deletes cleanly (RESTRICT dependencies gone),
    // cascading customer_profiles / quota / admin rows.
    const { error: delErr } = await service.auth.admin.deleteUser(u.id);
    expect(delErr).toBeNull();
    expect((await service.from("customer_profiles").select("id").eq("id", u.id)).data).toEqual([]);
  });

  it("a customer cannot purge another customer's account", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    await makeSlab(b.client);
    const { error } = await a.client.rpc("purge_customer_account_data", { p_user_id: b.id });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    // B's data is untouched.
    expect((await service.from("slabs").select("id").eq("owner_id", b.id)).data?.length).toBe(1);
  });

  it("an administrator can purge another account and the override is audited", async () => {
    const admin = await makeUser("admin", true);
    const victim = await makeUser("victim");
    await makeSlab(victim.client);
    const { data: summary, error } = await admin.client.rpc("purge_customer_account_data", { p_user_id: victim.id });
    expect(error).toBeNull();
    expect(summary.admin_override).toBe(true);
    expect(summary.slabs_deleted).toBe(1);
    const audit = await service
      .from("audit_log")
      .select("detail")
      .eq("entity_id", victim.id)
      .eq("action", "account_data_purged")
      .single();
    expect((audit.data?.detail as { admin_override?: boolean })?.admin_override).toBe(true);
    await service.auth.admin.deleteUser(victim.id);
  });

  it("refuses anonymous callers", async () => {
    const { error } = await anonClient.rpc("purge_customer_account_data", {});
    expect(error).not.toBeNull();
  });

  it("succeeds and is idempotent for an account with no inventory", async () => {
    const u = await makeUser("empty");
    const first = await u.client.rpc("purge_customer_account_data", {});
    expect(first.error).toBeNull();
    expect(first.data.slabs_deleted).toBe(0);
    const second = await u.client.rpc("purge_customer_account_data", {});
    expect(second.error).toBeNull();
    const { error: delErr } = await service.auth.admin.deleteUser(u.id);
    expect(delErr).toBeNull();
  });
});
