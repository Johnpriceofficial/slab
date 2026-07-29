import { describe, expect, it } from "vitest";
import saveSql from "../../../supabase/migrations/20260907000000_save_confirmed_slab_from_analysis.sql?raw";

// Static contract for the atomic confirmed-save path. These assertions guard the
// properties the frontend relies on: one transaction, one slab, owner-scoped
// identity, and typed (never generic) refusals.
describe("save_confirmed_slab_from_analysis migration", () => {
  it("declares the wrapper as a SECURITY DEFINER function with a pinned search_path", () => {
    expect(saveSql).toContain(
      "create or replace function public.save_confirmed_slab_from_analysis(",
    );
    expect(saveSql).toContain("p_analysis_run_id uuid");
    expect(saveSql).toContain("p_back_ext text default null");
    expect(saveSql).toContain("returns jsonb");
    expect(saveSql).toContain("security definer");
    expect(saveSql).toContain("set search_path = public, auth");
  });

  it("takes identity from auth.uid() only and never from the payload", () => {
    expect(saveSql).toContain("v_actor        uuid := (select auth.uid());");
    expect(saveSql).toContain("v_target_owner := v_actor;");
    expect(saveSql).not.toMatch(/p->>'owner_id'/);
    expect(saveSql).not.toMatch(/p->>'user_id'/);
    expect(saveSql).not.toMatch(/p_owner_id|p_user_id/);
  });

  it("requires authentication and an active customer profile for non-admins", () => {
    expect(saveSql).toContain("if v_actor is null then");
    expect(saveSql).toContain("v_is_admin := public.is_admin(v_actor);");
    expect(saveSql).toContain("from public.customer_profiles cp");
    expect(saveSql).toContain("if v_status is distinct from 'active' then");
  });

  it("locks the analysis run FOR UPDATE so concurrent saves serialize", () => {
    expect(saveSql).toContain("from public.ai_analysis_runs");
    expect(saveSql).toContain("where id = p_analysis_run_id");
    expect(saveSql).toContain("for update;");
  });

  it("is idempotent: an already-linked run returns the existing slab", () => {
    expect(saveSql).toContain("if v_run.slab_id is not null then");
    expect(saveSql).toContain("'result', 'already_saved'");
    expect(saveSql).toContain("'created', false");
  });

  it("reports an existing certification instead of overwriting it", () => {
    expect(saveSql).toContain("public.normalize_grader(");
    expect(saveSql).toContain("public.normalize_cert(");
    expect(saveSql).toContain("'result', 'duplicate_certification'");
    expect(saveSql).not.toMatch(/\bupdate public\.slabs\b/);
    expect(saveSql).not.toMatch(/\bdelete from public\.slabs\b/);
  });

  it("takes create_slab's advisory lock BEFORE probing for a duplicate certification", () => {
    // Canonical create_slab (20260833000000) serializes intake on
    // pg_advisory_xact_lock(918273645). Probing without it would race.
    const lockAt = saveSql.indexOf("perform pg_advisory_xact_lock(918273645);");
    const probeAt = saveSql.indexOf("public.normalize_grader(");
    // lastIndexOf: the header comment also names the call.
    const createAt = saveSql.lastIndexOf("v_slab := public.create_slab(p, p_front_ext, p_back_ext);");
    expect(lockAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(lockAt);
    expect(createAt).toBeGreaterThan(lockAt);
    // Exactly one acquisition, and no other lock id is introduced.
    expect(saveSql.match(/perform pg_advisory_xact_lock\(/g)).toHaveLength(1);
    expect(saveSql).not.toMatch(/perform pg_advisory_xact_lock\((?!918273645\))/);
    // Session-scoped locks would leak past the transaction.
    expect(saveSql).not.toContain("pg_advisory_lock(");
  });

  it("holds the run lock before the certification lock, so both are ordered", () => {
    const runLockAt = saveSql.indexOf("for update;");
    const certLockAt = saveSql.indexOf("perform pg_advisory_xact_lock(918273645);");
    expect(runLockAt).toBeGreaterThan(-1);
    expect(certLockAt).toBeGreaterThan(runLockAt);
  });


  it("composes create + link atomically in one transaction", () => {
    const createAt = saveSql.indexOf("public.create_slab(p, p_front_ext, p_back_ext)");
    const linkAt = saveSql.indexOf("perform public.link_ai_analysis_run(p_analysis_run_id, v_slab.id);");
    expect(createAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(createAt);
    // No exception handler may swallow the link failure and leave an orphan slab.
    expect(saveSql).not.toContain("exception when");
    expect(saveSql).not.toContain("commit;");
  });

  it("enforces the saveable-status gate for EVERY caller, admins included", () => {
    expect(saveSql).toContain("if v_run.status not in ('succeeded', 'needs_review') then");
    // No administrator override may reintroduce saving a running/failed run.
    expect(saveSql).not.toContain("if not v_is_admin and v_run.status not in");
  });

  it("derives one server-owned target owner and never widens it for admins", () => {
    expect(saveSql).toContain("v_target_owner uuid;");
    expect(saveSql).toContain("v_target_owner := v_actor;");
    // Run ownership is checked unconditionally — not behind `if not v_is_admin`.
    expect(saveSql).toContain("if v_run.owner_id is null then");
    expect(saveSql).toContain("if v_run.owner_id <> v_target_owner then");
    expect(saveSql).not.toContain("if not v_is_admin and v_run.owner_id");
    // The chosen policy is fail-closed: no owner is ever taken from the run
    // or the payload to impersonate another account.
    expect(saveSql).not.toMatch(/v_target_owner\s*:=\s*v_run\.owner_id/);
  });

  it("scopes duplicate lookup, replay and audit to the target owner", () => {
    expect(saveSql).toContain("where owner_id = v_target_owner");
    expect(saveSql).toContain(
      "if v_slab.owner_id is null or v_slab.owner_id <> v_target_owner then",
    );
    expect(saveSql).toContain("'target_owner_id', v_target_owner");
    expect(saveSql).toContain("'owner_id', v_slab.owner_id");
  });

  it("asserts the created slab is owned by the target owner before linking", () => {
    const assertAt = saveSql.indexOf("if v_slab.owner_id is distinct from v_target_owner then");
    const createAt = saveSql.indexOf("public.create_slab(p, p_front_ext, p_back_ext)");
    const linkAt = saveSql.indexOf("perform public.link_ai_analysis_run(");
    expect(assertAt).toBeGreaterThan(createAt);
    expect(linkAt).toBeGreaterThan(assertAt);
  });

  it("leaves the run unlinked on duplicate certification", () => {
    const dupAt = saveSql.indexOf("'result', 'duplicate_certification'");
    expect(saveSql.slice(dupAt, dupAt + 400)).toContain("'analysis_run_linked', false");
  });

  it("preserves the canonical create_slab signature and inventory allocation", () => {
    expect(saveSql).toContain("public.create_slab(p, p_front_ext, p_back_ext)");
    // No inventory number is ever computed, passed or reassigned here.
    expect(saveSql).not.toMatch(/slab_inventory_seq|reassign_slab_inventory_id/);
  });

  it("writes an audit row without provider payloads", () => {
    expect(saveSql).toContain("insert into public.audit_log (");
    expect(saveSql).toContain("'slab.save_confirmed_from_analysis'");
    expect(saveSql).toContain("'rpc:save_confirmed_slab_from_analysis'");
    expect(saveSql).not.toContain("image_base64");
    expect(saveSql).not.toMatch(/'payload',\s*p\b/);
    expect(saveSql).not.toMatch(/detail.*\bp\b\s*\)/);
    for (const leak of ["data:image", "front_image_bytes", "token", "secret", "api_key"]) {
      expect(saveSql.toLowerCase()).not.toContain(leak);
    }
  });

  it("uses safe, distinguishable error codes", () => {
    for (const code of ["42501", "P0002", "55000", "22023"]) {
      expect(saveSql).toContain(`errcode = '${code}'`);
    }
  });

  it("revokes public/anon execution and grants only authenticated", () => {
    expect(saveSql).toContain(
      "revoke all on function public.save_confirmed_slab_from_analysis(uuid, jsonb, text, text)\n  from public, anon;",
    );
    expect(saveSql).toContain(
      "grant execute on function public.save_confirmed_slab_from_analysis(uuid, jsonb, text, text)\n  to authenticated;",
    );
  });

  it("changes no table, policy, trigger or grant beyond the new function", () => {
    expect(saveSql).not.toMatch(/create table|alter table|create policy|create trigger/i);
    // The only privilege statements name the new function itself.
    const privileges = saveSql.match(/^(revoke|grant)\b.*$/gim) ?? [];
    expect(privileges.length).toBeGreaterThan(0);
    for (const statement of privileges) {
      expect(statement).toContain("function public.save_confirmed_slab_from_analysis");
    }
  });

  it("asserts field-evidence ownership for EVERY caller before creating anything", () => {
    // Canonical link_ai_analysis_run applies this check only to non-admins.
    expect(saveSql).toContain("from public.ai_field_evidence e");
    expect(saveSql).toContain("where e.analysis_run_id = p_analysis_run_id");
    expect(saveSql).toContain("and e.owner_id is distinct from v_target_owner");
    expect(saveSql).toContain("'analysis evidence ownership mismatch'");
    // Unconditional: not nested behind an admin test.
    expect(saveSql).not.toMatch(/if not v_is_admin[\s\S]{0,200}ai_field_evidence/);
    const evidenceAt = saveSql.indexOf("from public.ai_field_evidence e");
    const createAt = saveSql.lastIndexOf("v_slab := public.create_slab(");
    expect(evidenceAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(evidenceAt);
  });

  it("documents rollback truthfully: one DROP FUNCTION, no data migration", () => {
    expect(saveSql).toContain("Rollback is a");
    expect(saveSql).toContain("single DROP FUNCTION; no data migration is involved.");
    // The old header claimed no grant statements at all, which was inaccurate.
    expect(saveSql).not.toContain("no table, policy, grant, trigger or existing function");
  });
});

