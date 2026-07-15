/**
 * LIVE tests for permanent public inventory identifiers (S0001…).
 *
 * Proves the DB behavior that unit tests can't: server-side assignment,
 * concurrency-safe distinct sequences, immutability, never-reuse across
 * hard-delete, and the ownership-scoped resolver. Same env gating as the other
 * integration suites — skipped unless pointed at a disposable test project.
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

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    card_name: "Charizard", grader: "PSA", grade: "9", set_name: "Base Set",
    card_number: "4", year: 1999, language: "English",
    final_value_cents: 12500, verification_status: "verified",
    valuation_confidence: "manual", valuation_provenance: "manual_value", ...overrides,
  };
}

suite("permanent public inventory identifiers", () => {
  let service: SupabaseClient;
  let admin: SupabaseClient;
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const stamp = `${Math.floor(performance.now())}`;

  async function makeAdmin(): Promise<SupabaseClient> {
    const email = `inv-admin+${stamp}@slabvault.test`;
    const password = `Test-inv-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true },
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    const client = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `inv-${stamp}` } });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    return client;
  }

  async function create(cert: string) {
    const { data, error } = await admin.rpc("create_slab", { p: baseInput({ certification_number: cert }), p_front_ext: "jpg", p_back_ext: null });
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.id) slabIds.push(row.id);
    return { row, error };
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `inv-svc-${stamp}` } });
    admin = await makeAdmin();
  });

  afterAll(async () => {
    for (const id of slabIds) await service.from("slabs").delete().eq("id", id);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("assigns a well-formed S-code and matching prefix/sequence server-side", async () => {
    const { row, error } = await create(`INV${stamp}A`);
    expect(error).toBeNull();
    expect(row.inventory_prefix).toBe("S");
    expect(typeof row.inventory_sequence).toBe("number");
    expect(row.inventory_code).toBe(`S${String(row.inventory_sequence).padStart(4, "0")}`);
  });

  it("backfilled + new codes are unique and at least four digits", async () => {
    const { data } = await service.from("slabs").select("inventory_code").not("inventory_code", "is", null).limit(500);
    const codes = (data ?? []).map((r: { inventory_code: string }) => r.inventory_code);
    expect(new Set(codes).size).toBe(codes.length); // unique
    for (const c of codes) expect(c).toMatch(/^[A-Z]\d{4,}$/);
  });

  it("gives concurrent creations distinct, gap-free-or-forward sequences (no collision)", async () => {
    const results = await Promise.all([create(`C1${stamp}`), create(`C2${stamp}`), create(`C3${stamp}`), create(`C4${stamp}`)]);
    const seqs = results.map((r) => r.row.inventory_sequence);
    expect(new Set(seqs).size).toBe(seqs.length); // all distinct — no two rows share a sequence
  });

  it("rejects any attempt to change the sequence or prefix (immutable)", async () => {
    const { row } = await create(`IMM${stamp}`);
    const seq = await service.from("slabs").update({ inventory_sequence: row.inventory_sequence + 1000 }).eq("id", row.id).select("id");
    expect(seq.error?.message ?? "").toMatch(/immutable/i);
    const pfx = await service.from("slabs").update({ inventory_prefix: "R" }).eq("id", row.id).select("id");
    expect(pfx.error?.message ?? "").toMatch(/immutable/i);
    // The stored code is unchanged.
    const { data } = await service.from("slabs").select("inventory_code,inventory_sequence").eq("id", row.id).single();
    expect(data!.inventory_sequence).toBe(row.inventory_sequence);
  });

  it("never reuses a sequence after a hard delete (permanent, forward-only)", async () => {
    const { row: first } = await create(`REUSE1${stamp}`);
    // Delete it directly (service role) to simulate removal.
    await service.from("slabs").delete().eq("id", first.id);
    const { row: second } = await create(`REUSE2${stamp}`);
    expect(second.inventory_sequence).toBeGreaterThan(first.inventory_sequence); // forward, never reissued
  });

  it("resolves S0001 / 0001 / bare number to the owning admin's slab", async () => {
    const { row } = await create(`RES${stamp}`);
    const code = row.inventory_code as string;
    const seq = row.inventory_sequence as number;

    const byCode = await admin.rpc("resolve_slab_inventory", { p_query: code });
    expect((byCode.data ?? []).some((s: { id: string }) => s.id === row.id)).toBe(true);

    const byPadded = await admin.rpc("resolve_slab_inventory", { p_query: String(seq).padStart(4, "0") });
    expect((byPadded.data ?? []).some((s: { id: string }) => s.id === row.id)).toBe(true);

    const byBare = await admin.rpc("resolve_slab_inventory", { p_query: String(seq) });
    expect((byBare.data ?? []).some((s: { id: string }) => s.id === row.id)).toBe(true);

    // A raw-card prefix never resolves to a slab.
    const asRaw = await admin.rpc("resolve_slab_inventory", { p_query: `R${String(seq).padStart(4, "0")}` });
    expect((asRaw.data ?? []).some((s: { id: string }) => s.id === row.id)).toBe(false);

    // Free text resolves to nothing.
    const junk = await admin.rpc("resolve_slab_inventory", { p_query: "not-an-id" });
    expect(junk.data ?? []).toHaveLength(0);
  });

  it("parse_inventory_code returns the expected prefix/sequence split", async () => {
    const coded = await admin.rpc("parse_inventory_code", { p_query: "S0007" });
    expect((coded.data ?? [])[0]).toMatchObject({ prefix: "S", sequence: 7 });
    const numeric = await admin.rpc("parse_inventory_code", { p_query: "0007" });
    expect((numeric.data ?? [])[0]).toMatchObject({ prefix: null, sequence: 7 });
    const junk = await admin.rpc("parse_inventory_code", { p_query: "xyz" });
    expect(junk.data ?? []).toHaveLength(0);
  });
});
