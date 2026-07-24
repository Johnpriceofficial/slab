import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, GitBranch, CircleAlert } from "lucide-react";
import { PageHead } from "@/components/seo/PageHead";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/shared/LoadingState";
import { fetchBuilderRuns } from "@/lib/builder/data";

// The four-level permission model, shown to the operator so the gating is legible.
const PERMISSION_LEVELS = [
  { level: "Read", example: "Inspect repo, logs, migrations, deployments", exec: "Automatic" },
  { level: "Preview write", example: "Create branch, edit files, deploy preview", exec: "Session grant" },
  { level: "Production write", example: "Merge, deploy, apply migration", exec: "Explicit approval" },
  { level: "Destructive / external", example: "Delete data, publish listing, refund", exec: "Typed confirmation" },
] as const;

const STATUS_TONE: Record<string, string> = {
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  rolled_back: "bg-amber-100 text-amber-800",
  waiting_for_approval: "bg-blue-100 text-blue-800",
};

export default function Builder() {
  const { data: runs, isLoading, error } = useQuery({ queryKey: ["builder-runs"], queryFn: () => fetchBuilderRuns() });

  return (
    <div className="container space-y-6 py-8">
      <PageHead title="AI Build Control Plane" description="Internal builder — plan, gate, and audit AI-driven changes." noindex />

      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><GitBranch className="h-6 w-6" /> AI Build Control Plane</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Phase 1 (read-only spine). The model <span className="font-medium">requests</span> actions; the control plane
          <span className="font-medium"> decides</span> whether each is permitted, and every decision is audited.
        </p>
      </div>

      {/* Permission model — the load-bearing safety contract. */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" /> Permission model</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-4 font-medium">Level</th><th className="py-1 pr-4 font-medium">Example</th><th className="py-1 font-medium">Execution</th>
              </tr></thead>
              <tbody>
                {PERMISSION_LEVELS.map((r) => (
                  <tr key={r.level} className="border-b last:border-0">
                    <td className="py-1.5 pr-4 font-medium">{r.level}</td>
                    <td className="py-1.5 pr-4 text-muted-foreground">{r.example}</td>
                    <td className="py-1.5">{r.exec}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Honest Phase-1 status: no write authority until scoped credentials exist. */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="flex items-start gap-3 py-4 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-amber-900">
            Write, preview, and deploy connectors are <span className="font-medium">disabled</span> until their scoped
            provider credentials are provisioned (a private GitHub App, a scoped Vercel token, a Supabase management
            key). Only read-only inspection is active. No action can mutate production without an explicit approval.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingState message="Loading runs…" />
          ) : error ? (
            <p className="text-sm text-red-600">Could not load runs: {error instanceof Error ? error.message : "unknown error"}</p>
          ) : !runs || runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No builder runs yet. Runs appear here once the orchestrator is wired up.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">Instruction</th><th className="py-1 pr-4 font-medium">Env</th>
                  <th className="py-1 pr-4 font-medium">Status</th><th className="py-1 font-medium">Created</th>
                </tr></thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b last:border-0">
                      <td className="max-w-md truncate py-1.5 pr-4">{run.instruction}</td>
                      <td className="py-1.5 pr-4"><Badge variant="outline">{run.environment}</Badge></td>
                      <td className="py-1.5 pr-4"><span className={`rounded px-2 py-0.5 text-xs ${STATUS_TONE[run.status] ?? "bg-muted text-muted-foreground"}`}>{run.status}</span></td>
                      <td className="py-1.5 text-muted-foreground">{new Date(run.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
