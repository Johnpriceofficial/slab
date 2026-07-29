import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260908000000_slab_permission_model.sql",
  "utf8",
);

describe("slab permission-model migration", () => {
  it("removes direct authenticated writes from slabs", () => {
    expect(sql).toMatch(/revoke insert, update, delete, truncate, references, trigger on public\.slabs from authenticated/i);
  });

  it("preserves owner and administrator read policies", () => {
    expect(sql).toMatch(/create policy "slabs_owner_select"/i);
    expect(sql).toMatch(/\(select auth\.uid\(\)\)\s*=\s*owner_id/i);
    expect(sql).toMatch(/create policy "slabs_admin_select"/i);
    expect(sql).toMatch(/public\.is_admin\(\(select auth\.uid\(\)\)\)/i);
  });

  it("adds defense-in-depth update and delete guards", () => {
    expect(sql).toContain("guard_slab_protected_columns");
    expect(sql).toContain("forbid_direct_slab_delete");
    expect(sql).toMatch(/request\.jwt\.claim\.role/i);
  });

  it("creates an owner-scoped correction audit table", () => {
    expect(sql).toMatch(/create table if not exists public\.slab_correction_events/i);
    expect(sql).toMatch(/create unique index if not exists slab_correction_events_idem_uidx/i);
    expect(sql).toMatch(/using \(owner_id = \(select auth\.uid\(\)\)\)/i);
  });

  it("exposes only the narrow correction RPC", () => {
    expect(sql).toMatch(/create or replace function public\.correct_slab_identification/i);
    expect(sql).toMatch(/grant execute on function public\.correct_slab_identification\(uuid, jsonb, text\)\s+to authenticated, service_role/i);
    expect(sql).toMatch(/revoke all on function public\.correct_slab_identification\(uuid, jsonb, text\)\s+from public, anon/i);
  });

  it("derives identity from auth.uid and scopes slab access to the owner", () => {
    expect(sql).toMatch(/v_user uuid := \(select auth\.uid\(\)\)/i);
    expect(sql).toMatch(/where id = p_slab_id\s+and owner_id = v_user\s+for update/i);
  });

  it("uses the real customer profile and administrator APIs", () => {
    expect(sql).toContain("public.customer_profiles");
    expect(sql).toContain("public.is_admin(v_user)");
    expect(sql).not.toMatch(/public\.profiles|public\.has_role/i);
  });

  it("uses only columns present in the current slabs schema", () => {
    for (const staleColumn of [
      "estimated_value_cents",
      "valuation_source",
      "price_source_id",
      "certification_verified",
      "analysis_run_id",
      "reviewed_by",
      "reviewed_at",
    ]) {
      expect(sql).not.toContain(staleColumn);
    }
  });

  it("whitelists identification fields and rejects all others", () => {
    expect(sql).toContain("'card_name'");
    expect(sql).toContain("'certification_number'");
    expect(sql).toContain("field_not_correctable");
  });

  it("serializes idempotent correction replays", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext/i);
    expect(sql).toContain("idempotency_conflict");
    expect(sql).toContain("'replayed', true");
  });

  it("records both correction events and the canonical audit log", () => {
    expect(sql).toMatch(/insert into public\.slab_correction_events/i);
    expect(sql).toMatch(/insert into public\.audit_log/i);
    expect(sql).toContain("slab.identification_corrected");
  });
});
