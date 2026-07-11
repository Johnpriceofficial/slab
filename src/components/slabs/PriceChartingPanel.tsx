import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Search, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { priceChartingSearch, priceChartingValue, type PriceChartingSearchArgs } from "@/lib/slabs/data";
import { formatCents } from "@/lib/slabs/format";
import type { CandidateResult, SearchResponse } from "@/server/pricecharting/handler";

export interface SelectedPriceCharting {
  product_id: string;
  product_name: string;
  grade_field: string | null;
  value_cents: number | null;
  sales_volume: number | null;
  match_status: string;
  confidence_score: number;
}

interface PriceChartingPanelProps {
  identity: PriceChartingSearchArgs;
  selectedProductId: string | null;
  onSelect: (sel: SelectedPriceCharting) => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  exact: "default",
  likely: "secondary",
  unverified: "outline",
  no_match: "destructive",
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
      if (res.candidates.length === 0) toast.info("No PriceCharting candidates found.");
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
      });
      toast.success(`Linked to ${res.product_name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to retrieve value");
    } finally {
      setConfirmingId(null);
    }
  };

  const recommendedId = result && !result.requires_confirmation ? result.auto_confirmed_product_id : null;

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

      {result && result.requires_confirmation && result.candidates.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          Confidence is below the auto-confirm threshold ({result.confidence_score}). Confirm the correct product manually.
        </div>
      )}

      {result && result.candidates.length > 0 && (
        <div className="space-y-2">
          {result.candidates.map((c) => {
            const isSelected = selectedProductId === c.product_id;
            const isRecommended = recommendedId === c.product_id;
            return (
              <div
                key={c.product_id}
                className={`rounded-lg border p-3 text-sm ${isSelected ? "border-primary bg-primary/5" : ""}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.product_name}</span>
                      <Badge variant={STATUS_VARIANT[c.match_status] ?? "outline"}>{c.match_status}</Badge>
                      {isRecommended && <Badge variant="secondary">Recommended</Badge>}
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
    </div>
  );
}
