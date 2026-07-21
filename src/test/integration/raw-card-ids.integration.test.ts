/**
 * LIVE tests for raw-card public inventory identifiers (R0001…).
 *
 * Raw cards are scan-sourced (cards.source_scan_id is required), so each test
 * card is seeded with a card_scans row via the service role, then the BEFORE
 * INSERT trigger assigns its R-code. Same env gating as the other suites.
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

suite("raw-card public inventory identifiers", () => {
  let service: SupabaseClient;
  let ownerId = "";
  const userIds: string[] = [];
  const scanIds: string[] = [];
  const cardIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;
  let counter = 0;

  async function seedCard(): Promise<{ id: string; inventory_code: string; inventory_sequence: number }> {
    counter += 1;
    const sha = "a".repeat(64);
    const { data: scan, error: scanErr } = await service.from("card_scans").insert({
      created_by: ownerId,
      image_storage_path: `${ownerId}/scan-${stamp}-${counter}.jpg`,
      image_sha256: sha,
      mime_type: "image/jpeg",
      byte_size: 1000,
      status: "processing",
    }).select("id").single();
    if (scanErr) throw scanErr;
    scanIds.push(scan.id);

    const { data: card, error: cardErr } = await service.from("cards").insert({
      created_by: ownerId,
      source_scan_id: scan.id,
      card_name: "Pikachu",
      set_name: "Jungle",
      card_number: `${counter}/64`,
      identification_confidence: 0.9,
      scan_image_path: `${ownerId}/scan-${stamp}-${counter}.jpg`,
    }).select("id,inventory_code,inventory_sequence").single();
    if (cardErr) throw cardErr;
    cardIds.push(card.id);
    return card;
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `raw-svc-${stamp}` } });
    const { data, error } = await service.auth.admin.createUser({ email: `raw-owner+${stamp}@slabvault.test`, password: `Test-raw-${stamp}`, email_confirm: true });
    if (error) throw error;
    ownerId = data.user!.id;
    userIds.push(ownerId);
  });

  afterAll(async () => {
    for (const id of cardIds) await service.from("cards").delete().eq("id", id);
    for (const id of scanIds) await service.from("card_scans").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("assigns a well-formed R-code on insert (server-side trigger)", async () => {
    const card = await seedCard();
    expect(card.inventory_code).toBe(`R${String(card.inventory_sequence).padStart(4, "0")}`);
    expect(card.inventory_code).toMatch(/^R\d{4,}$/);
  });

  it("advances the sequence forward across inserts and never reuses after delete", async () => {
    const first = await seedCard();
    await service.from("cards").delete().eq("id", first.id);
    const second = await seedCard();
    expect(second.inventory_sequence).toBeGreaterThan(first.inventory_sequence);
  });

  it("rejects any change to the R prefix or sequence (immutable)", async () => {
    const card = await seedCard();
    const upd = await service.from("cards").update({ inventory_sequence: card.inventory_sequence + 500 }).eq("id", card.id).select("id");
    expect(upd.error?.message ?? "").toMatch(/immutable/i);
  });

  it("resolves R-codes and slab S-codes through the unified resolver as an admin", async () => {
    // Promote the owner to admin so resolve_inventory (ownership-scoped) returns rows.
    await service.auth.admin.updateUserById(ownerId, { app_metadata: { graded_card_value_admin: true } });
    const adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `raw-adm-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email: `raw-owner+${stamp}@slabvault.test`, password: `Test-raw-${stamp}` });

    const card = await seedCard();
    const byCode = await adminClient.rpc("resolve_inventory", { p_query: card.inventory_code });
    const rows = (byCode.data ?? []) as Array<{ item_type: string; id: string }>;
    expect(rows.some((r) => r.item_type === "raw_card" && r.id === card.id)).toBe(true);

    // An S-prefixed query never resolves to a raw card.
    const asSlab = await adminClient.rpc("resolve_inventory", { p_query: `S${String(card.inventory_sequence).padStart(4, "0")}` });
    const slabRows = (asSlab.data ?? []) as Array<{ item_type: string; id: string }>;
    expect(slabRows.some((r) => r.id === card.id)).toBe(false);
  });

  it("keeps raw-card codes unique across the table", async () => {
    const { data } = await service.from("cards").select("inventory_code").eq("inventory_prefix", "R").limit(500);
    const codes = (data ?? []).map((r: { inventory_code: string }) => r.inventory_code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
