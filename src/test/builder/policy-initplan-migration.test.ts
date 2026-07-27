import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260902000000_builder_policy_initplan.sql"),
  "utf8",
);
const BASE = readFileSync(
  join(process.cwd(), "supabase/migrations/20260901000000_builder_control_plane.sql"),
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

// Executable content only — the prose header may legitimately quote the old form.
const stripComments = (sql: string): string =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
const CODE = stripComments(SQL);

describe("20260902 builder policy initplan migration", () => {
  it("targets exactly the seven builder tables 20260901 established, in the same order", () => {
    expect(tableArray(SQL)).toEqual(TABLES);
    expect(tableArray(BASE)).toEqual(TABLES);
  });

  it("recreates each policy under the same name, command, and role as 20260901", () => {
    // Same drop+create-by-format pattern, same `<table>_admin_read` naming.
    expect(SQL).toContain("execute format('drop policy if exists %I on public.%I;', t || '_admin_read', t);");
    expect(SQL).toMatch(/create policy %I on public\.%I for select to authenticated using/);
    expect(BASE).toMatch(/create policy %I on public\.%I for select to authenticated using/);
    // SELECT policies never carry WITH CHECK — neither file may introduce one.
    expect(SQL).not.toMatch(/with check/i);
  });

  it("changes ONLY the auth.uid() expression to the initplan subselect form", () => {
    expect(CODE).toContain("using (public.is_admin((select auth.uid())))");
    // The plain per-row form must be absent from 20260902's executable SQL.
    expect(CODE).not.toContain("is_admin(auth.uid())");
    // And 20260901 is the plain form this file supersedes (guards the diff's meaning).
    expect(BASE).toContain("using (public.is_admin(auth.uid()))");
  });

  it("verifies each target table exists before touching its policy", () => {
    expect(SQL).toMatch(/to_regclass\(format\('public\.%I', t\)\) is null/);
    expect(SQL).toMatch(/raise exception/);
  });

  it("touches nothing else: no grants, revokes, table/function DDL, RLS toggles, or data", () => {
    expect(CODE).not.toMatch(/\bgrant\b/i);
    expect(CODE).not.toMatch(/\brevoke\b/i);
    expect(CODE).not.toMatch(/\balter table\b/i);
    expect(CODE).not.toMatch(/\bcreate (or replace )?function\b/i);
    expect(CODE).not.toMatch(/\brow level security\b/i);
    expect(CODE).not.toMatch(/\b(insert|update|delete) (into|from|on)?\s*(public|private)\./i);
    // The only object names in play are the seven builder tables.
    const referenced = new Set(tableArray(SQL));
    expect([...referenced]).toEqual(TABLES);
  });

  it("is idempotent at the logical-object level and fully transactional", () => {
    // drop-if-exists + create inside a single DO block: re-running yields the
    // same end state, and the block executes atomically.
    expect(SQL).toMatch(/^do \$\$/m);
    expect(SQL).toMatch(/end \$\$;/);
    expect((SQL.match(/do \$\$/g) ?? []).length).toBe(1);
  });
});
