import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260903000000_builder_read_grants.sql"),
  "utf8",
);

const TABLES = [
  "builder_connections",
  "builder_runs",
  "builder_steps",
  "builder_approvals",
  "builder_tool_calls",
  "builder_audit_events",
  "builder_policy_rules",
];

const tableArray = (sql: string): string[] =>
  (sql.match(/foreach t in array array\[([\s\S]*?)\]/)?.[1] ?? "")
    .match(/'([a-z_]+)'/g)!
    .map((s) => s.replace(/'/g, ""));

// Executable content only — the prose header may describe revoked states.
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("20260903 builder read-grants migration", () => {
  it("targets exactly the seven builder tables", () => {
    expect(tableArray(SQL)).toEqual(TABLES);
  });

  it("revokes ALL client-role privileges BEFORE granting, so the end state is deterministic", () => {
    const revokeIdx = CODE.indexOf("revoke all privileges on public.%I from anon, authenticated;");
    const grantIdx = CODE.indexOf("grant select on public.%I to authenticated;");
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });

  it("grants SELECT only, to authenticated only — anon receives nothing", () => {
    // The single grant statement in the file is select-to-authenticated.
    const grants = CODE.match(/grant [^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("grant select on public.%I to authenticated;");
    expect(CODE).not.toMatch(/grant [^;]*\b(insert|update|delete|truncate|references|trigger|all)\b/i);
    expect(CODE).not.toMatch(/grant [^;]*to [^;]*anon/i);
    expect(CODE).not.toMatch(/grant [^;]*to [^;]*service_role/i);
  });

  it("verifies each target table exists and fails loudly if one is missing", () => {
    expect(CODE).toMatch(/to_regclass\(format\('public\.%I', t\)\) is null/);
    expect(CODE).toMatch(/raise exception/);
  });

  it("touches nothing else: no policies, RLS toggles, tables, functions, triggers, sequences, or data", () => {
    expect(CODE).not.toMatch(/\b(create|alter|drop) policy\b/i);
    expect(CODE).not.toMatch(/\brow level security\b/i);
    expect(CODE).not.toMatch(/\b(create|alter|drop) (table|function|trigger|sequence|index|view)\b/i);
    expect(CODE).not.toMatch(/\b(insert|update|delete) (into|from|on)?\s*(public|private)\./i);
    expect(CODE).not.toMatch(/supabase_migrations/i);
    const referenced = new Set(tableArray(SQL));
    expect([...referenced]).toEqual(TABLES);
  });

  it("is deterministic-idempotent and fully transactional (single DO block)", () => {
    expect(CODE).toMatch(/^do \$\$/m);
    expect(CODE).toMatch(/end \$\$;/);
    expect((CODE.match(/do \$\$/g) ?? []).length).toBe(1);
  });
});
