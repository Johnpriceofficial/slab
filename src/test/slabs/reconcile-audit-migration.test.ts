import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Schema-conformance regression coverage for the production reconciliation
// migration. The reconciled objects must match production 20260716083710 EXACTLY;
// these assertions fail on the two drifts caught in review (bare `public`
// search_path, and an unscoped whole-row trigger) and on the index handling.
// The Supabase Data API cannot reach pg_catalog from the integration tests, so
// conformance is asserted against the migration source here and behaviorally
// (against the full CI reset) in enum-normalization.integration.test.ts.
const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260812000000_reconcile_production_audit_repairs.sql"),
  "utf8",
);

describe("20260812 reconcile-production-audit-repairs matches production exactly", () => {
  it("pins search_path = public, pg_temp on all three reconciled functions (never bare public)", () => {
    expect((SQL.match(/set search_path = public, pg_temp\b/g) ?? []).length).toBe(3);
    // No reconciled function may be left on a bare `public` search path.
    expect(SQL).not.toMatch(/set search_path = public\s*$/m);
    for (const fn of ["normalize_slab_enum_inputs", "assign_raw_card_inventory", "parse_inventory_code"]) {
      expect(SQL).toContain(`public.${fn}`);
    }
  });

  it("scopes the normalization trigger to inventory_status + candidate_image_type only", () => {
    expect(SQL).toMatch(/before insert or update of inventory_status, candidate_image_type on public\.slabs/);
    // Must NOT be an unscoped whole-row trigger (fires on every slab update).
    expect(SQL).not.toMatch(/before insert or update on public\.slabs/);
  });

  it("drops the obsolete index and asserts production's index", () => {
    expect(SQL).toMatch(/drop index if exists public\.slab_comps_slab_idx\b/);
    expect(SQL).toMatch(/create index if not exists idx_slab_comps_slab_id on public\.slab_comps \(slab_id\)/);
  });
});
