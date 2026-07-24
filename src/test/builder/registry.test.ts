import { describe, it, expect, vi } from "vitest";
import { authorizeToolCall, createRegistry } from "../../builder/registry";
import { githubListPullRequests, supabaseListMigrations } from "../../builder/connectors/readonly";
import type { PolicyContext, ToolDefinition } from "../../builder/types";

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ sessionMode: "read_only", environment: "development", ...over });

// A stand-in write tool (not shipped yet) to prove policy classification on non-read risk.
const applyMigration: ToolDefinition<{ sql: string }, void> = {
  name: "supabase.apply_migration",
  provider: "supabase",
  risk: "production_write",
  description: "Apply a forward migration to production.",
  parseInput: (raw) => (raw && typeof (raw as { sql?: unknown }).sql === "string" ? { ok: true, value: { sql: (raw as { sql: string }).sql } } : { ok: false, error: "expected { sql: string }" }),
  execute: async () => {},
};

function reg() {
  const prs = githubListPullRequests(async () => [{ number: 1, title: "x", state: "open", headSha: "abc" }]);
  const migs = supabaseListMigrations(async () => []);
  return createRegistry([prs, migs, applyMigration]);
}

describe("createRegistry", () => {
  it("indexes tools by name and rejects duplicates", () => {
    const r = reg();
    expect(r.has("github.list_pull_requests")).toBe(true);
    expect(r.get("supabase.apply_migration")?.risk).toBe("production_write");
    expect(r.list().length).toBe(3);
    const dup = githubListPullRequests(async () => []);
    expect(() => createRegistry([dup, dup])).toThrow(/duplicate tool/);
  });
});

describe("authorizeToolCall — resolve + validate + classify, never execute", () => {
  it("unknown tool → error, no execution", () => {
    const a = authorizeToolCall(reg(), ctx(), "nope.tool", {});
    expect(a).toMatchObject({ ok: false, reason: "unknown_tool" });
  });

  it("invalid input is rejected against the tool's own schema", () => {
    const a = authorizeToolCall(reg(), ctx(), "github.list_pull_requests", { repo: "" });
    expect(a).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("a read tool authorizes to `auto` and returns the parsed input, but does NOT run execute", async () => {
    const readSpy = vi.fn(async () => [{ number: 2, title: "t", state: "open", headSha: "s" }]);
    const r = createRegistry([githubListPullRequests(readSpy)]);
    const a = authorizeToolCall(r, ctx(), "github.list_pull_requests", { repo: "org/app" });
    expect(a).toMatchObject({ ok: true, decision: "auto", input: { repo: "org/app" } });
    expect(readSpy).toHaveBeenCalledTimes(0); // authorization never executes the side effect
  });

  it("a production_write tool authorizes to explicit_approval even in an allow-all session", () => {
    const a = authorizeToolCall(reg(), ctx({ sessionMode: "allow_all_nondestructive", environment: "production" }), "supabase.apply_migration", { sql: "select 1" });
    expect(a).toMatchObject({ ok: true, decision: "explicit_approval" });
  });
});
