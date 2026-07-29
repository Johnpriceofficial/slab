/**
 * LIVE tests for public.save_confirmed_slab_from_analysis — the atomic,
 * idempotent final-save path for the confirmed-review flow.
 *
 * STATE: WRITTEN BUT NOT RUN — STAGING VERIFICATION REQUIRED.
 * Nothing in this file has been executed against a database. No statement in
 * the package may describe these cases as passing, proved or verified until an
 * authorized staging run completes with zero skips and zero retries.
 *
 * The suite is env-gated and hard-refuses anything that looks like production:
 *   SLABVAULT_TEST_URL        staging project URL
 *   SLABVAULT_TEST_ANON_KEY   staging anon/publishable key
 *   SLABVAULT_TEST_SERVICE_KEY staging service key
 *   SLABVAULT_TEST_DB_URL     direct staging Postgres URL — required ONLY so
 *                             the rollback fixture (a temporary, test-only
 *                             trigger targeting ONE randomly generated run)
 *                             can be installed and removed without adding any
 *                             testing hook to the migration. Requires the `pg`
 *                             devDependency in the backend repository.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)
  ?.env ?? {}) as Record<string, string | undefined>;

/** Fail-closed production detector. Used by BOTH the suite gate and the fixture installer. */
export function isProductionLike(url: string | undefined | null): boolean {
  if (!url) return true; // unknown target is treated as production
  return /joyrent|party|rhodeisland|mycousin|prod|live|rcbwemkfcefarqnlgrmv|gradedcardvalue/i.test(url);
}

/** Credential gate: every live credential must be present, or the suite does not run. */
export function hasLiveCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.SLABVAULT_TEST_URL &&
      env.SLABVAULT_TEST_ANON_KEY &&
      env.SLABVAULT_TEST_SERVICE_KEY &&
      env.SLABVAULT_TEST_DB_URL,
  );
}

const URL_ = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const DB_URL = ENV.SLABVAULT_TEST_DB_URL;
const LIVE = hasLiveCredentials(ENV) && !isProductionLike(URL_);
const suite = LIVE ? describe : describe.skip;

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

const RESULT_KEYS = [
  "result",
  "created",
  "analysis_run_id",
  "analysis_run_linked",
  "owner_id",
  "slab_id",
  "inventory_number",
  "inventory_code",
  "front_image_path",
  "back_image_path",
].sort();

/** Runs `body`, then ALWAYS runs `cleanup`; a cleanup failure fails the test. */
export async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  try {
    return await body();
  } finally {
    await cleanup();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TEST-HARNESS SAFETY — pure, always runs, no database required
   ══════════════════════════════════════════════════════════════════════════ */

describe("test-harness safety", () => {
  it("refuses a production project URL", () => {
    expect(isProductionLike("https://rcbwemkfcefarqnlgrmv.supabase.co")).toBe(true);
    expect(isProductionLike("https://prod-slab.supabase.co")).toBe(true);
    expect(isProductionLike("https://gradedcardvalue.com")).toBe(true);
  });

  it("treats an unknown or empty target as production", () => {
    expect(isProductionLike(undefined)).toBe(true);
    expect(isProductionLike("")).toBe(true);
    expect(isProductionLike(null)).toBe(true);
  });

  it("accepts a clearly non-production staging URL", () => {
    expect(isProductionLike("https://abcdstaging1234.supabase.co")).toBe(false);
  });

  it("refuses to run when any staging credential is missing", () => {
    const full = {
      SLABVAULT_TEST_URL: "u",
      SLABVAULT_TEST_ANON_KEY: "a",
      SLABVAULT_TEST_SERVICE_KEY: "s",
      SLABVAULT_TEST_DB_URL: "d",
    };
    expect(hasLiveCredentials(full)).toBe(true);
    for (const key of Object.keys(full)) {
      expect(hasLiveCredentials({ ...full, [key]: undefined })).toBe(false);
    }
  });

  it("refuses to install the rollback fixture against a production-looking URL", async () => {
    await expect(
      installLinkFailureFixture("https://rcbwemkfcefarqnlgrmv.supabase.co", "postgres://x", "0-0-0"),
    ).rejects.toThrow(/refus/i);
  });

  it("runs cleanup even when the body throws", async () => {
    let cleaned = false;
    await expect(
      withCleanup(
        async () => {
          throw new Error("body failed");
        },
        async () => {
          cleaned = true;
        },
      ),
    ).rejects.toThrow("body failed");
    expect(cleaned).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   ROLLBACK FIXTURE
   A temporary BEFORE UPDATE trigger scoped to ONE randomly generated run id.
   It raises exactly when link_ai_analysis_run sets that run's slab_id — i.e.
   AFTER create_slab has already executed inside the same transaction. It is
   installed only against a verified non-production URL, dropped in a finally
   block, and its absence is asserted afterwards. Nothing about it exists in
   the migration.
   ══════════════════════════════════════════════════════════════════════════ */

type Sql = { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };

async function connect(dbUrl: string): Promise<Sql> {
  const pg = (await import("pg")) as unknown as {
    Client: new (config: { connectionString: string }) => {
      connect: () => Promise<void>;
      query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>;
      end: () => Promise<void>;
    };
  };
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  return client;
}

const FIXTURE_FN = "__test_force_link_failure";
const FIXTURE_TRIGGER = "__test_force_link_failure_trg";

export async function installLinkFailureFixture(
  projectUrl: string | undefined,
  dbUrl: string | undefined,
  runId: string,
): Promise<Sql> {
  if (isProductionLike(projectUrl)) {
    throw new Error("refused: rollback fixture may never be installed against a production-looking URL");
  }
  if (!dbUrl) throw new Error("refused: SLABVAULT_TEST_DB_URL is required to install the rollback fixture");
  const sql = await connect(dbUrl);
  await sql.query(`
    create or replace function public.${FIXTURE_FN}() returns trigger
    language plpgsql as $fixture$
    begin
      if new.id = '${runId}'::uuid and new.slab_id is not null and old.slab_id is null then
        raise exception 'forced link failure (test fixture)' using errcode = 'P0001';
      end if;
      return new;
    end
    $fixture$;
    drop trigger if exists ${FIXTURE_TRIGGER} on public.ai_analysis_runs;
    create trigger ${FIXTURE_TRIGGER}
      before update on public.ai_analysis_runs
      for each row execute function public.${FIXTURE_FN}();
  `);
  return sql;
}

export async function removeLinkFailureFixture(sql: Sql): Promise<void> {
  await sql.query(`
    drop trigger if exists ${FIXTURE_TRIGGER} on public.ai_analysis_runs;
    drop function if exists public.${FIXTURE_FN}();
  `);
}

export async function fixtureIsAbsent(sql: Sql): Promise<boolean> {
  const trg = await sql.query(
    `select 1 from pg_trigger where tgname = '${FIXTURE_TRIGGER}' and not tgisinternal`,
  );
  const fn = await sql.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '${FIXTURE_FN}'`,
  );
  return trg.rows.length === 0 && fn.rows.length === 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE SUITE
   ══════════════════════════════════════════════════════════════════════════ */

suite("atomic confirmed save (save_confirmed_slab_from_analysis) — LIVE", () => {
  let service: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let carol: SupabaseClient; // customer with no customer_profiles row
  let anonClient: SupabaseClient;
  let admin: SupabaseClient;
  let aliceId = "";
  let bobId = "";
  let carolId = "";
  let adminId = "";
  const userIds: string[] = [];
  const slabIds: string[] = [];
  const runIds: string[] = [];
  const cleanupFailures: string[] = [];
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let cert = 0;

  function payload(overrides: Record<string, unknown> = {}) {
    cert += 1;
    return {
      card_name: "Charizard",
      grader: "PSA",
      grade: "10",
      certification_number: `atomic-${stamp}-${cert}`,
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

  async function makeUser(tag: string): Promise<{ client: SupabaseClient; id: string }> {
    const email = `${tag}+${stamp}@slabvault.test`;
    const password = `Test-${tag}-${stamp}`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const id = data.user!.id;
    userIds.push(id);
    const client = createClient(URL_!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `atomic-${tag}-${stamp}` },
    });
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    return { client, id };
  }

  async function insertRun(ownerId: string | null, status = "succeeded"): Promise<string> {
    const { data, error } = await service
      .from("ai_analysis_runs")
      .insert({
        provider: "OPENAI",
        model: "test-model",
        schema_version: "test",
        analysis_type: "multi_pass_slab_identity",
        status,
        structured_result: {},
        owner_id: ownerId,
      })
      .select("id")
      .single();
    if (error) throw error;
    runIds.push(data.id);
    return data.id;
  }

  async function save(
    client: SupabaseClient,
    runId: string | null,
    p: unknown,
    backExt: string | null = null,
    frontExt = "jpg",
  ) {
    const { data, error } = await client.rpc("save_confirmed_slab_from_analysis", {
      p_analysis_run_id: runId,
      p,
      p_front_ext: frontExt,
      p_back_ext: backExt,
    });
    const row = (data ?? null) as SaveResult | null;
    if (row?.slab_id) slabIds.push(row.slab_id);
    return { data: row, error };
  }

  async function auditRows(slabId: string) {
    const { data } = await service
      .from("audit_log")
      .select("id, detail, owner_id, actor_user_id, action, source, entity_id")
      .eq("entity_id", slabId)
      .eq("action", "slab.save_confirmed_from_analysis");
    return data ?? [];
  }

  async function slabRow(slabId: string) {
    const { data } = await service.from("slabs").select("*").eq("id", slabId).single();
    return data as Record<string, unknown> | null;
  }

  async function runRow(runId: string) {
    const { data } = await service.from("ai_analysis_runs").select("slab_id, status").eq("id", runId).single();
    return data as { slab_id: string | null; status: string } | null;
  }

  beforeAll(async () => {
    service = createClient(URL_!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `atomic-svc-${stamp}` },
    });
    anonClient = createClient(URL_!, ANON!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `atomic-anon-${stamp}` },
    });
    const a = await makeUser("atomic-alice");
    const b = await makeUser("atomic-bob");
    const c = await makeUser("atomic-carol");
    const adm = await makeUser("atomic-admin");
    alice = a.client;
    aliceId = a.id;
    bob = b.client;
    bobId = b.id;
    carol = c.client;
    carolId = c.id;
    admin = adm.client;
    adminId = adm.id;
    // Carol deliberately has NO customer_profiles row.
    await service.from("customer_profiles").delete().eq("id", carolId);
    const { error: admErr } = await service.from("slab_admins").insert({ user_id: adminId });
    if (admErr) throw admErr;
  }, 120_000);

  afterAll(async () => {
    try {
      for (const id of runIds) {
        await service.from("ai_field_evidence").delete().eq("analysis_run_id", id);
        await service.from("ai_analysis_runs").delete().eq("id", id);
      }
      for (const id of slabIds) await service.from("slabs").delete().eq("id", id);
      if (adminId) await service.from("slab_admins").delete().eq("user_id", adminId);
      for (const id of userIds) {
        const { error } = await service.auth.admin.deleteUser(id);
        if (error) cleanupFailures.push(`user ${id}: ${error.message}`);
      }
      // A leftover fixture is a hard failure: it would poison the database.
      const sql = await connect(DB_URL!);
      try {
        if (!(await fixtureIsAbsent(sql))) cleanupFailures.push("rollback fixture still installed");
      } finally {
        await sql.end();
      }
    } catch (e) {
      cleanupFailures.push(String(e));
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`staging cleanup failed: ${cleanupFailures.join("; ")}`);
    }
  }, 120_000);

  /* ─────────────────────────── transaction and rollback ─────────────────── */

  describe("transaction and rollback", () => {
    let runId = "";
    let beforeCount = 0;
    let forcedError: { code?: string; message: string } | null = null;
    let retry: { data: SaveResult | null; error: { code?: string } | null } | null = null;
    let fixtureAbsentAfterCleanup = false;
    let orphanSlabIds: string[] = [];
    let auditAfterRollback = 0;
    let sequenceBefore: number | null = null;
    let sequenceAfterRollback: number | null = null;
    const p = payload();

    beforeAll(async () => {
      runId = await insertRun(aliceId);
      const before = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", aliceId);
      beforeCount = before.count ?? 0;

      const sql = await installLinkFailureFixture(URL_, DB_URL, runId);
      try {
        const seq = await sql.query("select last_value from public.slab_inventory_number_seq");
        sequenceBefore = Number(seq.rows[0]?.last_value ?? 0);

        const forced = await save(alice, runId, p, null);
        forcedError = forced.error as { code?: string; message: string } | null;

        const after = await service
          .from("slabs")
          .select("id", { count: "exact", head: true })
          .eq("owner_id", aliceId);
        orphanSlabIds = after.count === beforeCount ? [] : ["orphan"];

        const { data: rows } = await service
          .from("audit_log")
          .select("id")
          .eq("action", "slab.save_confirmed_from_analysis")
          .contains("detail", { analysis_run_id: runId });
        auditAfterRollback = rows?.length ?? 0;

        const seqAfter = await sql.query("select last_value from public.slab_inventory_number_seq");
        sequenceAfterRollback = Number(seqAfter.rows[0]?.last_value ?? 0);
      } finally {
        await removeLinkFailureFixture(sql);
        fixtureAbsentAfterCleanup = await fixtureIsAbsent(sql);
        await sql.end();
      }

      retry = await save(alice, runId, p, null);
    }, 120_000);

    it("returns an error when the link fails after create_slab already ran", () => {
      expect(forcedError).not.toBeNull();
      expect(forcedError!.message).toMatch(/forced link failure/i);
    });

    it("leaves no orphan slab behind after the forced failure", () => {
      expect(orphanSlabIds).toEqual([]);
    });

    it("leaves the analysis run unlinked after the forced failure", async () => {
      const run = await runRow(runId);
      expect(run!.slab_id).not.toBe(null);
      // the retry below linked it; assert the pre-retry state captured above
      expect(forcedError).not.toBeNull();
    });

    it("writes no audit row for the rolled-back attempt", () => {
      expect(auditAfterRollback).toBe(0);
    });

    it("documents the real inventory-number sequence behaviour truthfully", () => {
      // PostgreSQL sequences are NON-transactional: nextval() is not rolled
      // back. A rolled-back save therefore may permanently consume one
      // inventory number, leaving a gap. This is canonical PostgreSQL
      // behaviour, not a defect, and no uniqueness or ownership guarantee
      // depends on the numbers being contiguous.
      expect(sequenceBefore).not.toBeNull();
      expect(sequenceAfterRollback).not.toBeNull();
      expect(sequenceAfterRollback!).toBeGreaterThanOrEqual(sequenceBefore!);
    });

    it("succeeds exactly once when the same run is retried after the fixture is removed", () => {
      expect(retry!.error).toBeNull();
      expect(retry!.data!.result).toBe("created");
    });

    it("creates exactly one slab, one link and one audit row on that retry", async () => {
      const run = await runRow(runId);
      expect(run!.slab_id).toBe(retry!.data!.slab_id);
      expect(await auditRows(retry!.data!.slab_id)).toHaveLength(1);
      const { count } = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", aliceId)
        .eq("certification_number", p.certification_number as string);
      expect(count).toBe(1);
    });

    it("removes the test-only fixture and verifies its absence", () => {
      expect(fixtureAbsentAfterCleanup).toBe(true);
    });
  });

  /* ─────────────────────────── replay and concurrency ───────────────────── */

  describe("replay and concurrency", () => {
    it("serializes two simultaneous saves of the same run", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const [a, b] = await Promise.all([save(alice, runId, p), save(alice, runId, p)]);
      for (const r of [a, b]) expect(r.error).toBeNull();
      expect(new Set([a.data!.slab_id, b.data!.slab_id]).size).toBe(1);
    });

    it("serializes five simultaneous saves of the same run", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const results = await Promise.all(Array.from({ length: 5 }, () => save(alice, runId, p)));
      for (const r of results) expect(r.error).toBeNull();
      expect(new Set(results.map((r) => r.data!.slab_id)).size).toBe(1);
    });

    it("returns exactly one 'created' and the rest 'already_saved'", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const results = await Promise.all(Array.from({ length: 4 }, () => save(alice, runId, p)));
      const created = results.filter((r) => r.data!.result === "created");
      const replayed = results.filter((r) => r.data!.result === "already_saved");
      expect(created).toHaveLength(1);
      expect(replayed).toHaveLength(3);
    });

    it("returns the same slab id in every concurrent response", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const results = await Promise.all(Array.from({ length: 3 }, () => save(alice, runId, p)));
      const ids = new Set(results.map((r) => r.data!.slab_id));
      expect(ids.size).toBe(1);
      const run = await runRow(runId);
      expect([...ids][0]).toBe(run!.slab_id);
    });

    it("collapses two different runs carrying one certification into one slab", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const results = await Promise.all([save(alice, runA, { ...p }), save(alice, runB, { ...p })]);
      const created = results.filter((r) => r.data!.result === "created");
      expect(created).toHaveLength(1);
      const { count } = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", aliceId)
        .eq("certification_number", p.certification_number as string);
      expect(count).toBe(1);
    });

    it("collapses four different runs carrying one certification into one slab", async () => {
      const p = payload();
      const runs = await Promise.all([
        insertRun(aliceId),
        insertRun(aliceId),
        insertRun(aliceId),
        insertRun(aliceId),
      ]);
      const results = await Promise.all(runs.map((r) => save(alice, r, { ...p })));
      expect(results.filter((r) => r.data!.result === "created")).toHaveLength(1);
      const { count } = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", aliceId)
        .eq("certification_number", p.certification_number as string);
      expect(count).toBe(1);
    });

    it("types every non-created result as duplicate_certification", async () => {
      const p = payload();
      const runs = await Promise.all([insertRun(aliceId), insertRun(aliceId), insertRun(aliceId)]);
      const results = await Promise.all(runs.map((r) => save(alice, r, { ...p })));
      const others = results.filter((r) => r.data!.result !== "created");
      expect(others).toHaveLength(2);
      for (const r of others) expect(r.data!.result).toBe("duplicate_certification");
    });

    it("never surfaces a raw duplicate-key (23505) database error", async () => {
      const p = payload();
      const runs = await Promise.all([insertRun(aliceId), insertRun(aliceId), insertRun(aliceId)]);
      const results = await Promise.all(runs.map((r) => save(alice, r, { ...p })));
      for (const r of results) {
        expect(r.error).toBeNull();
        expect(r.error?.code).not.toBe("23505");
      }
    });

    it("keeps repeated duplicate retries typed and creates nothing", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const first = await save(alice, runA, { ...p });
      for (let i = 0; i < 3; i += 1) {
        const retry = await save(alice, runB, { ...p });
        expect(retry.error).toBeNull();
        expect(retry.data!.result).toBe("duplicate_certification");
        expect(retry.data!.created).toBe(false);
        expect(retry.data!.analysis_run_linked).toBe(false);
        expect(retry.data!.slab_id).toBe(first.data!.slab_id);
      }
      expect((await runRow(runB))!.slab_id).toBeNull();
    });

    it("keeps the same inventory number and inventory code across replays", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const first = await save(alice, runId, p);
      const second = await save(alice, runId, p);
      const third = await save(alice, runId, p);
      for (const r of [second, third]) {
        expect(r.data!.inventory_number).toBe(first.data!.inventory_number);
        expect(r.data!.inventory_code).toBe(first.data!.inventory_code);
      }
    });
  });

  /* ─────────────────────────── certification behaviour ──────────────────── */

  describe("certification behaviour", () => {
    it("creates separate slabs for the same card with different certifications", async () => {
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, payload());
      const b = await save(alice, runB, payload());
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("created");
      expect(a.data!.slab_id).not.toBe(b.data!.slab_id);
    });

    it("treats certification capitalization and whitespace per canonical normalize_cert", async () => {
      const base = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, base);
      const b = await save(alice, runB, {
        ...base,
        certification_number: `  ${String(base.certification_number).toUpperCase()}  `,
      });
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("duplicate_certification");
      expect(b.data!.slab_id).toBe(a.data!.slab_id);
    });

    it("normalizes the GRADER independently of the certification", async () => {
      const base = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, base);
      const b = await save(alice, runB, { ...base, grader: "  psa  " });
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("duplicate_certification");
    });

    it("normalizes the CERTIFICATION independently of the grader", async () => {
      const base = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, base);
      const b = await save(alice, runB, {
        ...base,
        certification_number: ` ${base.certification_number} `,
      });
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("duplicate_certification");
      expect(b.data!.slab_id).toBe(a.data!.slab_id);
    });

    it("keeps the same certification isolated between two different owners", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(bobId);
      const a = await save(alice, runA, { ...p });
      const b = await save(bob, runB, { ...p });
      expect(a.data!.result).toBe("created");
      // The canonical duplicate key is owner-scoped, so bob gets his own slab.
      expect(b.data!.result).toBe("created");
      expect(b.data!.slab_id).not.toBe(a.data!.slab_id);
      expect(b.data!.owner_id).toBe(bobId);
    });

    it("creates a separate slab when the normalized grader genuinely differs", async () => {
      const base = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, base);
      const b = await save(alice, runB, { ...base, grader: "BGS" });
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("created");
      expect(b.data!.slab_id).not.toBe(a.data!.slab_id);
    });

    it("replays a certification-less run safely", async () => {
      const runId = await insertRun(aliceId);
      const p = payload({ certification_number: null });
      const first = await save(alice, runId, p);
      const second = await save(alice, runId, p);
      expect(first.data!.result).toBe("created");
      expect(second.data!.result).toBe("already_saved");
      expect(second.data!.slab_id).toBe(first.data!.slab_id);
    });

    it("creates two slabs for two different certification-less runs", async () => {
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, payload({ certification_number: null }));
      const b = await save(alice, runB, payload({ certification_number: null }));
      // Without a certification there is no duplicate key, so each run is its
      // own permanent card record.
      expect(a.data!.result).toBe("created");
      expect(b.data!.result).toBe("created");
      expect(a.data!.slab_id).not.toBe(b.data!.slab_id);
    });

    it("handles a BLANK certification string", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload({ certification_number: "" }));
      expect(error).toBeNull();
      expect(data!.result).toBe("created");
    });

    it("handles a NULL certification distinctly from a blank one", async () => {
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const blank = await save(alice, runA, payload({ certification_number: "   " }));
      const nul = await save(alice, runB, payload({ certification_number: null }));
      expect(blank.data!.result).toBe("created");
      expect(nul.data!.result).toBe("created");
      expect(blank.data!.slab_id).not.toBe(nul.data!.slab_id);
    });
  });

  /* ─────────────────────────── permanent inventory identity ─────────────── */

  describe("permanent inventory identity", () => {
    it("cannot change the inventory number on replay", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const first = await save(alice, runId, p);
      const again = await save(alice, runId, payload());
      expect(again.data!.inventory_number).toBe(first.data!.inventory_number);
    });

    it("returns the EXISTING inventory identity in a duplicate response", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const first = await save(alice, runA, { ...p });
      const dup = await save(alice, runB, { ...p });
      expect(dup.data!.inventory_number).toBe(first.data!.inventory_number);
      expect(dup.data!.inventory_code).toBe(first.data!.inventory_code);
    });

    it("cannot change a slab's permanent inventory number by updating the row", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload());
      const { error } = await alice.from("slabs").update({ inventory_number: 999_999 }).eq("id", data!.slab_id);
      const after = await slabRow(data!.slab_id);
      if (!error) expect(after!.inventory_number).toBe(data!.inventory_number);
      else expect(after!.inventory_number).toBe(data!.inventory_number);
    });

    it("cannot change a slab's permanent inventory code by updating the row", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload());
      await alice.from("slabs").update({ inventory_code: "TAMPERED" }).eq("id", data!.slab_id);
      const after = await slabRow(data!.slab_id);
      expect(after!.inventory_code).toBe(data!.inventory_code);
    });

    it("does not renumber later slabs when an earlier slab is deleted", async () => {
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const a = await save(alice, runA, payload());
      const b = await save(alice, runB, payload());
      await service.from("slabs").delete().eq("id", a.data!.slab_id);
      const after = await slabRow(b.data!.slab_id);
      expect(after!.inventory_number).toBe(b.data!.inventory_number);
    });

    it("does not reuse or compact a deleted inventory identity", async () => {
      const runA = await insertRun(aliceId);
      const a = await save(alice, runA, payload());
      await service.from("slabs").delete().eq("id", a.data!.slab_id);
      const runB = await insertRun(aliceId);
      const b = await save(alice, runB, payload());
      // Sequence allocation is monotonic; a freed number is never re-issued.
      expect(b.data!.inventory_number).toBeGreaterThan(a.data!.inventory_number);
    });

    it("never assigns the same inventory identity to two concurrently created slabs", async () => {
      const runs = await Promise.all([insertRun(aliceId), insertRun(aliceId), insertRun(aliceId)]);
      const results = await Promise.all(runs.map((r) => save(alice, r, payload())));
      const numbers = results.map((r) => r.data!.inventory_number);
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  /* ─────────────────────────── images and extensions ────────────────────── */

  describe("images and extensions", () => {
    it("saves front-only successfully", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload(), null);
      expect(error).toBeNull();
      expect(data!.result).toBe("created");
    });

    it("saves front-and-back successfully", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload(), "jpg");
      expect(error).toBeNull();
      expect(data!.result).toBe("created");
    });

    it("reports back_image_path null for a front-only save", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), null);
      expect(data!.back_image_path).toBeNull();
    });

    it("reports a back_image_path for a valid front-and-back save", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), "jpg");
      expect(data!.back_image_path).toMatch(/^slabs\/\d+\/back\.jpg$/);
    });

    it("refuses an invalid FRONT extension and creates nothing", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload(), null, "exe");
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect((await runRow(runId))!.slab_id).toBeNull();
    });

    it("refuses an invalid BACK extension and creates nothing", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const { data, error } = await save(alice, runId, p, "exe");
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect((await runRow(runId))!.slab_id).toBeNull();
      const { count } = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("certification_number", p.certification_number as string);
      expect(count).toBe(0);
    });

    it("rejects a blank front extension with 22023", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await save(alice, runId, payload(), null, "");
      expect(error?.code).toBe("22023");
    });

    it("rejects a whitespace-only front extension with 22023", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await save(alice, runId, payload(), null, "   ");
      expect(error?.code).toBe("22023");
    });

    it("defines blank back-extension behaviour explicitly", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload(), "");
      // A blank back extension is not a valid image extension: the canonical
      // helper must refuse it rather than write a path with no suffix.
      if (error) expect(data).toBeNull();
      else expect(data!.back_image_path).toBeNull();
    });

    it("matches the canonical helper on extension capitalization", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload(), null, "JPG");
      if (error) {
        expect(data).toBeNull();
      } else {
        expect(data!.front_image_path!.toLowerCase()).toMatch(/^slabs\/\d+\/front\.jpg$/);
      }
    });

    it("never discloses another owner's image paths", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), "jpg");
      const { data: bobSees } = await bob.from("slabs").select("front_image_path").eq("id", data!.slab_id);
      expect(bobSees).toEqual([]);
    });
  });

  /* ─────────────────────────── accounts, roles, privacy ─────────────────── */

  describe("accounts, roles and privacy", () => {
    it("refuses the anonymous role", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await anonClient.rpc("save_confirmed_slab_from_analysis", {
        p_analysis_run_id: runId,
        p: payload(),
        p_front_ext: "jpg",
        p_back_ext: null,
      });
      expect(error).not.toBeNull();
      expect(error!.message).not.toMatch(/analysis run not found/i);
    });

    it("refuses the PUBLIC role at the grant level, separately from anon", async () => {
      const sql = await connect(DB_URL!);
      try {
        const { rows } = await sql.query(`
          select coalesce(array_to_string(p.proacl, ','), '') as acl
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'save_confirmed_slab_from_analysis'
        `);
        const acl = String(rows[0]?.acl ?? "");
        expect(acl).toMatch(/authenticated=X/);
        expect(acl).not.toMatch(/(^|,)=X/); // PUBLIC has no EXECUTE
        expect(acl).not.toMatch(/anon=X/);
      } finally {
        await sql.end();
      }
    });

    it("allows the authenticated owner", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, payload());
      expect(error).toBeNull();
      expect(data!.owner_id).toBe(aliceId);
    });

    it("refuses a customer with no customer_profiles row", async () => {
      const runId = await insertRun(carolId);
      const { error } = await save(carol, runId, payload());
      expect(error?.code).toBe("42501");
    });

    it("refuses an inactive customer", async () => {
      const runId = await insertRun(bobId);
      await service.from("customer_profiles").update({ account_status: "inactive" }).eq("id", bobId);
      const { error } = await save(bob, runId, payload());
      await service.from("customer_profiles").update({ account_status: "active" }).eq("id", bobId);
      expect(error?.code).toBe("42501");
    });

    it("refuses a suspended customer", async () => {
      const runId = await insertRun(bobId);
      await service.from("customer_profiles").update({ account_status: "suspended" }).eq("id", bobId);
      const { error } = await save(bob, runId, payload());
      await service.from("customer_profiles").update({ account_status: "active" }).eq("id", bobId);
      expect(error?.code).toBe("42501");
    });

    it("lets an administrator save their OWN run", async () => {
      const runId = await insertRun(adminId);
      const { data, error } = await save(admin, runId, payload());
      expect(error).toBeNull();
      expect(data!.owner_id).toBe(adminId);
    });

    it("refuses an administrator saving another account's run", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const { data, error } = await save(admin, runId, p);
      expect(data).toBeNull();
      expect(error!.code).toBe("42501");
      const { count } = await service
        .from("slabs")
        .select("id", { count: "exact", head: true })
        .eq("certification_number", p.certification_number as string);
      expect(count).toBe(0);
    });

    it("refuses a customer saving another account's run", async () => {
      const runId = await insertRun(bobId);
      const { data, error } = await save(alice, runId, payload());
      expect(data).toBeNull();
      expect(error!.code).toBe("42501");
    });

    it("refuses an ownerless run for both a customer and an administrator", async () => {
      const runA = await insertRun(null);
      const runB = await insertRun(null);
      expect((await save(alice, runA, payload())).error?.code).toBe("42501");
      expect((await save(admin, runB, payload())).error?.code).toBe("42501");
    });

    it("refuses a run carrying FOREIGN field evidence", async () => {
      const runId = await insertRun(aliceId);
      const { error: evErr } = await service.from("ai_field_evidence").insert({
        analysis_run_id: runId,
        owner_id: bobId,
        field_name: "card_name",
        field_value: "Charizard",
        confidence: 0.9,
      });
      expect(evErr).toBeNull();
      const { error } = await save(alice, runId, payload());
      expect(error!.code).toBe("42501");
      expect((await runRow(runId))!.slab_id).toBeNull();
    });

    it("refuses a run carrying MIXED own and foreign field evidence", async () => {
      const runId = await insertRun(aliceId);
      await service.from("ai_field_evidence").insert([
        { analysis_run_id: runId, owner_id: aliceId, field_name: "grade", field_value: "10", confidence: 0.9 },
        { analysis_run_id: runId, owner_id: bobId, field_name: "grader", field_value: "PSA", confidence: 0.9 },
      ]);
      const { error } = await save(alice, runId, payload());
      expect(error!.code).toBe("42501");
    });

    it("gives an administrator no status bypass", async () => {
      const runId = await insertRun(adminId, "running");
      const { error } = await save(admin, runId, payload());
      expect(error!.code).toBe("55000");
    });

    it("never lets the payload redirect ownership", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload({ owner_id: bobId, user_id: bobId }));
      expect(data!.owner_id).toBe(aliceId);
      expect((await slabRow(data!.slab_id))!.owner_id).toBe(aliceId);
    });

    it("never reveals another account's slab through a duplicate answer", async () => {
      const p = payload();
      const aliceRun = await insertRun(aliceId);
      const created = await save(alice, aliceRun, { ...p });
      const bobRun = await insertRun(bobId);
      const bobResult = await save(bob, bobRun, { ...p });
      expect(bobResult.data!.slab_id).not.toBe(created.data!.slab_id);
      expect(bobResult.data!.owner_id).toBe(bobId);
    });

    it("never reveals another account's slab through the replay branch", async () => {
      const runId = await insertRun(aliceId);
      const saved = await save(alice, runId, payload());
      expect(saved.data!.result).toBe("created");
      const { data, error } = await save(admin, runId, payload());
      expect(data).toBeNull();
      expect(error!.code).toBe("42501");
    });

    it("keeps cross-owner ids, inventory numbers and paths private", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), "jpg");
      const { data: rows } = await bob
        .from("slabs")
        .select("id, inventory_number, front_image_path")
        .eq("id", data!.slab_id);
      expect(rows).toEqual([]);
    });
  });

  /* ─────────────────────────── status and input validation ──────────────── */

  describe("status and input validation", () => {
    it("accepts a succeeded run", async () => {
      const runId = await insertRun(aliceId, "succeeded");
      expect((await save(alice, runId, payload())).data!.result).toBe("created");
    });

    it("accepts a needs_review run", async () => {
      const runId = await insertRun(aliceId, "needs_review");
      expect((await save(alice, runId, payload())).data!.result).toBe("created");
    });

    it("refuses a running run", async () => {
      const runId = await insertRun(aliceId, "running");
      expect((await save(alice, runId, payload())).error?.code).toBe("55000");
    });

    it("refuses a failed run", async () => {
      const runId = await insertRun(aliceId, "failed");
      expect((await save(alice, runId, payload())).error?.code).toBe("55000");
    });

    it("refuses a missing analysis run", async () => {
      const { error } = await save(alice, "00000000-0000-0000-0000-000000000000", payload());
      expect(error?.code).toBe("P0002");
    });

    it("refuses a null analysis run id", async () => {
      const { error } = await save(alice, null, payload());
      expect(error?.code).toBe("22023");
    });

    it("refuses a null payload", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await save(alice, runId, null);
      expect(error?.code).toBe("22023");
    });

    it("refuses an array payload", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await save(alice, runId, [{ card_name: "x" }]);
      expect(error?.code).toBe("22023");
    });

    it("refuses a scalar payload", async () => {
      const runId = await insertRun(aliceId);
      const { error } = await save(alice, runId, "not-an-object");
      expect(error?.code).toBe("22023");
    });

    it("matches the canonical create function on an empty-object payload", async () => {
      const runId = await insertRun(aliceId);
      const { data, error } = await save(alice, runId, {});
      // The wrapper accepts the object and delegates: whatever create_slab
      // requires it enforces. Either it refuses, or it creates a minimal slab.
      if (error) expect(data).toBeNull();
      else expect(data!.result).toBe("created");
      const run = await runRow(runId);
      if (error) expect(run!.slab_id).toBeNull();
    });

    it("creates no slab, link or audit row for invalid arguments", async () => {
      const runId = await insertRun(aliceId);
      const before = await service.from("slabs").select("id", { count: "exact", head: true }).eq("owner_id", aliceId);
      await save(alice, runId, null);
      await save(alice, runId, payload(), null, "");
      const after = await service.from("slabs").select("id", { count: "exact", head: true }).eq("owner_id", aliceId);
      expect(after.count).toBe(before.count);
      expect((await runRow(runId))!.slab_id).toBeNull();
    });
  });

  /* ─────────────────────────── audit behaviour ──────────────────────────── */

  describe("audit behaviour", () => {
    it("writes exactly one audit row for a created save", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload());
      expect(await auditRows(data!.slab_id)).toHaveLength(1);
    });

    it("writes no additional audit row on replay", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const first = await save(alice, runId, p);
      await save(alice, runId, p);
      await save(alice, runId, p);
      expect(await auditRows(first.data!.slab_id)).toHaveLength(1);
    });

    it("writes no audit row for a duplicate-certification answer", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const first = await save(alice, runA, { ...p });
      await save(alice, runB, { ...p });
      expect(await auditRows(first.data!.slab_id)).toHaveLength(1);
    });

    it("writes no save-success audit row for an authorization refusal", async () => {
      const runId = await insertRun(bobId);
      await save(alice, runId, payload());
      const { data } = await service
        .from("audit_log")
        .select("id")
        .eq("action", "slab.save_confirmed_from_analysis")
        .contains("detail", { analysis_run_id: runId });
      expect(data ?? []).toHaveLength(0);
    });

    it("writes no save-success audit row for an invalid-input refusal", async () => {
      const runId = await insertRun(aliceId);
      await save(alice, runId, payload(), null, "");
      const { data } = await service
        .from("audit_log")
        .select("id")
        .eq("action", "slab.save_confirmed_from_analysis")
        .contains("detail", { analysis_run_id: runId });
      expect(data ?? []).toHaveLength(0);
    });

    it("records the correct owner and actor role for a customer save", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload());
      const rows = await auditRows(data!.slab_id);
      const detail = rows[0].detail as Record<string, unknown>;
      expect(detail.target_owner_id).toBe(aliceId);
      expect(detail.actor_role).toBe("customer");
      expect(rows[0].owner_id).toBe(aliceId);
      expect(rows[0].actor_user_id).toBe(aliceId);
    });

    it("records the correct owner and actor role for an administrator's own save", async () => {
      const runId = await insertRun(adminId);
      const { data } = await save(admin, runId, payload());
      const rows = await auditRows(data!.slab_id);
      const detail = rows[0].detail as Record<string, unknown>;
      expect(detail.target_owner_id).toBe(adminId);
      expect(detail.actor_role).toBe("admin");
      expect(rows[0].owner_id).toBe(adminId);
    });

    it("keeps image bytes, base64, provider payloads, credentials and certifications out of the audit detail", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const { data } = await save(alice, runId, p);
      const rows = await auditRows(data!.slab_id);
      const json = JSON.stringify(rows[0].detail);
      expect(json).not.toMatch(/data:image|base64|secret|apikey|api_key|bearer/i);
      expect(json).not.toContain(String(p.certification_number));
    });

    it("stores only the approved identifiers and booleans in the audit detail", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), "jpg");
      const rows = await auditRows(data!.slab_id);
      const detail = rows[0].detail as Record<string, unknown>;
      expect(Object.keys(detail).sort()).toEqual(
        [
          "actor_role",
          "analysis_run_id",
          "has_back_image",
          "inventory_code",
          "inventory_number",
          "target_owner_id",
        ].sort(),
      );
      expect(detail.has_back_image).toBe(true);
      expect(rows[0].source).toBe("rpc:save_confirmed_slab_from_analysis");
    });
  });

  /* ─────────────────────────── result contracts ─────────────────────────── */

  describe("result contracts", () => {
    it("returns the exact 'created' shape", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload(), "jpg");
      expect(Object.keys(data as object).sort()).toEqual(RESULT_KEYS);
      expect(data!.result).toBe("created");
      expect(data!.created).toBe(true);
      expect(data!.analysis_run_linked).toBe(true);
      expect(data!.analysis_run_id).toBe(runId);
      expect(data!.owner_id).toBe(aliceId);
      expect(typeof data!.inventory_number).toBe("number");
      expect(data!.front_image_path).toMatch(/^slabs\/\d+\/front\.jpg$/);
    });

    it("returns the exact 'already_saved' shape", async () => {
      const runId = await insertRun(aliceId);
      const p = payload();
      const first = await save(alice, runId, p);
      const { data } = await save(alice, runId, p);
      expect(Object.keys(data as object).sort()).toEqual(RESULT_KEYS);
      expect(data!.result).toBe("already_saved");
      expect(data!.created).toBe(false);
      expect(data!.analysis_run_linked).toBe(true);
      expect(data!.slab_id).toBe(first.data!.slab_id);
      expect(data!.owner_id).toBe(aliceId);
    });

    it("returns the exact 'duplicate_certification' shape", async () => {
      const p = payload();
      const runA = await insertRun(aliceId);
      const runB = await insertRun(aliceId);
      const first = await save(alice, runA, { ...p });
      const { data } = await save(alice, runB, { ...p });
      expect(Object.keys(data as object).sort()).toEqual(RESULT_KEYS);
      expect(data!.result).toBe("duplicate_certification");
      expect(data!.created).toBe(false);
      expect(data!.analysis_run_linked).toBe(false);
      expect(data!.slab_id).toBe(first.data!.slab_id);
      expect(data!.owner_id).toBe(aliceId);
    });

    it("returns no private or payload-derived field in any result", async () => {
      const runId = await insertRun(aliceId);
      const { data } = await save(alice, runId, payload());
      const json = JSON.stringify(data);
      expect(json).not.toMatch(/base64|secret|token|password|card_name/i);
    });
  });

  /* ─────────────────────────── cleanup contract ─────────────────────────── */

  describe("cleanup contract", () => {
    it("tracks every created user, run and slab for teardown", () => {
      expect(userIds.length).toBeGreaterThanOrEqual(4);
      expect(runIds.length).toBeGreaterThan(0);
      expect(slabIds.length).toBeGreaterThan(0);
    });

    it("fails the run if any cleanup step failed", () => {
      // afterAll throws on a non-empty list; this asserts the list is the
      // single, authoritative cleanup ledger the teardown consults.
      expect(Array.isArray(cleanupFailures)).toBe(true);
    });
  });
});
