import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260822000000_ebay_listing_intent_durable_state.sql"), "utf8");

describe("20260822 durable intended-state columns on ebay_listing_intents", () => {
  it("adds intended_state, fingerprint_version, image_manifest, provider_verified_at additively", () => {
    expect(SQL).toMatch(/alter table public\.ebay_listing_intents/);
    expect(SQL).toMatch(/add column if not exists intended_state jsonb/);
    expect(SQL).toMatch(/add column if not exists fingerprint_version integer/);
    expect(SQL).toMatch(/add column if not exists image_manifest jsonb/);
    expect(SQL).toMatch(/add column if not exists provider_verified_at timestamptz/);
  });
  it("is purely additive — no NOT NULL and no default backfill", () => {
    expect(SQL).not.toMatch(/not null/i);
    expect(SQL).not.toMatch(/\bdefault\b/i);
  });
  it("documents that the snapshot excludes secrets, signed URLs, and PII", () => {
    expect(SQL).toMatch(/comment on column public\.ebay_listing_intents\.intended_state/);
    expect(SQL).toMatch(/No secrets, signed URLs/i);
  });
});
