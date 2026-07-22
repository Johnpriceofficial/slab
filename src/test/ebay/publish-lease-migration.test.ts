import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260820000000_ebay_publish_lease_private.sql"), "utf8");

describe("20260820 eBay publish-lease → PRIVATE schema (security fix)", () => {
  it("removes the public lease table and recreates it in the deny-all private schema", () => {
    expect(SQL).toMatch(/drop table if exists public\.ebay_publish_leases/);
    expect(SQL).toMatch(/create table if not exists private\.ebay_publish_leases/);
    expect(SQL).toMatch(/revoke all on table private\.ebay_publish_leases from public, anon, authenticated/);
    // No authenticated-admin RLS policy on a private synchronization table.
    expect(SQL).not.toMatch(/create policy .* on (public|private)\.ebay_publish_leases/);
    expect(SQL).not.toMatch(/grant (select|insert|update|delete|all)[^;]*ebay_publish_leases to authenticated/);
  });

  it("all three lease RPCs are SECURITY DEFINER, service_role-only, private in search_path", () => {
    for (const fn of ["ebay_publish_lease_acquire", "ebay_publish_lease_assert_and_extend", "ebay_publish_lease_release"]) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    expect((SQL.match(/security definer/g) ?? []).length).toBe(3);
    expect((SQL.match(/set search_path = public, private, pg_temp/g) ?? []).length).toBe(3);
    expect(SQL).toMatch(/from private\.ebay_publish_leases/);
  });

  it("acquire is atomic under an advisory lock; assert_and_extend fences on token ownership; release reports deletion", () => {
    expect(SQL).toMatch(/pg_advisory_xact_lock\(hashtextextended/);
    // fencing: extend only the caller's still-active lease, return held.
    const ext = SQL.slice(SQL.indexOf("ebay_publish_lease_assert_and_extend"));
    expect(ext).toMatch(/update private\.ebay_publish_leases[\s\S]*lease_token = p_token and expires_at > v_now/);
    expect(ext).toMatch(/'held', v_updated = 1/);
    // release reports whether the token row was deleted.
    const rel = SQL.slice(SQL.indexOf("create or replace function public.ebay_publish_lease_release"));
    expect(rel).toMatch(/lease_token = p_token/);
    expect(rel).toMatch(/'released', v_deleted = 1/);
  });
});
