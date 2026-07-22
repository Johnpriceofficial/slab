import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE = readFileSync(join(process.cwd(), "supabase/migrations/20260827000000_ebay_sync_state.sql"), "utf8");
const LEASE = readFileSync(join(process.cwd(), "supabase/migrations/20260828000000_ebay_sync_lease.sql"), "utf8");

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
