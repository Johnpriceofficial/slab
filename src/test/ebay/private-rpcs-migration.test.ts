import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static security-posture coverage for the eBay private-access RPCs. The
// behavioral round-trip + deny checks run in the integration suite; this asserts
// the migration itself keeps the functions SECURITY DEFINER, search-path pinned,
// and executable by service_role ONLY.
const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260813000000_ebay_private_access_rpcs.sql"),
  "utf8",
);

const FUNCTIONS = [
  "ebay_oauth_state_create",
  "ebay_oauth_state_get",
  "ebay_oauth_state_consume",
  "ebay_oauth_credential_upsert",
  "ebay_oauth_credential_get",
  "ebay_oauth_credential_rotate",
];

describe("20260813 eBay private-access RPCs — security posture", () => {
  it("defines all six wrapper functions", () => {
    for (const fn of FUNCTIONS) {
      expect(SQL).toContain(`create or replace function public.${fn}(`);
    }
  });

  it("makes every function SECURITY DEFINER with a pinned search_path", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBe(6);
    expect((SQL.match(/set search_path = public, private, pg_temp\b/g) ?? []).length).toBe(6);
    // No function may be left on a bare `public` (or unpinned) search path.
    expect(SQL).not.toMatch(/set search_path = public\s*$/m);
  });

  it("revokes execute from public/anon/authenticated and grants ONLY service_role", () => {
    for (const fn of FUNCTIONS) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    // No client role may be granted execute on these server-only wrappers.
    expect(SQL).not.toMatch(/grant execute on function public\.ebay_oauth_[^;]*to (anon|authenticated)/);
  });

  it("reaches the private tables (never the Data API) and stays parameterized", () => {
    expect(SQL).toMatch(/private\.ebay_oauth_states/);
    expect(SQL).toMatch(/private\.ebay_oauth_credentials/);
    // Optimistic-concurrency guard on rotation: conditioned on the prior ciphertext.
    expect(SQL).toMatch(/refresh_token_encrypted = p_prior_encrypted/);
  });
});
