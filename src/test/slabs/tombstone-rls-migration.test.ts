import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260904000000_slab_deletion_tombstones_rls.sql"),
  "utf8",
);

// Executable content only — the prose header discusses what is NOT done.
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("20260904 slab_deletion_tombstones RLS migration", () => {
  it("verifies the tombstones table exists and fails loudly when absent", () => {
    expect(CODE).toContain("to_regclass('private.slab_deletion_tombstones') is null");
    expect(CODE).toMatch(/raise exception/);
  });

  it("explicitly revokes ALL table privileges from PUBLIC and every client role", () => {
    expect(CODE).toContain(
      "revoke all privileges on table private.slab_deletion_tombstones from public, anon, authenticated, service_role;",
    );
  });

  it("enables row level security WITHOUT force (owner-exempt DEFINER paths must keep working)", () => {
    expect(CODE).toContain("alter table private.slab_deletion_tombstones enable row level security;");
    expect(CODE).not.toMatch(/force row level security/i);
  });

  it("creates no client-facing policy — deny-all by construction", () => {
    expect(CODE).not.toMatch(/\bcreate policy\b/i);
  });

  it("touches nothing else: no grants, ownership, columns, functions, triggers, or data", () => {
    expect(CODE).not.toMatch(/\bgrant\b/i);
    expect(CODE).not.toMatch(/\bowner to\b/i);
    expect(CODE).not.toMatch(/\balter table [^;]*\b(add|drop|alter) column\b/i);
    expect(CODE).not.toMatch(/\b(create|drop|alter) (function|trigger|index|view|sequence)\b/i);
    expect(CODE).not.toMatch(/\bsearch_path\b/i);
    expect(CODE).not.toMatch(/\b(insert|update|delete|truncate) (into|from|on)?\s*(public|private)\./i);
    // The only object named anywhere is the tombstones table itself.
    const objects = [...CODE.matchAll(/(public|private)\.[a-z_]+/g)].map((m) => m[0]);
    expect(new Set(objects)).toEqual(new Set(["private.slab_deletion_tombstones"]));
  });
});
