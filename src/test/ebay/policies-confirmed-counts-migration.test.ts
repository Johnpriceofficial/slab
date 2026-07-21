import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260816000000_ebay_policies_confirmed_counts.sql"),
  "utf8",
);

describe("20260816 eBay policies confirmed-counts migration", () => {
  it("drops before recreate (the return type changes, so CREATE OR REPLACE alone is insufficient)", () => {
    expect(SQL).toMatch(/drop function if exists public\.ebay_business_policies_replace\(uuid, jsonb\)/);
    // The drop must appear before the create.
    expect(SQL.indexOf("drop function")).toBeLessThan(SQL.indexOf("create or replace function"));
  });

  it("returns jsonb and stays SECURITY DEFINER, service_role-only, with a pinned search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.ebay_business_policies_replace\(p_account_id uuid, p_policies jsonb\)\s*\n?\s*returns jsonb/);
    expect(SQL).toContain("security definer");
    expect(SQL).toMatch(/set search_path = public[^\n]*pg_temp/);
    expect(SQL).toMatch(/revoke all on function public\.ebay_business_policies_replace\(uuid, jsonb\) from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.ebay_business_policies_replace\(uuid, jsonb\) to service_role/);
    expect(SQL).not.toMatch(/grant execute on function public\.ebay_business_policies_replace[^;]*to (anon|authenticated)/);
  });

  it("still upserts and prunes stale rows (replace-with-prune semantics preserved)", () => {
    expect(SQL).toMatch(/insert into public\.ebay_business_policies/);
    expect(SQL).toMatch(/on conflict \(ebay_account_id, policy_id\) do update/);
    expect(SQL).toMatch(/delete from public\.ebay_business_policies\s+where ebay_account_id = p_account_id and policy_id <> all/);
  });

  it("returns CONFIRMED post-write counts read back from the table, per policy type", () => {
    // The count block must read from the table AFTER the write, not from the input jsonb.
    const countBlock = SQL.slice(SQL.indexOf("jsonb_build_object"));
    expect(countBlock).toMatch(/'total',\s*count\(\*\)/);
    expect(countBlock).toMatch(/'fulfillment',\s*count\(\*\) filter \(where policy_type = 'fulfillment'\)/);
    expect(countBlock).toMatch(/'payment',\s*count\(\*\) filter \(where policy_type = 'payment'\)/);
    expect(countBlock).toMatch(/'return',\s*count\(\*\) filter \(where policy_type = 'return'\)/);
    expect(countBlock).toMatch(/from public\.ebay_business_policies\s+where ebay_account_id = p_account_id/);
  });
});
