import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE = readFileSync(join(process.cwd(), "supabase/migrations/20260827000000_ebay_sync_state.sql"), "utf8");
const LEASE = readFileSync(join(process.cwd(), "supabase/migrations/20260828000000_ebay_sync_lease.sql"), "utf8");
const FENCE = readFileSync(join(process.cwd(), "supabase/migrations/20260829000000_ebay_sync_lease_fencing.sql"), "utf8");
const ATOMIC = readFileSync(join(process.cwd(), "supabase/migrations/20260830000000_ebay_sync_atomic_complete.sql"), "utf8");
const TOTALS = readFileSync(join(process.cwd(), "supabase/migrations/20260831000000_ebay_orders_persist_confirmed_totals.sql"), "utf8");
const BEGINFENCE = readFileSync(join(process.cwd(), "supabase/migrations/20260832000000_ebay_sync_begin_lease_fenced.sql"), "utf8");

describe("20260827 durable sync state", () => {
  it("creates a per-account/resource state table with a watermark + status, RLS enabled", () => {
    expect(STATE).toMatch(/create table if not exists public\.ebay_sync_state/);
    expect(STATE).toMatch(/resource_type text not null check \(resource_type in \('orders', 'finances'\)\)/);
    expect(STATE).toMatch(/status text not null default 'idle' check \(status in \('idle', 'running', 'failed', 'complete'\)\)/);
    expect(STATE).toMatch(/high_watermark_at timestamptz/);
    expect(STATE).toMatch(/unique \(ebay_account_id, resource_type\)/);
    expect(STATE).toMatch(/alter table public\.ebay_sync_state enable row level security/);
  });
  it("load/commit/fail RPCs are SECURITY DEFINER, service_role-only, fixed search_path", () => {
    for (const fn of ["ebay_sync_state_load", "ebay_sync_state_commit", "ebay_sync_state_fail"]) {
      expect(STATE).toMatch(new RegExp(`create or replace function public\\.${fn}`));
      expect(STATE).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
      expect(STATE).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
    }
    expect(STATE).toMatch(/set search_path = public, pg_temp/);
    expect(STATE).not.toMatch(/to anon/);
  });
});

describe("20260828 single-flight sync lease", () => {
  it("private table (deny-all + RLS), advisory-locked acquire, checked release, service_role-only", () => {
    expect(LEASE).toMatch(/create table if not exists private\.ebay_sync_leases/);
    expect(LEASE).toMatch(/revoke all on table private\.ebay_sync_leases from public, anon, authenticated/);
    expect(LEASE).toMatch(/alter table private\.ebay_sync_leases enable row level security/);
    expect(LEASE).toMatch(/pg_advisory_xact_lock/);
    expect(LEASE).toMatch(/grant execute on function public\.ebay_sync_lease_acquire\([^)]*\) to service_role/);
    expect(LEASE).toMatch(/grant execute on function public\.ebay_sync_lease_release\([^)]*\) to service_role/);
    expect(LEASE).not.toMatch(/to authenticated;/);
  });
});

describe("C.8.1 hardening migrations", () => {
  it("20260829 adds lease assert-and-extend (fencing), service_role-only", () => {
    expect(FENCE).toMatch(/create or replace function public\.ebay_sync_lease_assert_and_extend/);
    expect(FENCE).toMatch(/pg_advisory_xact_lock/);
    expect(FENCE).toMatch(/expires_at > v_now/);
    expect(FENCE).toMatch(/grant execute on function public\.ebay_sync_lease_assert_and_extend\([^)]*\) to service_role/);
    expect(FENCE).not.toMatch(/to authenticated;/);
  });
  it("20260830 stamps run_id on load, adds ATOMIC lease-fenced ebay_sync_complete, fail-by-run_id, drops the old commit", () => {
    expect(ATOMIC).toMatch(/drop function if exists public\.ebay_sync_state_commit/);
    expect(ATOMIC).toMatch(/run_id = gen_random_uuid\(\)/);
    expect(ATOMIC).toMatch(/create or replace function public\.ebay_sync_complete/);
    expect(ATOMIC).toMatch(/error_code', 'lease_lost'/);      // lease fence at completion
    expect(ATOMIC).toMatch(/error_code', 'stale_runner'/);    // run-id fence
    expect(ATOMIC).toMatch(/insert into public\.ebay_api_runs/); // success audit in the same txn
    expect(ATOMIC).toMatch(/status = 'running' and run_id is not distinct from p_run_id/); // fail: active runner only
    for (const fn of ["ebay_sync_complete", "ebay_sync_state_fail", "ebay_sync_state_load"]) {
      expect(ATOMIC).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    expect(ATOMIC).not.toMatch(/to authenticated;/);
  });
  it("20260831 makes ebay_orders_persist return CONFIRMED durable totals from the private tables", () => {
    expect(TOTALS).toMatch(/create or replace function public\.ebay_orders_persist/);
    expect(TOTALS).toMatch(/confirmed_order_total/);
    expect(TOTALS).toMatch(/confirmed_line_total/);
    expect(TOTALS).toMatch(/count\(\*\) into v_confirmed_orders from private\.ebay_orders where ebay_account_id = p_account_id/);
    expect(TOTALS).toMatch(/grant execute on function public\.ebay_orders_persist\([^)]*\) to service_role/);
  });
  it("20260832 FENCES begin-run: drops the 2-arg load, creates a token-fenced 3-arg load under the advisory lock", () => {
    // The unfenced 2-arg load is removed so a stale/expired runner cannot begin a run.
    expect(BEGINFENCE).toMatch(/drop function if exists public\.ebay_sync_state_load\(uuid, text\)/);
    expect(BEGINFENCE).toMatch(/create or replace function public\.ebay_sync_state_load\(p_account_id uuid, p_resource_type text, p_lease_token text\)/);
    // Same advisory lock as the lease; the exact token must exist AND be unexpired BEFORE any state change.
    expect(BEGINFENCE).toMatch(/pg_advisory_xact_lock/);
    expect(BEGINFENCE).toMatch(/from private\.ebay_sync_leases[\s\S]*lease_token = p_lease_token[\s\S]*expires_at > now\(\)/);
    expect(BEGINFENCE).toMatch(/'error_code', 'lease_lost'/);
    expect(BEGINFENCE).toMatch(/'error_code', 'sync_begin_failed'/);
    // run_id is only minted after the fence passes.
    expect(BEGINFENCE).toMatch(/run_id = gen_random_uuid\(\)/);
    expect(BEGINFENCE).toMatch(/set search_path = public, private, pg_temp/);
    expect(BEGINFENCE).toMatch(/grant execute on function public\.ebay_sync_state_load\(uuid, text, text\) to service_role/);
    expect(BEGINFENCE).toMatch(/revoke all on function public\.ebay_sync_state_load\(uuid, text, text\) from public, anon, authenticated/);
    expect(BEGINFENCE).not.toMatch(/to authenticated;/);
  });
});
