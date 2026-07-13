/**
 * Renders the strict slab-pricing hierarchy from a PricingModel:
 *   1. PRIMARY value card — Final Value headline, exact basis + Exact Match badge,
 *      four secondary metrics, price variance, valuation method.
 *   2. Required disclaimer.
 *   3. Auto valuation note.
 *   4. "Compare Other Grades" expandable — exact tier highlighted, others muted
 *      and labelled ("Raw-card reference only" / "Comparison only"). Never averaged.
 *
 * Presentational only; all logic lives in buildPricingModel.
 */

import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";
import { formatCents } from "@/lib/slabs/format";
import type { PricingModel } from "@/lib/slabs/pricing-display";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

export function SlabPricingCard({ model }: { model: PricingModel }) {
  const {
    match_kind,
    exact_match,
    unavailable,
    basis_label,
    final_cents,
    guide_cents,
    quick_cents,
    replacement_cents,
    confidence_label,
    variance_percent,
    method_label,
    note,
    disclaimer,
    grade_rows,
  } = model;

  return (
    <div className="space-y-3">
      {/* 1. PRIMARY VALUE CARD */}
      <div className="rounded-lg border bg-primary/5 p-4">
        {unavailable ? (
          <p className="text-lg font-semibold text-muted-foreground">Guide value unavailable</p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-bold">{formatCents(final_cents)}</span>
            <span className="text-sm text-muted-foreground">Final Value</span>
            {exact_match && (
              <Badge className="border-transparent bg-emerald-600 text-white hover:bg-emerald-600">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Exact Match
              </Badge>
            )}
            {match_kind === "estimated" && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                Estimated
              </Badge>
            )}
          </div>
        )}
        <p className="mt-1 text-sm font-medium">{basis_label}</p>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Metric label="PriceCharting Guide Value" value={formatCents(guide_cents)} />
          <Metric label="Quick-Sale Value" value={formatCents(quick_cents)} />
          <Metric label="Replacement Value" value={formatCents(replacement_cents)} />
          <Metric label="Valuation Confidence" value={confidence_label} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>Price Variance: {variance_percent === null ? "—" : `${variance_percent}%`}</span>
          <span>Valuation Method: {method_label}</span>
        </div>

        {/* 2. REQUIRED DISCLAIMER — directly beneath the primary value card */}
        <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">{disclaimer}</p>
      </div>

      {/* Auto valuation note */}
      <p className="text-xs text-muted-foreground">{note}</p>

      {/* 3. FULL PRICE GUIDE — expandable, never averaged */}
      {grade_rows.length > 0 && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Compare Other Grades</summary>
          <div className="border-t">
            <table className="w-full text-sm">
              <tbody>
                {grade_rows.map((r) => (
                  <tr key={r.key} className={`border-b last:border-b-0 ${r.muted ? "text-muted-foreground" : ""}`}>
                    <td className="px-3 py-2">
                      <span className={r.kind === "exact" ? "font-semibold" : ""}>{r.label}</span>
                      {r.kind === "exact" && (
                        <Badge className="ml-2 border-transparent bg-emerald-600 text-white hover:bg-emerald-600">
                          Exact Match
                        </Badge>
                      )}
                      {r.note && <span className="ml-2 text-xs italic">{r.note}</span>}
                    </td>
                    <td className={`px-3 py-2 text-right ${r.kind === "exact" ? "font-semibold" : ""}`}>
                      {formatCents(r.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Grades are shown individually and never averaged. PSA 10, CGC 10, CGC Pristine 10, BGS 10, and BGS Black
              Label are distinct and never interchangeable.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
