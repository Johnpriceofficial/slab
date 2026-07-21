import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260814000000_ebay_account_discovery.sql"), "utf8");

const RPCS = [
  "ebay_credential_scopes_set",
  "ebay_credential_scopes_get",
  "ebay_inventory_locations_replace",
  "ebay_business_policies_replace",
  "ebay_api_run_record",
  "ebay_sync_cursor_touch",
  "ebay_oauth_state_create_single_flight",
];

describe("20260814 eBay account-discovery migration", () => {
  it("defines each RPC as SECURITY DEFINER, service_role-only, with pinned search_path", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBe(RPCS.length);
    for (const fn of RPCS) {
      expect(SQL).toContain(`create or replace function public.${fn}(`);
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    expect(SQL).not.toMatch(/grant execute on function public\.ebay_[^;]*to (anon|authenticated)/);
    expect((SQL.match(/set search_path = public[^\n]*pg_temp/g) ?? []).length).toBe(RPCS.length);
  });

  it("adds scope-provenance columns and a connected_at timestamp", () => {
    expect(SQL).toMatch(/add column if not exists requested_scopes\s+text\[\]/);
    expect(SQL).toMatch(/add column if not exists token_reported_scopes text\[\]/);
    expect(SQL).toMatch(/add column if not exists scope_source\s+text/);
    expect(SQL).toMatch(/add column if not exists connected_at timestamptz/);
  });

  it("backfills existing credentials with the six canonical scopes as requested_fallback", () => {
    expect(SQL).toMatch(/update private\.ebay_oauth_credentials/);
    expect(SQL).toContain("commerce.identity.readonly");
    expect(SQL).toContain("requested_fallback");
    expect(SQL).toMatch(/where requested_scopes = '\{\}'/);
  });

  it("prunes stale rows only in the replace RPCs (upsert + delete-not-in-set) and adds covering indexes", () => {
    expect(SQL).toMatch(/delete from public\.ebay_inventory_locations\s+where ebay_account_id = p_account_id and merchant_location_key <> all/);
    expect(SQL).toMatch(/delete from public\.ebay_business_policies\s+where ebay_account_id = p_account_id and policy_id <> all/);
    expect(SQL).toMatch(/create index if not exists idx_ebay_api_runs_account_created/);
    expect(SQL).toMatch(/create index if not exists idx_ebay_notifications_account_received/);
  });

  it("single-flight acquires an advisory lock and expires prior unconsumed states", () => {
    expect(SQL).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_requested_by::text/);
    expect(SQL).toMatch(/update private\.ebay_oauth_states set expires_at = now\(\)\s+where requested_by = p_requested_by and consumed_at is null/);
  });
});
