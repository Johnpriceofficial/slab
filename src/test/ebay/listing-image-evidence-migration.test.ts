import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EVID = readFileSync(join(process.cwd(), "supabase/migrations/20260824000000_ebay_listing_image_evidence.sql"), "utf8");
const RPC = readFileSync(join(process.cwd(), "supabase/migrations/20260825000000_ebay_listing_reconcile_local_rpc.sql"), "utf8");

describe("20260824 honest image-evidence columns", () => {
  it("adds images_submitted_at, image_verification_method, provider_image_evidence additively", () => {
    expect(EVID).toMatch(/add column if not exists images_submitted_at timestamptz/);
    expect(EVID).toMatch(/add column if not exists image_verification_method text/);
    expect(EVID).toMatch(/add column if not exists provider_image_evidence jsonb/);
    expect(EVID).not.toMatch(/not null/i);
  });
  it("deprecates provider_verified_at (no drop, comment says deprecated)", () => {
    expect(EVID).not.toMatch(/drop column/i);
    expect(EVID).toMatch(/comment on column public\.ebay_listing_intents\.provider_verified_at is\s*\n?\s*'DEPRECATED/i);
  });
});

describe("20260825 transactional reconcile RPC", () => {
  it("is SECURITY DEFINER with a fixed search_path", () => {
    expect(RPC).toMatch(/create or replace function public\.ebay_listing_reconcile_local/);
    expect(RPC).toMatch(/security definer/);
    expect(RPC).toMatch(/set search_path = public, pg_temp/);
  });
  it("revokes from public/anon/authenticated and grants only service_role", () => {
    expect(RPC).toMatch(/revoke all on function public\.ebay_listing_reconcile_local\([^)]*\) from public, anon, authenticated/);
    expect(RPC).toMatch(/grant execute on function public\.ebay_listing_reconcile_local\([^)]*\) to service_role/);
    expect(RPC).not.toMatch(/to authenticated;/);
  });
  it("locks the intent, proves identity + fingerprint, and RAISES on a bad row count (atomic)", () => {
    expect(RPC).toMatch(/for update/);
    expect(RPC).toMatch(/intent_identity_mismatch/);
    expect(RPC).toMatch(/fingerprint_mismatch/);
    expect(RPC).toMatch(/raise exception 'ebay_listing_reconcile_local: intent update affected/);
    expect(RPC).toMatch(/raise exception 'ebay_listing_reconcile_local: mapping upsert affected/);
  });
});
