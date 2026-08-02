import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdministrator } from "./support/admin-role";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as
  | { env?: Record<string, string | undefined> }
  | undefined)?.env ?? {}) as Record<string, string | undefined>;

export const isProductionLike = (url: string | null | undefined) =>
  !url || /joyrent|party|rhodeisland|mycousin|prod|production|live|rcbwemkfcefarqnlgrmv|gradedcardvalue/i.test(url);
export const hasLiveCredentials = (env: Record<string, string | undefined>) =>
  Boolean(env.SLABVAULT_TEST_URL && env.SLABVAULT_TEST_ANON_KEY && env.SLABVAULT_TEST_SERVICE_KEY && env.SLABVAULT_TEST_DB_URL);

const URL_ = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const DB_URL = ENV.SLABVAULT_TEST_DB_URL;
const suite = hasLiveCredentials(ENV) && !isProductionLike(URL_) ? describe : describe.skip;

type SaveResult = {
  result: "created" | "already_saved" | "duplicate_certification";
  created: boolean;
  analysis_run_id: string;
  analysis_run_linked: boolean;
  owner_id: string;
  slab_id: string;
  inventory_number: number;
  inventory_code: string | null;
  front_image_path: string | null;
  back_image_path: string | null;
};
type RpcError = { code?: string; message?: string } | null;
type Sql = { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };

const RESULT_KEYS = [
  "result", "created", "analysis_run_id", "analysis_run_linked", "owner_id",
  "slab_id", "inventory_number", "inventory_code", "front_image_path", "back_image_path",
].sort();
const FIXTURE_FN = "__test_force_link_failure";
const FIXTURE_TRIGGER = "__test_force_link_failure_trg";

async function connect(url: string): Promise<Sql> {
  const pg = (await import("pg")) as unknown as {
    Client: new (config: { connectionString: string }) => {
      connect: () => Promise<void>;
      query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
  };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function installLinkFailureFixture(projectUrl: string | undefined, dbUrl: string | undefined, runId: string) {
  if (isProductionLike(projectUrl)) throw new Error("refused: rollback fixture may never target production");
  if (!dbUrl) throw new Error("refused: SLABVAULT_TEST_DB_URL is required");
  const sql = await connect(dbUrl);
  await sql.query(`
    create or replace function public.${FIXTURE_FN}() returns trigger language plpgsql as $x$
    begin
      if new.id = '${runId}'::uuid and new.slab_id is not null and old.slab_id is null then
        raise exception 'forced link failure (test fixture)' using errcode = 'P0001';
      end if;
      return new;
    end $x$;
    drop trigger if exists ${FIXTURE_TRIGGER} on public.ai_analysis_runs;
    create trigger ${FIXTURE_TRIGGER} before update on public.ai_analysis_runs
      for each row execute function public.${FIXTURE_FN}();
  `);
  return sql;
}
async function removeFixture(sql: Sql) {
  await sql.query(`drop trigger if exists ${FIXTURE_TRIGGER} on public.ai_analysis_runs; drop function if exists public.${FIXTURE_FN}();`);
}
async function fixtureAbsent(sql: Sql) {
  const t = await sql.query(`select 1 from pg_trigger where tgname='${FIXTURE_TRIGGER}' and not tgisinternal`);
  const f = await sql.query(`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${FIXTURE_FN}'`);
  return t.rows.length === 0 && f.rows.length === 0;
}

const credentialSet = { SLABVAULT_TEST_URL: "u", SLABVAULT_TEST_ANON_KEY: "a", SLABVAULT_TEST_SERVICE_KEY: "s", SLABVAULT_TEST_DB_URL: "d" };
describe("atomic-save harness safety", () => {
  it.each([undefined, null, "", "https://prod.example", "https://gradedcardvalue.com", "https://rcbwemkfcefarqnlgrmv.supabase.co"])(
    "refuses unsafe target %s", (url) => expect(isProductionLike(url)).toBe(true),
  );
  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "https://staging-only.supabase.test"])(
    "accepts disposable target %s", (url) => expect(isProductionLike(url)).toBe(false),
  );
  it("requires all credentials", () => {
    expect(hasLiveCredentials(credentialSet)).toBe(true);
    for (const key of Object.keys(credentialSet)) expect(hasLiveCredentials({ ...credentialSet, [key]: undefined })).toBe(false);
  });
  it("refuses production rollback fixtures", async () => {
    await expect(installLinkFailureFixture("https://prod.example", "postgres://x", crypto.randomUUID())).rejects.toThrow(/refused/i);
  });
});

suite("atomic confirmed save + slab permission model — LIVE", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let noProfile: SupabaseClient;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let aliceId = "", bobId = "", noProfileId = "", adminId = "";
  const users: string[] = [];
  const runs = new Set<string>();
  const slabs = new Set<string>();
  const cleanupErrors: string[] = [];
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let cert = 0;

  const payload = (overrides: Record<string, unknown> = {}) => ({
    card_name: "Charizard", grader: "PSA", grade: "10", certification_number: `atomic-${stamp}-${++cert}`,
    set_name: "Base Set", card_number: "4", year: 1999, language: "English", final_value_cents: 12500,
    verification_status: "verified", valuation_confidence: "manual", valuation_provenance: "manual_value", ...overrides,
  });
  const draft = (overrides: Record<string, unknown> = {}) => payload({
    certification_number: null, verification_status: "unverified", final_value_cents: null,
    valuation_confidence: null, valuation_provenance: "tier_unavailable", ...overrides,
  });

  async function makeUser(tag: string, appMetadata: Record<string, unknown> = {}) {
    const email = `${tag}+${stamp}@slabvault.test`, password = `Test-${tag}-${stamp}`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: appMetadata });
    if (created.error) throw created.error;
    const id = created.data.user!.id;
    users.push(id);
    if (appMetadata.graded_card_value_admin === true) await grantAdministrator(service, id);
    const client = createClient(URL_!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `${tag}-${stamp}` } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id, client };
  }
  async function insertRun(ownerId: string | null, status = "succeeded") {
    const result = await service.from("ai_analysis_runs").insert({
      provider: "OPENAI", model: "test-model", schema_version: "test", analysis_type: "multi_pass_slab_identity",
      status, structured_result: {}, owner_id: ownerId,
    }).select("id").single();
    if (result.error) throw result.error;
    runs.add(result.data.id);
    return result.data.id as string;
  }
  async function save(client: SupabaseClient, runId: string | null, p: unknown, back: string | null = null, front = "jpg") {
    const result = await client.rpc("save_confirmed_slab_from_analysis", {
      p_analysis_run_id: runId, p, p_front_ext: front, p_back_ext: back,
    });
    const data = (result.data ?? null) as SaveResult | null;
    if (data?.slab_id) slabs.add(data.slab_id);
    return { data, error: result.error as RpcError };
  }
  async function runRow(id: string) {
    const result = await service.from("ai_analysis_runs").select("slab_id,status,owner_id").eq("id", id).single();
    if (result.error) throw result.error;
    return result.data as { slab_id: string | null; status: string; owner_id: string | null };
  }
  async function slabRow(id: string) {
    const result = await service.from("slabs").select("*").eq("id", id).single();
    if (result.error) throw result.error;
    return result.data as Record<string, unknown>;
  }
  async function auditRows(id: string) {
    const result = await service.from("audit_log").select("id,detail,owner_id,actor_user_id,source").eq("entity_id", id).eq("action", "slab.save_confirmed_from_analysis");
    if (result.error) throw result.error;
    return result.data ?? [];
  }
  const correct = (client: SupabaseClient, slabId: string, changes: Record<string, unknown>, key: string | null) =>
    client.rpc("correct_slab_identification", { p_slab_id: slabId, p_corrections: changes, p_idempotency_key: key });

  beforeAll(async () => {
    service = createClient(URL_!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `svc-${stamp}` } });
    anon = createClient(URL_!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `anon-${stamp}` } });
    const a = await makeUser("alice"), b = await makeUser("bob"), n = await makeUser("no-profile");
    const adm = await makeUser("admin", { graded_card_value_admin: true });
    [aliceId, alice] = [a.id, a.client]; [bobId, bob] = [b.id, b.client];
    [noProfileId, noProfile] = [n.id, n.client]; [adminId, admin] = [adm.id, adm.client];
    const adminRow = await service.from("slab_admins").upsert({ user_id: adminId });
    if (adminRow.error) throw adminRow.error;
    const profileDelete = await service.from("customer_profiles").delete().eq("id", noProfileId);
    if (profileDelete.error) throw profileDelete.error;
    const adminCheck = await admin.rpc("is_admin", { _user_id: adminId });
    if (adminCheck.error || adminCheck.data !== true) throw new Error("admin fixture is not trusted");
  }, 120000);

  afterAll(async () => {
    for (const id of runs) {
      const e = await service.from("ai_field_evidence").delete().eq("analysis_run_id", id); if (e.error) cleanupErrors.push(e.error.message);
      const r = await service.from("ai_analysis_runs").delete().eq("id", id); if (r.error) cleanupErrors.push(r.error.message);
    }
    for (const id of slabs) { const s = await service.from("slabs").delete().eq("id", id); if (s.error) cleanupErrors.push(s.error.message); }
    if (adminId) { const a = await service.from("slab_admins").delete().eq("user_id", adminId); if (a.error) cleanupErrors.push(a.error.message); }
    for (const id of users) { const u = await service.auth.admin.deleteUser(id); if (u.error) cleanupErrors.push(u.error.message); }
    const sql = await connect(DB_URL!); try { if (!(await fixtureAbsent(sql))) cleanupErrors.push("rollback fixture remains"); } finally { await sql.end(); }
    if (cleanupErrors.length) throw new Error(`cleanup failed: ${cleanupErrors.join("; ")}`);
  }, 120000);

  describe("rollback", () => {
    let runId = "", p: Record<string, unknown>, error: RpcError = null, retry: Awaited<ReturnType<typeof save>>;
    let before = 0, after = 0, linked: string | null = "sentinel", audit = -1, seqBefore = 0, seqAfter = 0, removed = false;
    beforeAll(async () => {
      runId = await insertRun(aliceId); p = payload();
      before = (await service.from("slabs").select("id", { count: "exact", head: true }).eq("owner_id", aliceId)).count ?? 0;
      const sql = await installLinkFailureFixture(URL_, DB_URL, runId);
      try {
        seqBefore = Number((await sql.query("select last_value from public.slab_inventory_seq")).rows[0]?.last_value ?? 0);
        error = (await save(alice, runId, p)).error;
        after = (await service.from("slabs").select("id", { count: "exact", head: true }).eq("owner_id", aliceId)).count ?? 0;
        linked = (await runRow(runId)).slab_id;
        audit = (await service.from("audit_log").select("id").eq("action", "slab.save_confirmed_from_analysis").contains("detail", { analysis_run_id: runId })).data?.length ?? 0;
        seqAfter = Number((await sql.query("select last_value from public.slab_inventory_seq")).rows[0]?.last_value ?? 0);
      } finally { await removeFixture(sql); removed = await fixtureAbsent(sql); await sql.end(); }
      retry = await save(alice, runId, p);
    }, 120000);
    it("surfaces the forced failure", () => { expect(error?.code).toBe("P0001"); expect(error?.message).toMatch(/forced link failure/i); });
    it("rolls back the slab", () => expect(after).toBe(before));
    it("rolls back the link", () => expect(linked).toBeNull());
    it("rolls back the audit", () => expect(audit).toBe(0));
    it("permits sequence gaps", () => expect(seqAfter).toBeGreaterThanOrEqual(seqBefore));
    it("removes the fixture", () => expect(removed).toBe(true));
    it("succeeds on retry", () => { expect(retry.error).toBeNull(); expect(retry.data?.result).toBe("created"); });
    it("links and audits the retry once", async () => { expect((await runRow(runId)).slab_id).toBe(retry.data?.slab_id); expect(await auditRows(retry.data!.slab_id)).toHaveLength(1); });
  });

  describe("idempotency and certification", () => {
    it.each([2, 3, 5])("serializes %i calls for one run", async (n) => {
      const run = await insertRun(aliceId), p = payload();
      const results = await Promise.all(Array.from({ length: n }, () => save(alice, run, p)));
      results.forEach((r) => expect(r.error).toBeNull());
      expect(new Set(results.map((r) => r.data!.slab_id)).size).toBe(1);
      expect(results.filter((r) => r.data!.result === "created")).toHaveLength(1);
      expect(results.filter((r) => r.data!.result === "already_saved")).toHaveLength(n - 1);
    });
    it.each([2, 3, 4])("converges %i runs sharing a certification", async (n) => {
      const p = payload(), runIds = await Promise.all(Array.from({ length: n }, () => insertRun(aliceId)));
      const results = await Promise.all(runIds.map((id) => save(alice, id, p)));
      results.forEach((r) => expect(r.error).toBeNull());
      expect(results.filter((r) => r.data!.result === "created")).toHaveLength(1);
      expect(results.filter((r) => r.data!.result === "duplicate_certification")).toHaveLength(n - 1);
    });
    it.each(["upper", "space", "both"])("normalizes certification variant %s", async (kind) => {
      const p = payload(), value = String(p.certification_number);
      const first = await save(alice, await insertRun(aliceId), p);
      const changed = kind === "upper" ? value.toUpperCase() : kind === "space" ? ` ${value} ` : ` ${value.toUpperCase()} `;
      const duplicate = await save(alice, await insertRun(aliceId), { ...p, certification_number: changed });
      expect(first.data?.result).toBe("created"); expect(duplicate.data?.result).toBe("duplicate_certification");
    });
    it("normalizes grader", async () => {
      const p = payload(); await save(alice, await insertRun(aliceId), p);
      expect((await save(alice, await insertRun(aliceId), { ...p, grader: " psa " })).data?.result).toBe("duplicate_certification");
    });
    it("allows a different grader", async () => {
      const p = payload(), a = await save(alice, await insertRun(aliceId), p), b = await save(alice, await insertRun(aliceId), { ...p, grader: "CGC" });
      expect(a.data?.slab_id).not.toBe(b.data?.slab_id);
    });
    it("scopes duplicates by owner", async () => {
      const p = payload(), a = await save(alice, await insertRun(aliceId), p), b = await save(bob, await insertRun(bobId), p);
      expect(a.data?.result).toBe("created"); expect(b.data?.result).toBe("created"); expect(a.data?.slab_id).not.toBe(b.data?.slab_id);
    });
    it.each([null, "", "   "])("accepts unverified draft certification %s", async (value) => {
      const result = await save(alice, await insertRun(aliceId), draft({ certification_number: value }));
      expect(result.error).toBeNull(); expect(result.data?.result).toBe("created");
    });
    it("replays a certification-less draft", async () => {
      const run = await insertRun(aliceId), p = draft(), first = await save(alice, run, p), replay = await save(alice, run, p);
      expect(first.data?.result).toBe("created"); expect(replay.data?.result).toBe("already_saved");
    });
    it("creates separate certification-less runs", async () => {
      const a = await save(alice, await insertRun(aliceId), draft()), b = await save(alice, await insertRun(aliceId), draft());
      expect(a.data?.slab_id).not.toBe(b.data?.slab_id);
    });
  });

  describe("permission model", () => {
    it("allows owner read and hides from another owner", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await alice.from("slabs").select("id").eq("id", saved.data!.slab_id)).data).toHaveLength(1);
      expect((await bob.from("slabs").select("id").eq("id", saved.data!.slab_id)).data).toEqual([]);
    });
    it.each([
      ["inventory_number", 999999], ["inventory_prefix", "X"], ["final_value_cents", 1], ["front_image_path", "bad.jpg"],
    ])("refuses direct update of %s", async (field, value) => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await alice.from("slabs").update({ [field]: value }).eq("id", saved.data!.slab_id)).error).not.toBeNull();
      expect((await slabRow(saved.data!.slab_id))[field as string]).not.toBe(value);
    });
    it("refuses direct delete", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await alice.from("slabs").delete().eq("id", saved.data!.slab_id)).error).not.toBeNull();
      expect((await slabRow(saved.data!.slab_id)).id).toBe(saved.data!.slab_id);
    });
    it("allows archive RPC", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await alice.rpc("archive_slab", { p_id: saved.data!.slab_id })).error).toBeNull();
      expect((await slabRow(saved.data!.slab_id)).archived_at).not.toBeNull();
    });
    it("applies and audits a whitelisted correction", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload()), key = `correction-${stamp}-1`;
      const first = await correct(alice, saved.data!.slab_id, { card_name: "Corrected", variation: "Holo" }, key);
      const replay = await correct(alice, saved.data!.slab_id, { card_name: "Corrected", variation: "Holo" }, key);
      expect(first.error).toBeNull(); expect(first.data).toMatchObject({ ok: true, replayed: false });
      expect(replay.data).toMatchObject({ ok: true, replayed: true });
      expect((await slabRow(saved.data!.slab_id)).card_name).toBe("Corrected");
      const count = await service.from("slab_correction_events").select("id", { count: "exact", head: true }).eq("idempotency_key", key);
      expect(count.count).toBe(1);
    });
    it.each([[{}, "no_corrections"], [{ final_value_cents: 1 }, "field_not_correctable"]] as const)(
      "rejects correction %j", async (changes, code) => {
        const saved = await save(alice, await insertRun(aliceId), payload());
        const result = await correct(alice, saved.data!.slab_id, changes, `bad-${stamp}-${++cert}`);
        expect(result.error).toBeNull(); expect(result.data).toMatchObject({ ok: false, error: code });
      },
    );
    it("rejects cross-owner correction", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await correct(bob, saved.data!.slab_id, { card_name: "Stolen" }, `cross-${stamp}`)).data).toMatchObject({ ok: false, error: "not_found" });
    });
    it("scopes correction-event reads", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload()), key = `event-${stamp}`;
      await correct(alice, saved.data!.slab_id, { card_name: "Audited" }, key);
      expect((await alice.from("slab_correction_events").select("id").eq("idempotency_key", key)).data).toHaveLength(1);
      expect((await bob.from("slab_correction_events").select("id").eq("idempotency_key", key)).data).toEqual([]);
    });
    it("denies anonymous correction", async () => {
      const saved = await save(alice, await insertRun(aliceId), payload());
      expect((await correct(anon, saved.data!.slab_id, { card_name: "Anonymous" }, null)).error).not.toBeNull();
    });
  });

  describe("accounts and ownership", () => {
    it("allows owner and administrator self-save", async () => {
      expect((await save(alice, await insertRun(aliceId), payload())).data?.owner_id).toBe(aliceId);
      expect((await save(admin, await insertRun(adminId), payload())).data?.owner_id).toBe(adminId);
    });
    it("refuses anonymous save", async () => {
      expect((await anon.rpc("save_confirmed_slab_from_analysis", { p_analysis_run_id: await insertRun(aliceId), p: payload(), p_front_ext: "jpg", p_back_ext: null })).error).not.toBeNull();
    });
    it("refuses a missing profile", async () => expect((await save(noProfile, await insertRun(noProfileId), payload())).error?.code).toBe("42501"));
    it.each(["suspended", "closed"])("refuses %s account", async (status) => {
      expect((await service.from("customer_profiles").update({ account_status: status }).eq("id", bobId)).error).toBeNull();
      try { expect((await save(bob, await insertRun(bobId), payload())).error?.code).toBe("42501"); }
      finally { await service.from("customer_profiles").update({ account_status: "active" }).eq("id", bobId); }
    });
    it.each(["running", "failed"])("refuses %s run", async (status) => expect((await save(alice, await insertRun(aliceId, status), payload())).error?.code).toBe("55000"));
    it.each(["succeeded", "needs_review"])("accepts %s run", async (status) => expect((await save(alice, await insertRun(aliceId, status), payload())).data?.result).toBe("created"));
    it("refuses cross-owner and ownerless runs", async () => {
      expect((await save(alice, await insertRun(bobId), payload())).error?.code).toBe("42501");
      expect((await save(admin, await insertRun(aliceId), payload())).error?.code).toBe("42501");
      expect((await save(alice, await insertRun(null), payload())).error?.code).toBe("42501");
    });
    it.each(["foreign", "mixed"])("refuses %s evidence ownership", async (kind) => {
      const run = await insertRun(aliceId);
      const rows = kind === "foreign"
        ? [{ analysis_run_id: run, owner_id: bobId, field_name: "card_name", value: "Charizard", confidence: 0.9 }]
        : [
            { analysis_run_id: run, owner_id: aliceId, field_name: "grade", value: "10", confidence: 0.9 },
            { analysis_run_id: run, owner_id: bobId, field_name: "grader", value: "PSA", confidence: 0.9 },
          ];
      expect((await service.from("ai_field_evidence").insert(rows)).error).toBeNull();
      expect((await save(alice, run, payload())).error?.code).toBe("42501");
    });
    it("ignores payload owner ids", async () => {
      const result = await save(alice, await insertRun(aliceId), payload({ owner_id: bobId, user_id: bobId }));
      expect(result.data?.owner_id).toBe(aliceId);
    });
  });

  describe("inputs, images, results and audit", () => {
    it.each([
      [null, payload(), "jpg", "22023"],
      ["00000000-0000-0000-0000-000000000000", payload(), "jpg", "P0002"],
      ["new", null, "jpg", "22023"], ["new", [], "jpg", "22023"], ["new", "scalar", "jpg", "22023"],
      ["new", payload(), "", "22023"], ["new", payload(), "   ", "22023"],
    ] as const)("rejects invalid input %#", async (runValue, p, front, code) => {
      const run = runValue === "new" ? await insertRun(aliceId) : runValue;
      expect((await save(alice, run, p, null, front)).error?.code).toBe(code);
    });
    it.each([[null, null], ["jpg", /^slabs\/\d+\/back\.jpg$/]] as const)("saves supported back extension %s", async (back, pattern) => {
      const result = await save(alice, await insertRun(aliceId), payload(), back);
      expect(result.error).toBeNull(); expect(result.data?.front_image_path).toMatch(/^slabs\/\d+\/front\.jpg$/);
      if (pattern) expect(result.data?.back_image_path).toMatch(pattern); else expect(result.data?.back_image_path).toBeNull();
    });
    it.each([["exe", null], ["jpg", "exe"]] as const)("rejects invalid extensions", async (front, back) => {
      const run = await insertRun(aliceId), result = await save(alice, run, payload(), back, front);
      expect(result.error).not.toBeNull(); expect((await runRow(run)).slab_id).toBeNull();
    });
    it("returns exact created, replay and duplicate shapes", async () => {
      const run = await insertRun(aliceId), p = payload(), created = await save(alice, run, p), replay = await save(alice, run, p);
      const duplicate = await save(alice, await insertRun(aliceId), p);
      for (const result of [created, replay, duplicate]) expect(Object.keys(result.data as object).sort()).toEqual(RESULT_KEYS);
      expect(created.data?.result).toBe("created"); expect(replay.data?.result).toBe("already_saved"); expect(duplicate.data?.result).toBe("duplicate_certification");
    });
    it("does not return payload or credential material", async () => expect(JSON.stringify((await save(alice, await insertRun(aliceId), payload())).data)).not.toMatch(/base64|secret|token|password|card_name/i));
    it("writes exactly one audit row and no duplicate on replay", async () => {
      const run = await insertRun(aliceId), p = payload(), created = await save(alice, run, p); await save(alice, run, p);
      expect(await auditRows(created.data!.slab_id)).toHaveLength(1);
    });
    it("records correct customer and admin actors", async () => {
      const customer = await save(alice, await insertRun(aliceId), payload()), administrator = await save(admin, await insertRun(adminId), payload());
      const [c] = await auditRows(customer.data!.slab_id), [a] = await auditRows(administrator.data!.slab_id);
      expect(c).toMatchObject({ actor_user_id: aliceId, owner_id: aliceId }); expect(c.detail).toMatchObject({ actor_role: "customer" });
      expect(a).toMatchObject({ actor_user_id: adminId, owner_id: adminId }); expect(a.detail).toMatchObject({ actor_role: "admin" });
    });
    it("stores only approved audit detail", async () => {
      const p = payload(), result = await save(alice, await insertRun(aliceId), p, "jpg"), [row] = await auditRows(result.data!.slab_id);
      expect(Object.keys(row.detail as object).sort()).toEqual(["actor_role", "analysis_run_id", "has_back_image", "inventory_code", "inventory_number", "target_owner_id"].sort());
      expect(JSON.stringify(row.detail)).not.toContain(String(p.certification_number)); expect(row.source).toBe("rpc:save_confirmed_slab_from_analysis");
    });
  });

  it("maintains a clean disposable-fixture ledger", () => {
    expect(users.length).toBeGreaterThanOrEqual(4); expect(runs.size).toBeGreaterThan(0); expect(slabs.size).toBeGreaterThan(0); expect(cleanupErrors).toEqual([]);
  });
});
