/**
 * §2 "Why this match?" — a collapsed, structured explanation of one candidate's
 * score. Renders the full ScoreBreakdown: raw vs adjusted score, whether the
 * 95-point identity floor applied (and why), a field-by-field comparison table,
 * points earned/lost, and HARD vs SOFT conflicts kept visually separate. Never a
 * vague "conflicting identity" when structured detail exists.
 */

import { Badge } from "@/components/ui/badge";
import type { FieldResult, ScoreBreakdown } from "@/lib/pricecharting/matching";

const RESULT_STYLE: Record<FieldResult, { label: string; cls: string }> = {
  exact: { label: "exact", cls: "text-emerald-700" },
  normalized_exact: { label: "exact (normalized)", cls: "text-emerald-700" },
  partial: { label: "partial", cls: "text-amber-700" },
  missing: { label: "missing", cls: "text-muted-foreground" },
  mismatch: { label: "mismatch", cls: "text-destructive" },
  not_checked: { label: "not checked", cls: "text-muted-foreground" },
};

export function CandidateDebugPanel({ breakdown }: { breakdown: ScoreBreakdown }) {
  const b = breakdown;
  return (
    <details className="mt-2 rounded-md border bg-muted/20">
      <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">Why this match?</summary>
      <div className="space-y-2 border-t p-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Raw score: <strong>{b.raw_score}</strong></span>
          <span>Adjusted: <strong>{b.adjusted_score}</strong></span>
          <Badge variant={b.disqualified ? "destructive" : "outline"}>{b.disqualified ? "Rejected" : "Eligible"}</Badge>
          {b.identity_floor_applied && <Badge variant="secondary">Identity floor → 95</Badge>}
        </div>
        {b.identity_floor_applied && b.identity_floor_reason && (
          <p className="text-muted-foreground">Floor reason: {b.identity_floor_reason}</p>
        )}

        {b.hard_conflicts.length > 0 && (
          <div className="text-destructive">
            <span className="font-medium">Hard conflicts:</span>
            <ul className="ml-4 list-disc">{b.hard_conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}
        {b.soft_conflicts.length > 0 && (
          <div className="text-amber-700">
            <span className="font-medium">Soft signals (review, not conflicts):</span>
            <ul className="ml-4 list-disc">{b.soft_conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2">Field</th>
                <th className="py-1 pr-2">Requested</th>
                <th className="py-1 pr-2">Candidate</th>
                <th className="py-1 pr-2">Result</th>
                <th className="py-1 pr-2 text-right">Pts</th>
              </tr>
            </thead>
            <tbody>
              {b.fields.map((f) => (
                <tr key={f.field} className="border-t border-border/50 align-top">
                  <td className="py-1 pr-2 font-medium">{f.field}</td>
                  <td className="py-1 pr-2">{f.requested_value ?? "—"}</td>
                  <td className="py-1 pr-2">{f.candidate_value ?? "—"}</td>
                  <td className={`py-1 pr-2 ${RESULT_STYLE[f.result].cls}`}>
                    {RESULT_STYLE[f.result].label}
                    {f.hard_conflict && <span className="ml-1 font-semibold">(hard)</span>}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {f.points_possible > 0 ? `${Math.round(f.points_awarded)}/${f.points_possible}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {b.warnings.length > 0 && (
          <p className="text-muted-foreground">Notes: {b.warnings.join(" · ")}</p>
        )}
      </div>
    </details>
  );
}
