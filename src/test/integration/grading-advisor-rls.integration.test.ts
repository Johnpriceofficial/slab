import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// PR #98 review fixes:
//  P1 — run-linked grading child rows must prove the referenced
//       grading_advice_runs parent belongs to the caller (not just owner_id),
//       so a customer who learns another customer's run_id cannot inject or
//       reassign a child into the victim's run.
//  P2 — grading_standards_versions is visible only when the version is active
//       AND its parent grading company is active.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("grading-advisor RLS (cross-owner child injection + retired-parent visibility)", () => {
  let service: SupabaseClient;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const companyIds: string[] = [];
  let idA = "";
  let idB = "";
  let runA = "";
  let runB = "";
  let activeCo = "";
  let retiredCo = "";

  async function makeCustomer(tag: string): Promise<{ id: string; client: SupabaseClient }> {
    const email = `grrls-${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    const id = created.data.user!.id;
    userIds.push(id);
    const client = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `grrls-${tag}-${stamp}` } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id, client };
  }

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `grrls-svc-${stamp}` } });

    ({ id: idA, client: clientA } = await makeCustomer("a"));
    ({ id: idB, client: clientB } = await makeCustomer("b"));

    const rA = await service.from("grading_advice_runs").insert({ owner_id: idA, idempotency_key: `A-${stamp}`, ruleset_version: "v1", engine_version: "v1", status: "succeeded" }).select("id").single();
    if (rA.error) throw rA.error;
    runA = (rA.data as { id: string }).id;
    const rB = await service.from("grading_advice_runs").insert({ owner_id: idB, idempotency_key: `B-${stamp}`, ruleset_version: "v1", engine_version: "v1", status: "succeeded" }).select("id").single();
    if (rB.error) throw rB.error;
    runB = (rB.data as { id: string }).id;

    activeCo = `grrls-active-${stamp}`;
    retiredCo = `grrls-retired-${stamp}`;
    companyIds.push(activeCo, retiredCo);
    const co = await service.from("grading_companies").insert([
      { id: activeCo, name: "Active Co", standards_source_url: "https://example.test/a", status: "active" },
      { id: retiredCo, name: "Retired Co", standards_source_url: "https://example.test/r", status: "retired" },
    ]);
    if (co.error) throw co.error;
    const sv = await service.from("grading_standards_versions").insert([
      { company_id: activeCo, version: `av-${stamp}`, source_url: "https://example.test/a", status: "active" },
      { company_id: retiredCo, version: `rv-${stamp}`, source_url: "https://example.test/r", status: "active" },
    ]);
    if (sv.error) throw sv.error;
  });

  afterAll(async () => {
    for (const cid of companyIds) await service.from("grading_companies").delete().eq("id", cid);
    if (userIds.length) await service.from("grading_advice_runs").delete().in("owner_id", userIds);
    for (const uid of userIds) await service.auth.admin.deleteUser(uid);
  });

  it("P1.1 customer A can insert a child into A's own run", async () => {
    const r = await clientA.from("grading_condition_observations").insert({ run_id: runA, owner_id: idA, area: "corner", severity: "minor" });
    expect(r.error).toBeNull();
  });

  it("P1.2 customer A cannot inject a child into customer B's run using A's owner_id", async () => {
    const r = await clientA.from("grading_condition_observations").insert({ run_id: runB, owner_id: idA, area: "edge", severity: "minor" });
    expect(r.error).not.toBeNull();
    const leaked = await service.from("grading_condition_observations").select("id").eq("run_id", runB).eq("owner_id", idA);
    expect((leaked.data ?? []).length).toBe(0);
  });

  it("P1.3 customer A cannot reassign a child to customer B's run", async () => {
    const upd = await clientA.from("grading_condition_observations").update({ run_id: runB }).eq("owner_id", idA).eq("run_id", runA);
    expect(upd.error).not.toBeNull();
    const moved = await service.from("grading_condition_observations").select("id").eq("run_id", runB).eq("owner_id", idA);
    expect((moved.data ?? []).length).toBe(0);
  });

  it("P1.4 service-role child processing still works", async () => {
    const r = await service.from("grading_condition_observations").insert({ run_id: runB, owner_id: idB, area: "surface", severity: "moderate" }).select("id").single();
    expect(r.error).toBeNull();
  });

  it("P2.1 active version under an active company is visible; retired-company hidden", async () => {
    const rows = await clientA.from("grading_standards_versions").select("company_id, status").in("company_id", companyIds);
    expect(rows.error).toBeNull();
    const data = (rows.data ?? []) as Array<{ company_id: string; status: string }>;
    expect(data.length).toBe(1);
    expect(data[0].company_id).toBe(activeCo);
    expect(data.some((x) => x.company_id === retiredCo)).toBe(false);
    expect(data.every((x) => x.status === "active")).toBe(true);
  });

  it("P2.2 service-role maintenance sees all standards versions regardless of parent status", async () => {
    const rows = await service.from("grading_standards_versions").select("id").in("company_id", companyIds);
    expect((rows.data ?? []).length).toBe(2);
  });
});
