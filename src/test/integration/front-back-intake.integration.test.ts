/**
 * LIVE tests for the raw-card front/back intake path (stage_raw_card).
 *
 * Proves the DB behavior the component tests can't: a raw card is created from
 * the analysis with front + back stored, owned by the caller, resolvable by its
 * R-code, isolated from other customers, and never duplicated. Same env gating.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ??
  {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("raw-card front/back intake (stage_raw_card)", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let aliceId = "";
  const userIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;
  let n = 0;

  async function makeUser(tag: string): Promise<{ client: SupabaseClient; id: string }> {
    const email = `${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user!.id);
    const client = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `fb-${tag}-${stamp}` } });
    await client.auth.signInWithPassword({ email, password });
    return { client, id: data.user!.id };
  }

  const sha = "b".repeat(64);
  const stagePayload = (uid: string, withBack: boolean) => {
    n += 1;
    return {
      front_image_path: `${uid}/${stamp}-${n}.jpg`,
      back_image_path: withBack ? `${uid}/${stamp}-${n}-back.jpg` : null,
      front_sha256: sha,
      front_byte_size: 1000,
      confidence: 0.9,
      card_name: "Charizard",
      set_name: "Base Set",
      card_number: `${n}/102`,
      rarity: "Holo Rare",
    };
  };

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `fb-svc-${stamp}` } });
    const a = await makeUser("fb-alice");
    const b = await makeUser("fb-bob");
    alice = a.client;
    aliceId = a.id;
    bob = b.client;
  });

  afterAll(async () => {
    await service.from("cards").delete().in("created_by", userIds);
    await service.from("card_scans").delete().in("created_by", userIds);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("creates one raw card with an R-code, owned by the caller, storing front + back", async () => {
    const { data, error } = await alice.rpc("stage_raw_card", { p: stagePayload(aliceId, true) });
    expect(error).toBeNull();
    const card = (Array.isArray(data) ? data[0] : data) as { id: string; created_by: string; inventory_code: string; scan_image_path: string; back_image_path: string | null };
    expect(card.created_by).toBe(aliceId);
    expect(card.inventory_code).toMatch(/^R\d{4,}$/);
    expect(card.scan_image_path).toContain(aliceId);
    expect(card.back_image_path).toContain("-back.jpg"); // Requirement 5: back persists
  });

  it("creates a raw card with no back when none is provided (skip permitted)", async () => {
    const { data, error } = await alice.rpc("stage_raw_card", { p: stagePayload(aliceId, false) });
    expect(error).toBeNull();
    const card = (Array.isArray(data) ? data[0] : data) as { back_image_path: string | null };
    expect(card.back_image_path).toBeNull();
  });

  it("keeps a raw card private to its owner (Requirement 12)", async () => {
    const { data } = await alice.rpc("stage_raw_card", { p: stagePayload(aliceId, false) });
    const card = (Array.isArray(data) ? data[0] : data) as { id: string };
    const { data: bobSees } = await bob.from("cards").select("id").eq("id", card.id).maybeSingle();
    expect(bobSees).toBeNull();
    const { data: aliceSees } = await alice.from("cards").select("id").eq("id", card.id).maybeSingle();
    expect(aliceSees?.id).toBe(card.id);
  });

  it("refuses to stage an image path outside the caller's own folder", async () => {
    const payload = { ...stagePayload(aliceId, false), front_image_path: `${userIds[1]}/${stamp}-x.jpg` };
    const { error } = await alice.rpc("stage_raw_card", { p: payload });
    expect(error?.message ?? "").toMatch(/NOT_AUTHORIZED/i);
  });

  it("creates exactly one card per call (no duplicate) (Requirement 13)", async () => {
    const before = await service.from("cards").select("id", { count: "exact", head: true }).eq("created_by", aliceId);
    await alice.rpc("stage_raw_card", { p: stagePayload(aliceId, false) });
    const after = await service.from("cards").select("id", { count: "exact", head: true }).eq("created_by", aliceId);
    expect((after.count ?? 0) - (before.count ?? 0)).toBe(1);
  });
});
