import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260823000000_private_schema_enable_rls.sql"), "utf8");

describe("20260823 enable RLS on the two remaining private tables (defense-in-depth)", () => {
  it("enables RLS on private.slab_storage_cleanup_queue and private.ebay_publish_leases", () => {
    expect(SQL).toMatch(/alter table private\.slab_storage_cleanup_queue enable row level security/);
    expect(SQL).toMatch(/alter table private\.ebay_publish_leases enable row level security/);
  });
  it("adds NO anon or authenticated policy (service role bypasses RLS)", () => {
    expect(SQL).not.toMatch(/create policy/i);
    expect(SQL).not.toMatch(/to anon/i);
    expect(SQL).not.toMatch(/to authenticated/i);
  });
});
