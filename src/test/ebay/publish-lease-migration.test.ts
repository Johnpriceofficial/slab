import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260819000000_ebay_publish_lease.sql"), "utf8");

describe("20260819 eBay publish-lease migration", () => {
  it("creates the lease table with one active lease per account+SKU + admin RLS", () => {
    expect(SQL).toMatch(/create table if not exists public\.ebay_publish_leases/);
    expect(SQL).toMatch(/unique \(ebay_account_id, sku\)/);
    expect(SQL).toMatch(/alter table public\.ebay_publish_leases enable row level security/);
    expect(SQL).toMatch(/is_admin\(auth\.uid\(\)\)/);
  });

  it("acquire is atomic under an advisory lock and only grants when no active lease exists", () => {
    const body = SQL.slice(SQL.indexOf("function public.ebay_publish_lease_acquire"), SQL.indexOf("function public.ebay_publish_lease_release"));
    expect(body).toMatch(/pg_advisory_xact_lock\(hashtextextended/);
    expect(body).toMatch(/if found and v_expires > v_now then\s+return jsonb_build_object\('acquired', false\)/);
    expect(body).toMatch(/'acquired', true/);
  });

  it("both lease RPCs are SECURITY DEFINER, service_role-only, pinned search_path", () => {
    for (const fn of ["ebay_publish_lease_acquire", "ebay_publish_lease_release"]) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    expect((SQL.match(/security definer/g) ?? []).length).toBe(2);
    expect((SQL.match(/set search_path = public, pg_temp/g) ?? []).length).toBe(2);
  });

  it("release only deletes the caller's own lease (token match)", () => {
    expect(SQL).toMatch(/delete from public\.ebay_publish_leases where ebay_account_id = p_account_id and sku = p_sku and lease_token = p_token/);
  });
});
