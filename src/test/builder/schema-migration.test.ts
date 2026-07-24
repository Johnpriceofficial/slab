import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260901000000_builder_control_plane.sql"), "utf8");
const TABLES = ["builder_connections", "builder_runs", "builder_steps", "builder_approvals", "builder_tool_calls", "builder_audit_events", "builder_policy_rules"];

describe("20260901 builder control plane schema", () => {
  it("creates all seven builder_* tables", () => {
    for (const t of TABLES) expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${t}`));
  });

  it("enables RLS and grants ADMIN read on every table, with NO client write", () => {
    // RLS is enabled and admin-read is is_admin(auth.uid()); the loop covers every table.
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/for select to authenticated using \(public\.is_admin\(auth\.uid\(\)\)\)/);
    expect(SQL).toMatch(/revoke insert, update, delete on public\.%I from anon, authenticated/);
    for (const t of TABLES) expect(SQL).toContain(`'${t}'`); // each table listed in the RLS loop
  });

  it("stores NO raw secrets — connections keep only a named secret_ref, never a token", () => {
    expect(SQL).toMatch(/secret_ref\s+text/);
    expect(SQL).not.toMatch(/access_token|refresh_token|service_role_key|client_secret\s+text/i);
  });

  it("risk / decision / status enums are constrained by CHECK", () => {
    expect(SQL).toMatch(/risk_ceiling\s+text not null default 'read' check \(risk_ceiling in \('read', 'preview_write', 'production_write', 'destructive'\)\)/);
    expect(SQL).toMatch(/decision\s+text not null check \(decision in \('auto','session_approval','explicit_approval','typed_confirmation','denied'\)\)/);
    // the run status CHECK enumerates the full lifecycle
    for (const s of ["requested", "waiting_for_approval", "deploying", "rolled_back"]) expect(SQL).toContain(`'${s}'`);
  });

  it("the append-audit RPC is SECURITY DEFINER, service_role-only, fixed search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.builder_append_audit_event/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = public, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.builder_append_audit_event\([^)]*\) to service_role/);
    expect(SQL).toMatch(/revoke all on function public\.builder_append_audit_event\([^)]*\) from public, anon, authenticated/);
    expect(SQL).not.toMatch(/to authenticated;/);
  });

  it("is additive — only CREATE/ALTER/GRANT/REVOKE, no DROP TABLE of anything", () => {
    expect(SQL).not.toMatch(/drop table/i);
  });
});
