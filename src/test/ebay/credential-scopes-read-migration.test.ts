import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260815000000_ebay_credential_scopes_read.sql"), "utf8");

describe("20260815 credential scope read + connected_at backfill", () => {
  it("recreates credential_get to return the full scope provenance (service_role only)", () => {
    expect(SQL).toMatch(/drop function if exists public\.ebay_oauth_credential_get\(uuid\)/);
    expect(SQL).toMatch(/create or replace function public\.ebay_oauth_credential_get\(p_account_id uuid\)/);
    for (const col of ["refresh_token_encrypted", "requested_scopes", "token_reported_scopes", "scope_source"]) {
      expect(SQL).toContain(col);
    }
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = public, private, pg_temp/);
    expect(SQL).toMatch(/revoke all on function public\.ebay_oauth_credential_get\(uuid\) from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.ebay_oauth_credential_get\(uuid\) to service_role/);
    expect(SQL).not.toMatch(/to (anon|authenticated)/);
  });

  it("backfills connected_at from created_at for connected accounts (metadata only)", () => {
    expect(SQL).toMatch(/update public\.ebay_accounts\s+set connected_at = coalesce\(connected_at, created_at\)/);
    expect(SQL).toMatch(/where connection_status = 'connected' and connected_at is null/);
    // Never touches credentials/tokens in the backfill.
    expect(SQL).not.toMatch(/update private\.ebay_oauth_credentials/);
  });
});
