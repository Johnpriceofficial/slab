import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20260821000000_slab_game_or_franchise.sql"), "utf8");

describe("20260821 slab game_or_franchise column", () => {
  it("adds a nullable game_or_franchise column additively (no default, no NOT NULL)", () => {
    expect(SQL).toMatch(/alter table public\.slabs\s+add column if not exists game_or_franchise text/);
    expect(SQL).not.toMatch(/game_or_franchise text not null/);
    expect(SQL).not.toMatch(/game_or_franchise text default/);
  });
  it("documents that it is set via edit/AI, never hard-coded", () => {
    expect(SQL).toMatch(/comment on column public\.slabs\.game_or_franchise/);
  });
});
