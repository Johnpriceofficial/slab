// Phase-1 connectors: READ-ONLY only. Each is a factory that takes an injected
// read function (so the spine holds no provider SDK or credential and stays unit-
// testable). Write/preview/production/destructive tools are intentionally NOT defined
// yet — they arrive once their scoped provider credentials (a private GitHub App, a
// scoped Vercel token, a Supabase management key) are provisioned, and always behind
// the policy engine. This file proves the ToolDefinition contract end to end.

import { defineTool } from "../registry.ts";
import type { ToolDefinition } from "../types.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export interface PullRequestSummary { number: number; title: string; state: string; headSha: string }
export interface MigrationSummary { version: string; name: string; appliedAt: string | null }
export interface DeploymentSummary { id: string; state: string; url: string; sha: string }

/** github.list_pull_requests — read a repo's open PRs. `read` risk → auto. */
export function githubListPullRequests(read: (repo: string) => Promise<PullRequestSummary[]>): ToolDefinition<{ repo: string }, PullRequestSummary[]> {
  return defineTool({
    name: "github.list_pull_requests",
    provider: "github",
    risk: "read",
    description: "List open pull requests for a repository.",
    parseInput: (raw) => (isObj(raw) && nonEmpty(raw.repo) ? { ok: true, value: { repo: raw.repo } } : { ok: false, error: "expected { repo: string }" }),
    execute: ({ repo }) => read(repo),
  });
}

/** supabase.list_migrations — read applied migration history. `read` risk → auto. */
export function supabaseListMigrations(read: (projectRef: string) => Promise<MigrationSummary[]>): ToolDefinition<{ projectRef: string }, MigrationSummary[]> {
  return defineTool({
    name: "supabase.list_migrations",
    provider: "supabase",
    risk: "read",
    description: "List applied database migrations for a project.",
    parseInput: (raw) => (isObj(raw) && nonEmpty(raw.projectRef) ? { ok: true, value: { projectRef: raw.projectRef } } : { ok: false, error: "expected { projectRef: string }" }),
    execute: ({ projectRef }) => read(projectRef),
  });
}

/** vercel.list_deployments — read recent deployments (preview + production, read-only). */
export function vercelListDeployments(read: (projectId: string) => Promise<DeploymentSummary[]>): ToolDefinition<{ projectId: string }, DeploymentSummary[]> {
  return defineTool({
    name: "vercel.list_deployments",
    provider: "vercel",
    risk: "read",
    description: "List recent deployments for a Vercel project.",
    parseInput: (raw) => (isObj(raw) && nonEmpty(raw.projectId) ? { ok: true, value: { projectId: raw.projectId } } : { ok: false, error: "expected { projectId: string }" }),
    execute: ({ projectId }) => read(projectId),
  });
}
