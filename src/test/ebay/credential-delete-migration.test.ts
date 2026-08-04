import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260916000000_ebay_credential_delete.sql"),
  "utf8",
).toLowerCase();

describe("20260916 eBay credential delete migration", () => {
  it("defines one pinned service-role-only SECURITY DEFINER RPC", () => {
    expect(SQL).toContain("create or replace function public.ebay_credential_delete(p_account_id uuid)");
    expect(SQL).toContain("security definer");
    expect(SQL).toContain("set search_path = public, private, pg_temp");
    expect(SQL).toContain(
      "revoke all on function public.ebay_credential_delete(uuid) from public, anon, authenticated",
    );
    expect(SQL).toContain(
      "grant execute on function public.ebay_credential_delete(uuid) to service_role",
    );
    expect(SQL).not.toMatch(/grant execute on function public\.ebay_credential_delete\([^;]*\) to (anon|authenticated)/);
  });

  it("deletes only the canonical private credential and never touches legacy public OAuth tables", () => {
    expect(SQL).toMatch(/delete from private\.ebay_oauth_credentials\s+where ebay_account_id = p_account_id/);
    expect(SQL).not.toContain("delete from public.ebay_oauth_tokens");
    expect(SQL).not.toContain("delete from public.ebay_oauth_states");
    expect(SQL).not.toContain("drop table");
  });

  it("marks the public account disconnected without deleting account or seller history", () => {
    expect(SQL).toMatch(/update public\.ebay_accounts[\s\S]*connection_status = 'disconnected'/);
    expect(SQL).toMatch(/authorization_expires_at = null/);
    expect(SQL).not.toContain("delete from public.ebay_accounts");
    expect(SQL).not.toContain("delete from public.ebay_listing_mappings");
  });

  it("records the safe audit row in the same transaction", () => {
    expect(SQL).toContain("begin;");
    expect(SQL).toContain("insert into public.ebay_api_runs");
    expect(SQL).toContain("'disconnect'");
    expect(SQL).toContain("'success'");
    expect(SQL).toContain("commit;");
  });

  it("is idempotent for an unknown account and validates null input", () => {
    expect(SQL).toContain("if p_account_id is null then");
    expect(SQL).toContain("if not v_account_exists then");
    expect(SQL).toContain("return 0;");
  });
});
