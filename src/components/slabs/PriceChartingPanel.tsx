import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Search, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import {
  priceChartingSearch,
  priceChartingValue,
  priceChartingOfferImage,
  priceChartingLookup,
  type PriceChartingSearchArgs,
} from "@/lib/slabs/data";
import type { LookupResponse } from "@/server/pricecharting/handler";
import { CandidateDebugPanel } from "@/components/slabs/CandidateDebugPanel";
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
  /**
   * Every price tier PriceCharting actually has for this product, in cents
   * (ungraded, Grade 9, PSA 10, CGC 10, …). Populated so the operator can value
   * manually from real data when their exact grade has no tier.
   */
  available_values_cents: Record<string, number | null>;
  /** The raw token-free value response, kept for audit persistence. */
  value_response: unknown;
}

interface PriceChartingPanelProps {
  identity: PriceChartingSearchArgs;
  selectedProductId: string | null;
  onSelect: (sel: SelectedPriceCharting) => void;
  /** Slab front image URL for §3 side-by-side visual confirmation (optional). */
  frontImageUrl?: string | null;
  /** §4 callback when the operator visually confirms/rejects the candidate image. */
  onVisualStatus?: (productId: string, status: "user_confirmed" | "user_rejected", imageUrl: string | null) => void;
}

/** Map a single resolved link-status tone to a Badge variant. */
const TONE_VARIANT: Record<LinkTone, "default" | "secondary" | "destructive" | "outline"> = {
  confirmed: "default",
  proposed: "secondary",
  warning: "outline",
  rejected: "destructive",
  neutral: "outline",
};

export function PriceChartingPanel({ identity, selectedProductId, onSelect, frontImageUrl, onVisualStatus }: PriceChartingPanelProps) {
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offerImage, setOfferImage] = useState<{
    product_id: string;
    url: string | null;
    count: number;
    loading: boolean;
  } | null>(null);
  // Manual product-id / URL recovery.
  const [recoverInput, setRecoverInput] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState<LookupResponse | null>(null);
  const [recoveredInput, setRecoveredInput] = useState(""); // the input the lookup validated
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [visualStatus, setVisualStatus] = useState<{ product_id: string; status: "user_confirmed" | "user_rejected" } | null>(null);

  // A recovered result was identity-checked against the identity AT LOOKUP TIME.
  // If the operator edits identity fields afterward, invalidate it so a stale
  // check can't be confirmed.
  useEffect(() => {
    setRecovered(null);
    setRecoverError(null);
  }, [
    identity.card_name, identity.set, identity.card_number, identity.year,
    identity.language, identity.variation, identity.grader, identity.grade,
  ]);

  const runRecover = async () => {
    const input = recoverInput.trim();
    if (!input) return;
    setRecovering(true);
    setRecoverError(null);
    setRecovered(null);
    try {
      const res = await priceChartingLookup(input, identity);
      if (res.status === "error") {
        setRecoverError(res.message);
        return;
      }
      setRecovered(res);
      setRecoveredInput(input); // remember exactly what was looked up
    } catch (e) {
      setRecoverError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setRecovering(false);
    }
  };

  const confirmRecovered = (r: LookupResponse) => {
    // Source is derived from the input that produced THIS result, not the live box.
    const source =
      /^https?:\/\//i.test(recoveredInput) || recoveredInput.includes("/") ? "manual_product_url" : "manual_product_id";
    onSelect({
      product_id: r.product_id,
      product_name: r.product_name,
      grade_field: r.grade_field,
      value_cents: r.guide_value_cents,
      sales_volume: r.sales_volume,
      match_status: source,
      confidence_score: r.score,
      is_estimate: r.is_estimate,
      available_values_cents: r.available_values_cents ?? {},
      value_response: r,
    });
    setOfferImage({ product_id: r.product_id, url: r.offer_image_url, count: r.offer_listing_count, loading: false });
    toast.success(`Linked to ${r.product_name} (manual recovery)`);
  };

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
        available_values_cents: res.available_values_cents ?? {},
        value_response: res,
      });
      toast.success(`Linked to ${res.product_name}`);
      // Best-effort seller listing photo for visual (metadata + photo) confirmation.
      // Never blocks linking; absence is a normal, expected outcome.
      setOfferImage({ product_id: c.product_id, url: null, count: 0, loading: true });
      priceChartingOfferImage(c.product_id)
        .then((img) => {
          setOfferImage(
            img.status === "success"
              ? { product_id: c.product_id, url: img.offer_image_url, count: img.offer_listing_count, loading: false }
              : { product_id: c.product_id, url: null, count: 0, loading: false },
          );
        })
        .catch(() => setOfferImage({ product_id: c.product_id, url: null, count: 0, loading: false }));
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

                <CandidateDebugPanel breakdown={c.breakdown} />

                {/* §3 Side-by-side visual confirmation. RIGHT is a MARKETPLACE
                    OFFER image (a seller photo), NOT an authoritative catalog
                    image — it's supporting evidence and never overrides metadata. */}
                {isSelected && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-2 text-xs font-medium">
                      Does the PriceCharting image show the same exact card and artwork as your slab?
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1 text-xs">
                        <p className="text-muted-foreground">Your slab</p>
                        {frontImageUrl ? (
                          <img src={frontImageUrl} alt="Your slab front" className="max-h-40 rounded border object-contain" />
                        ) : (
                          <p className="italic text-muted-foreground">No slab image.</p>
                        )}
                        <p className="font-medium">{identity.card_name || "—"}</p>
                        <p className="text-muted-foreground">
                          {[identity.set, identity.card_number ? `#${identity.card_number}` : null, identity.grader, identity.grade]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </p>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p className="text-muted-foreground">
                          PriceCharting: {c.product_name} · ID {c.product_id}
                        </p>
                        {offerImage && offerImage.product_id === c.product_id ? (
                          offerImage.loading ? (
                            <p className="flex items-center gap-1 italic text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" /> Loading image…
                            </p>
                          ) : offerImage.url ? (
                            <>
                              <img src={offerImage.url} alt={`Marketplace offer image for ${c.product_name}`} loading="lazy" className="max-h-40 rounded border object-contain" />
                              <p className="text-[10px] text-muted-foreground">
                                <strong>Marketplace offer image</strong> (a seller's photo) — supporting evidence, not an
                                official catalog image, and it never overrides a metadata conflict.
                              </p>
                            </>
                          ) : (
                            <p className="italic text-muted-foreground">PriceCharting image unavailable.</p>
                          )
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={visualStatus?.product_id === c.product_id && visualStatus.status === "user_confirmed" ? "default" : "outline"}
                        onClick={() => {
                          setVisualStatus({ product_id: c.product_id, status: "user_confirmed" });
                          onVisualStatus?.(c.product_id, "user_confirmed", offerImage?.url ?? null);
                        }}
                      >
                        Yes — same card
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={visualStatus?.product_id === c.product_id && visualStatus.status === "user_rejected" ? "destructive" : "ghost"}
                        onClick={() => {
                          setVisualStatus({ product_id: c.product_id, status: "user_rejected" });
                          onVisualStatus?.(c.product_id, "user_rejected", offerImage?.url ?? null);
                        }}
                      >
                        No — reject
                      </Button>
                      {visualStatus?.product_id === c.product_id && (
                        <span className="text-xs text-muted-foreground">
                          Recorded: {visualStatus.status === "user_confirmed" ? "user-confirmed" : "user-rejected"}
                        </span>
                      )}
                    </div>
                  </div>
                )}
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
                <CandidateDebugPanel breakdown={c.breakdown} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              These were disqualified on a mandatory field and can't be selected here. If PriceCharting genuinely lists
              this card under one of them, correct the identity fields and re-search.
            </p>
          </div>
        </details>
      )}

      {/* Manual recovery — fetch an exact product by id/URL, still identity-checked. */}
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
          Recover by PriceCharting product ID or URL
        </summary>
        <div className="space-y-2 border-t p-3">
          <div className="flex gap-2">
            <Input
              value={recoverInput}
              onChange={(e) => setRecoverInput(e.target.value)}
              placeholder="e.g. 5427932  (or a PriceCharting product URL containing an id)"
              className="text-sm"
            />
            <Button type="button" size="sm" variant="outline" onClick={runRecover} disabled={recovering || !recoverInput.trim()}>
              {recovering ? <Loader2 className="h-4 w-4 animate-spin" /> : "Look up"}
            </Button>
          </div>
          {recoverError && (
            <p className="flex items-start gap-1 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {recoverError}
            </p>
          )}
          {recovered && (
            <div className={`rounded-md border p-2 text-sm ${recovered.disqualified ? "border-destructive/30 bg-destructive/5" : "border-primary/30 bg-primary/5"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{recovered.product_name}</span>
                <Badge variant={recovered.disqualified ? "destructive" : "default"}>
                  {recovered.disqualified ? "Hard conflict" : recovered.requires_confirmation ? "Needs confirmation" : "Identity OK"}
                </Badge>
                <span className="text-xs text-muted-foreground">ID: {recovered.product_id} · score {recovered.score}</span>
              </div>
              {recovered.conflicts.length > 0 && (
                <p className="mt-1 text-xs text-destructive">Conflicts: {recovered.conflicts.join("; ")}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Character: {recovered.character_exact ? "exact" : "unconfirmed"} · Full number:{" "}
                {recovered.number_exact_full ? "exact" : "not exact"} · Guide: {formatCents(recovered.guide_value_cents)}
              </p>
              {recovered.offer_image_url ? (
                <img
                  src={recovered.offer_image_url}
                  alt={`Seller listing photo for ${recovered.product_name}`}
                  loading="lazy"
                  className="mt-2 max-h-40 rounded border object-contain"
                />
              ) : (
                <p className="mt-2 text-xs italic text-muted-foreground">PriceCharting image unavailable.</p>
              )}
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={recovered.disqualified}
                  onClick={() => confirmRecovered(recovered)}
                  title={recovered.disqualified ? "Blocked — this product conflicts with the slab identity" : "Link this product"}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" /> Confirm exact card
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRecovered(null)}>
                  Reject
                </Button>
              </div>
              {recovered.disqualified && (
                <p className="mt-1 text-[11px] text-destructive">
                  Confirmation is blocked: this product hard-conflicts with the slab identity.
                </p>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
