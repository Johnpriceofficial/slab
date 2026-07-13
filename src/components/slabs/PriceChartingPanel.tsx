import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Search, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { priceChartingSearch, priceChartingValue, type PriceChartingSearchArgs } from "@/lib/slabs/data";
import { formatCents } from "@/lib/slabs/format";
import {
  deriveCandidateStatus,
  shouldShowBelowThresholdBanner,
  type LinkTone,
} from "@/lib/slabs/link-status";
import type { CandidateResult, SearchResponse } from "@/server/pricecharting/handler";

export interface SelectedPriceCharting {
  product_id: string;
  product_name: string;
  grade_field: string | null;
  value_cents: number | null;
  sales_volume: number | null;
  match_status: string;
  confidence_score: number;
  /** True when the guide value is an interpolated grade estimate, not a direct tier. */
  is_estimate: boolean;
}

interface PriceChartingPanelProps {
  identity: PriceChartingSearchArgs;
  selectedProductId: string | null;
  onSelect: (sel: SelectedPriceCharting) => void;
}

/** Map a single resolved link-status tone to a Badge variant. */
const TONE_VARIANT: Record<LinkTone, "default" | "secondary" | "destructive" | "outline"> = {
  confirmed: "default",
  proposed: "secondary",
  warning: "outline",
  rejected: "destructive",
  neutral: "outline",
};

export function PriceChartingPanel({ identity, selectedProductId, onSelect }: PriceChartingPanelProps) {
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await priceChartingSearch(identity);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      setResult(res);
      if (res.candidates.length === 0) {
        const rejected = res.rejected_candidates?.length ?? 0;
        toast.info(
          rejected > 0
            ? `No eligible match — ${rejected} candidate(s) rejected (wrong number/character/set).`
            : "No PriceCharting candidates found.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const confirmCandidate = async (c: CandidateResult) => {
    setConfirmingId(c.product_id);
    try {
      const res = await priceChartingValue(c.product_id, identity.grader, identity.grade);
      if (res.status === "error") {
        toast.error(res.message);
        return;
      }
      onSelect({
        product_id: res.product_id,
        product_name: res.product_name,
        grade_field: res.grade_field,
        value_cents: res.guide_value_cents,
        sales_volume: res.sales_volume,
        match_status: c.match_status,
        confidence_score: c.confidence_score,
        is_estimate: res.is_estimate,
      });
      toast.success(`Linked to ${res.product_name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to retrieve value");
    } finally {
      setConfirmingId(null);
    }
  };

  const statusCtx = result
    ? {
        selectedProductId,
        autoConfirmedProductId: result.auto_confirmed_product_id,
        requiresConfirmation: result.requires_confirmation,
      }
    : null;

  const showBelowThreshold =
    !!result &&
    shouldShowBelowThresholdBanner({
      requiresConfirmation: result.requires_confirmation,
      selectedProductId,
      candidateCount: result.candidates.length,
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">PriceCharting</h3>
          <p className="text-xs text-muted-foreground">Current PriceCharting Guide Value — not a last-sold or eBay-sold price.</p>
        </div>
        <Button type="button" onClick={runSearch} disabled={loading} size="sm">
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
          Search PriceCharting
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {showBelowThreshold && (
        <div className="flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          Confidence is below the auto-confirm threshold ({result!.confidence_score}). Confirm the correct product manually.
        </div>
      )}

      {result && result.candidates.length > 0 && (
        <div className="space-y-2">
          {result.candidates.map((c) => {
            const isSelected = selectedProductId === c.product_id;
            // ONE resolved status per candidate — never the raw match tag alongside
            // a stale "below threshold" banner or "Linked" button.
            const view = deriveCandidateStatus(c, statusCtx!);
            return (
              <div
                key={c.product_id}
                className={`rounded-lg border p-3 text-sm ${isSelected ? "border-primary bg-primary/5" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.product_name}</span>
                      <Badge variant={TONE_VARIANT[view.tone]}>{view.label}</Badge>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-4">
                      <span>ID: {c.product_id}</span>
                      <span>Confidence: {c.confidence_score}</span>
                      <span>Field: {c.grade_field ?? "—"}</span>
                      <span>Guide: {formatCents(c.guide_value_cents)}</span>
                    </div>
                    {c.conflicts.length > 0 && (
                      <div className="mt-1 text-xs text-destructive">Conflicts: {c.conflicts.join("; ")}</div>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={isSelected ? "secondary" : "outline"}
                    disabled={confirmingId === c.product_id}
                    onClick={() => confirmCandidate(c)}
                  >
                    {confirmingId === c.product_id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isSelected ? (
                      <>
                        <CheckCircle2 className="mr-1 h-4 w-4" /> Linked
                      </>
                    ) : (
                      "Use this product"
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* No eligible product, but candidates were returned and rejected. */}
      {result && result.candidates.length === 0 && (result.rejected_candidates?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No eligible PriceCharting match. Every returned candidate conflicts on a mandatory identity field
            (collector number, character, or set) — see rejected candidates below. This is common for Japanese cards;
            value from sold comps instead.
          </span>
        </div>
      )}

      {/* Hard-disqualified candidates — collapsed, NOT selectable by default. */}
      {result && (result.rejected_candidates?.length ?? 0) > 0 && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
            Rejected candidates ({result.rejected_candidates.length}) — conflicting identity
          </summary>
          <div className="space-y-2 border-t p-3">
            {result.rejected_candidates.map((c) => (
              <div key={c.product_id} className="rounded-md border border-destructive/20 bg-destructive/5 p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.product_name}</span>
                  <Badge variant="destructive">rejected</Badge>
                  <span className="text-xs text-muted-foreground">ID: {c.product_id}</span>
                </div>
                {c.conflicts.length > 0 && (
                  <div className="mt-1 text-xs text-destructive">Reason: {c.conflicts.join("; ")}</div>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              These were disqualified on a mandatory field and can't be selected here. If PriceCharting genuinely lists
              this card under one of them, correct the identity fields and re-search.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
