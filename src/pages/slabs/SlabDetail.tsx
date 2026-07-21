import { cloneElement, isValidElement, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/shared/LoadingState";
import { backImageStatus } from "@/lib/slabs/back-image-status";
import { ChevronLeft, ChevronRight, Pencil, ImageOff, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { verifiedBlockers } from "@/lib/slabs/save-slab";
import { useAuth } from "@/auth/AuthProvider";
import { SlabCompsSection } from "@/components/slabs/SlabCompsSection";
import { MarketIntelligenceSection } from "@/components/market/MarketIntelligenceSection";
import { SlabAdminActions } from "@/components/slabs/SlabAdminActions";
import { SlabPricingCard } from "@/components/slabs/SlabPricingCard";
import { PriceChartingMarketplacePanel } from "@/components/slabs/PriceChartingMarketplacePanel";
import { SlabEvidencePanel } from "@/components/slabs/SlabEvidencePanel";
import { EbaySellerPanel } from "@/components/slabs/EbaySellerPanel";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import { hydratePriceTiers, tierLabelOf } from "@/lib/slabs/pricing-tiers";
import { deriveValuation } from "@/lib/slabs/valuation-derive";
import {
  identityChangeAction,
  isAutoDerived,
  type ValuationProvenance,
} from "@/lib/slabs/valuation-provenance";
import { priceVariancePercent } from "@/lib/slabs/compute-stats";
import {
  fetchSlabById, fetchAdjacentSlabs, signedImageUrl, updateSlab, refreshSlabPricing,
  supabaseSlabDataAccess,
} from "@/lib/slabs/data";
import { centsToInputString, dollarsToCents } from "@/lib/slabs/format";
import { VERIFICATION_STATUSES, DUPLICATE_STATUSES, LABEL_ACCURACY } from "@/lib/slabs/constants";
import type { Slab } from "@/lib/slabs/types";

export default function SlabDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const isAdmin = status === "admin";

  const { data: slab, isLoading } = useQuery({
    queryKey: ["slab", id],
    queryFn: () => fetchSlabById(id),
    enabled: !!id,
  });

  const { data: adjacent } = useQuery({
    queryKey: ["slab-adjacent", slab?.inventory_number],
    queryFn: () => fetchAdjacentSlabs(slab!.inventory_number),
    enabled: !!slab,
  });

  const { data: images } = useQuery({
    queryKey: ["slab-images", id, slab?.front_image_path, slab?.back_image_path],
    queryFn: async () => ({
      front: await signedImageUrl(slab?.front_image_path ?? null),
      back: await signedImageUrl(slab?.back_image_path ?? null),
    }),
    enabled: !!slab,
  });

  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshPricing = async (current: Slab) => {
    setRefreshing(true);
    try {
      const res = await refreshSlabPricing(current);
      if (res.status === "applied") {
        toast.success(`Pricing refreshed${res.product_name ? ` from ${res.product_name}` : ""}.`);
        queryClient.invalidateQueries({ queryKey: ["slab", id] });
      } else if (res.status === "stale") {
        toast.info(res.message ?? "Newer pricing already applied — nothing changed.");
        queryClient.invalidateQueries({ queryKey: ["slab", id] });
      } else if (res.status === "needs_confirmation") {
        toast.warning(res.message ?? "No confident match — confirm the product in intake first.");
      } else if (res.status === "no_product") {
        toast.info(res.message ?? "No PriceCharting product is linked to this slab.");
      } else {
        toast.error(res.message ?? "Refresh failed.");
      }
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) return <div className="container py-12"><LoadingState message="Loading slab..." /></div>;
  if (!slab) {
    return (
      <div className="container py-12 text-center">
        <p className="mb-4 text-muted-foreground">Slab not found.</p>
        <Button asChild><Link to="/slabs">Back to inventory</Link></Button>
      </div>
    );
  }

  // The persisted tiers already encode which tier is the slab's exact one; the
  // valuation is designation-exact only if that exact tier actually has a value
  // (e.g. a Pristine slab whose exact tier is unavailable stays compatible).
  const hydratedTiers = hydratePriceTiers(slab.pricecharting_tiers);
  const detailDesignationExact = hydratedTiers?.find((t) => t.exact_match)?.available;

  // §3 A draft (unverified) shows exactly what remains to make it a verified record.
  const isDraft = slab.verification_status !== "verified";
  const toVerify = verifiedBlockers(slab, !!slab.front_image_path);

  return (
    <div className="container max-w-5xl py-8">
      <PageHead title={`Slab #${slab.inventory_number} · GradedCardValue.com`} noindex />

      {/* Header + prev/next */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{slab.inventory_code ?? `#${slab.inventory_number}`}</h1>
            <Badge variant="outline" title="Internal inventory number">#{slab.inventory_number}</Badge>
            {slab.verification_status && <Badge variant="outline">{slab.verification_status}</Badge>}
            {slab.archived_at && <Badge variant="outline" className="border-amber-500 text-amber-600">Archived</Badge>}
          </div>
          <p className="text-muted-foreground">{slab.card_name ?? "Unnamed card"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!adjacent?.prev} asChild={!!adjacent?.prev}>
            {adjacent?.prev ? (
              <Link to={`/slabs/${adjacent.prev.id}`}><ChevronLeft className="h-4 w-4" /> Prev</Link>
            ) : (
              <span><ChevronLeft className="h-4 w-4" /> Prev</span>
            )}
          </Button>
          <Button variant="outline" size="sm" disabled={!adjacent?.next} asChild={!!adjacent?.next}>
            {adjacent?.next ? (
              <Link to={`/slabs/${adjacent.next.id}`}>Next <ChevronRight className="h-4 w-4" /></Link>
            ) : (
              <span>Next <ChevronRight className="h-4 w-4" /></span>
            )}
          </Button>
          <EditSlabDialog key={slab.id} slab={slab} onSaved={() => queryClient.invalidateQueries({ queryKey: ["slab", id] })} />
        </div>
      </div>

      {/* §3 Draft — the exact unresolved requirements to make this a verified record. */}
      {isDraft && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Unverified draft.</p>
            {toVerify.length > 0 ? (
              <p>To make this a verified record, add: {toVerify.join(", ")}.</p>
            ) : (
              <p>All required fields are present — edit the record and set its status to “verified”.</p>
            )}
          </div>
        </div>
      )}

      {/* Admin actions: archive / restore / hard-delete test records */}
      <div className="mb-6 flex justify-end">
        <SlabAdminActions slab={slab} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Photos */}
        <Card>
          <CardHeader><CardTitle>Photographs</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <SlabPhoto label="Front" url={images?.front ?? null} />
            <SlabPhoto label="Back" url={images?.back ?? null} />
            {!slab.back_image_path && (
              <p className="col-span-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {backImageStatus(slab.back_image_path).note}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Identity */}
        <Card>
          <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Detail label="Grader" value={slab.grader} />
            <Detail label="Grade" value={slab.grade} />
            <Detail label="Grade Label" value={slab.grade_label} />
            <Detail label="Certification #" value={slab.certification_number} mono />
            <Detail label="Set" value={slab.set_name} />
            <Detail label="Card #" value={slab.card_number} />
            <Detail label="Year" value={slab.year} />
            <Detail label="Language" value={slab.language} />
            <Detail label="Rarity" value={slab.rarity} />
            <Detail label="Variation" value={slab.variation} />
            <Detail label="Label Accuracy" value={slab.label_accuracy} />
            <Detail label="Label Description" value={slab.label_description} className="col-span-2" />
          </CardContent>
        </Card>

        {/* Valuation — strict pricing hierarchy (primary value card + grade table) */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Valuation</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Date Valued: {slab.date_valued ? slab.date_valued.slice(0, 10) : "—"}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={() => handleRefreshPricing(slab)}
                title="Re-fetch the current PriceCharting tier table for this slab"
              >
                {refreshing ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-4 w-4" />
                )}
                Refresh pricing
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <SlabPricingCard
              model={buildPricingModel({
                final_cents: slab.final_value_cents,
                guide_cents: slab.pricecharting_value_cents,
                quick_cents: slab.quick_sale_value_cents,
                replacement_cents: slab.replacement_value_cents,
                valuation_confidence: slab.valuation_confidence,
                valuation_provenance: slab.valuation_provenance,
                price_variance_percent: slab.price_variance_percent,
                grader: slab.grader,
                grade: slab.grade,
                grade_label: slab.grade_label,
                product_name: slab.pricecharting_product_name,
                product_id: slab.pricecharting_product_id,
                designation_exact: detailDesignationExact,
                // Hydrate the persisted tier table so the saved slab shows the
                // same Compare Other Grades that was available during intake.
                // Older rows have no tiers → sparse fallback (exact tier only).
                tiers: hydratedTiers,
              })}
            />
          </CardContent>
        </Card>
      </div>

      {/* Comps — CRUD + stats + operator-approved Final Value */}
      <SlabCompsSection slab={slab} />

      <MarketIntelligenceSection request={{ slab_id: slab.id }} />

      <SlabEvidencePanel slab={slab} />

      {/* Marketplace + eBay selling are administrative tools, not part of a
          customer's private inventory. RLS keeps the underlying tables
          admin-only; this hides the UI that would only ever error for them. */}
      {isAdmin && <PriceChartingMarketplacePanel slab={slab} />}

      {isAdmin && <EbaySellerPanel slab={slab} />}

      {/* Notes */}
      <Card className="mt-6">
        <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{slab.notes || "No notes."}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function SlabPhoto({ label, url }: { label: string; url: string | null }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {url ? (
        <img src={url} alt={label} className="w-full rounded border object-contain" />
      ) : (
        <div className="flex h-40 flex-col items-center justify-center gap-1 rounded border bg-muted/30 text-muted-foreground">
          <ImageOff className="h-6 w-6" />
          <span className="text-xs">No image</span>
        </div>
      )}
    </div>
  );
}

function Detail({
  label, value, className, mono, strong,
}: {
  label: string;
  value: string | number | null | undefined;
  className?: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`${mono ? "font-mono" : ""} ${strong ? "text-base font-semibold" : ""}`}>
        {value === null || value === undefined || value === "" ? "—" : value}
      </p>
    </div>
  );
}

export function EditSlabDialog({ slab, onSaved }: { slab: Slab; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const persistedProvenance: ValuationProvenance = slab.valuation_provenance
    ?? (slab.pricecharting_value_cents !== null ? "manual_guide"
      : slab.final_value_cents !== null ? "manual_value" : "tier_unavailable");
  const [form, setForm] = useState({
    card_name: slab.card_name ?? "",
    set_name: slab.set_name ?? "",
    card_number: slab.card_number ?? "",
    year: slab.year?.toString() ?? "",
    language: slab.language ?? "",
    rarity: slab.rarity ?? "",
    variation: slab.variation ?? "",
    grader: slab.grader ?? "",
    grade: slab.grade ?? "",
    grade_label: slab.grade_label ?? "",
    certification_number: slab.certification_number ?? "",
    label_description: slab.label_description ?? "",
    final: centsToInputString(slab.final_value_cents),
    quick: centsToInputString(slab.quick_sale_value_cents),
    replacement: centsToInputString(slab.replacement_value_cents),
    guide: centsToInputString(slab.pricecharting_value_cents),
    verification_status: slab.verification_status ?? "unverified",
    valuation_confidence: slab.valuation_confidence ?? "",
    valuation_provenance: persistedProvenance,
    duplicate_status: slab.duplicate_status ?? "unique",
    label_accuracy: slab.label_accuracy ?? "accurate",
    notes: slab.notes ?? "",
  });

  const identityChanged = (
    form.card_name.trim() !== (slab.card_name ?? "").trim()
    || form.set_name.trim() !== (slab.set_name ?? "").trim()
    || form.card_number.trim() !== (slab.card_number ?? "").trim()
    || form.year.trim() !== (slab.year?.toString() ?? "")
    || form.language.trim() !== (slab.language ?? "").trim()
    || form.rarity.trim() !== (slab.rarity ?? "").trim()
    || form.variation.trim() !== (slab.variation ?? "").trim()
    || form.grader.trim() !== (slab.grader ?? "").trim()
    || form.grade.trim() !== (slab.grade ?? "").trim()
    || form.grade_label.trim() !== (slab.grade_label ?? "").trim()
    || form.certification_number.trim() !== (slab.certification_number ?? "").trim()
  );
  const valuationTouched = form.guide !== centsToInputString(slab.pricecharting_value_cents)
    || form.final !== centsToInputString(slab.final_value_cents)
    || form.quick !== centsToInputString(slab.quick_sale_value_cents)
    || form.replacement !== centsToInputString(slab.replacement_value_cents);
  const blockers = verifiedBlockers(form, !!slab.front_image_path);

  const save = async () => {
    if (form.verification_status === "verified" && blockers.length > 0) {
      toast.error(`Cannot verify: add ${blockers.join(", ")}.`);
      return;
    }
    setSaving(true);
    try {
      const graderOrCertChanged = form.grader.trim() !== (slab.grader ?? "").trim()
        || form.certification_number.trim() !== (slab.certification_number ?? "").trim();
      if (graderOrCertChanged && form.grader.trim() && form.certification_number.trim()) {
        const duplicate = await supabaseSlabDataAccess.checkCertification(
          form.grader.trim(),
          form.certification_number.trim(),
        );
        if (duplicate && duplicate.id !== slab.id) {
          toast.error(`Certification already exists as Inventory #${duplicate.inventory_number}.`);
          return;
        }
      }

      const guideCents = dollarsToCents(form.guide);
      let provenance = form.valuation_provenance;
      let confidence: string | null = form.valuation_confidence || null;
      const patch: Partial<Slab> = {
        card_name: form.card_name.trim() || null,
        set_name: form.set_name.trim() || null,
        card_number: form.card_number.trim() || null,
        year: form.year.trim() ? Number(form.year.replace(/[^0-9]/g, "").slice(0, 4)) : null,
        language: form.language.trim() || null,
        rarity: form.rarity.trim() || null,
        variation: form.variation.trim() || null,
        grader: form.grader.trim() || null,
        grade: form.grade.trim() || null,
        grade_label: form.grade_label.trim() || null,
        certification_number: form.certification_number.trim() || null,
        label_description: form.label_description.trim() || null,
        final_value_cents: dollarsToCents(form.final),
        quick_sale_value_cents: dollarsToCents(form.quick),
        replacement_value_cents: dollarsToCents(form.replacement),
        pricecharting_value_cents: guideCents,
        price_variance_percent: priceVariancePercent(dollarsToCents(form.final), guideCents),
        verification_status: form.verification_status,
        duplicate_status: form.duplicate_status,
        label_accuracy: form.label_accuracy,
        notes: form.notes || null,
      };

      if (valuationTouched) {
        provenance = guideCents !== null ? "manual_guide"
          : patch.final_value_cents !== null ? "manual_value" : "tier_unavailable";
        confidence = provenance === "tier_unavailable" ? null : "manual";
      }

      if (identityChanged) {
        const action = identityChangeAction(persistedProvenance);
        const replaceWithManual = valuationTouched && !isAutoDerived(provenance);
        if (action.clearAutoValuation && !replaceWithManual) {
          Object.assign(patch, {
            final_value_cents: null,
            quick_sale_value_cents: null,
            replacement_value_cents: null,
            pricecharting_product_id: null,
            pricecharting_product_name: null,
            pricecharting_grade_field: null,
            pricecharting_value_cents: null,
            pricecharting_sales_volume: null,
            pricecharting_match_status: null,
            pricecharting_tiers: null,
            pricecharting_raw: null,
            pricecharting_priced_at: null,
            price_variance_percent: null,
          });
          provenance = "tier_unavailable";
          confidence = null;
          toast.warning("Identity changed; the prior auto-derived pricing was cleared.");
        } else {
          patch.pricecharting_match_status = "stale_identity_changed";
          toast.warning("Identity changed; the manual valuation was preserved and marked for review.");
        }
        Object.assign(patch, {
          candidate_image_url: null,
          candidate_image_source: "none",
          candidate_image_type: null,
          candidate_image_retrieved_at: null,
          candidate_image_available: false,
          visual_confirmation_status: "not_reviewed",
          visual_confirmation_method: null,
          visual_confirmation_at: null,
          visual_confirmation_by: null,
          visual_rejection_reason: null,
          visual_rejection_note: null,
          product_confirmation_source: null,
          product_confirmed_at: null,
        });
      }

      patch.valuation_provenance = provenance;
      patch.valuation_confidence = confidence;
      await updateSlab(slab.id, patch);
      toast.success("Slab updated");
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));

  // An operator-entered guide is explicitly manual; it can never inherit an
  // exact-source or Verified label from the previously linked product.
  const evaluateFromGuide = () => {
    const guideCents = dollarsToCents(form.guide);
    if (guideCents === null) {
      toast.error("Enter the PriceCharting Guide Value first.");
      return;
    }
    const derived = deriveValuation({
      guide_cents: guideCents,
      confidence_score: null,
      provenance: "manual_guide",
      field_meaning: tierLabelOf({ grader: form.grader, grade: form.grade, grade_label: form.grade_label }) || null,
    });
    setForm((s) => ({
      ...s,
      final: centsToInputString(derived.suggested_final_cents),
      quick: centsToInputString(derived.quick_sale_cents),
      replacement: centsToInputString(derived.replacement_cents),
      valuation_confidence: derived.confidence ?? "",
      valuation_provenance: "manual_guide",
      notes: derived.method,
    }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Pencil className="mr-1 h-4 w-4" /> Edit</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Edit Slab #{slab.inventory_number}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <EditField label="Card Name" className="col-span-2"><Input value={form.card_name} onChange={(e) => set("card_name", e.target.value)} /></EditField>
          <EditField label="Set"><Input value={form.set_name} onChange={(e) => set("set_name", e.target.value)} /></EditField>
          <EditField label="Card #"><Input value={form.card_number} onChange={(e) => set("card_number", e.target.value)} /></EditField>
          <EditField label="Year"><Input value={form.year} onChange={(e) => set("year", e.target.value)} inputMode="numeric" /></EditField>
          <EditField label="Language"><Input value={form.language} onChange={(e) => set("language", e.target.value)} /></EditField>
          <EditField label="Rarity"><Input value={form.rarity} onChange={(e) => set("rarity", e.target.value)} /></EditField>
          <EditField label="Variation"><Input value={form.variation} onChange={(e) => set("variation", e.target.value)} /></EditField>
          <EditField label="Grader"><Input value={form.grader} onChange={(e) => set("grader", e.target.value)} /></EditField>
          <EditField label="Grade"><Input value={form.grade} onChange={(e) => set("grade", e.target.value)} /></EditField>
          <EditField label="Grade Label"><Input value={form.grade_label} onChange={(e) => set("grade_label", e.target.value)} placeholder="e.g. PRISTINE or PERFECT" /></EditField>
          <EditField label="Certification #"><Input value={form.certification_number} onChange={(e) => set("certification_number", e.target.value)} /></EditField>
          <EditField label="Label Description" className="col-span-2"><Input value={form.label_description} onChange={(e) => set("label_description", e.target.value)} /></EditField>
          <EditField label="PriceCharting Guide Value ($)" className="col-span-2">
            <Input value={form.guide} onChange={(e) => setForm((s) => ({ ...s, guide: e.target.value, valuation_provenance: "manual_guide", valuation_confidence: "manual" }))} inputMode="decimal" placeholder="e.g. 42.50 (operator-entered guide)" />
          </EditField>
          <div className="col-span-2 -mt-1">
            <Button type="button" variant="secondary" size="sm" onClick={evaluateFromGuide} disabled={!form.guide}>
              Evaluate manual {tierLabelOf({ grader: form.grader, grade: form.grade, grade_label: form.grade_label }) || "guide"} → Final / Quick-Sale (80%) / Replacement (110%)
            </Button>
          </div>
          <EditField label="Final Value ($)"><Input value={form.final} onChange={(e) => setForm((s) => ({ ...s, final: e.target.value, valuation_provenance: "manual_value", valuation_confidence: "manual" }))} inputMode="decimal" /></EditField>
          <EditField label="Quick-Sale ($)"><Input value={form.quick} onChange={(e) => set("quick", e.target.value)} inputMode="decimal" /></EditField>
          <EditField label="Replacement ($)"><Input value={form.replacement} onChange={(e) => set("replacement", e.target.value)} inputMode="decimal" /></EditField>
          <EditField label="Verification">
            <EditSelect value={form.verification_status} onChange={(v) => set("verification_status", v)} options={VERIFICATION_STATUSES} />
          </EditField>
          <EditField label="Confidence / Provenance">
            <Input value={`${form.valuation_confidence || "Unavailable"} · ${form.valuation_provenance}`} readOnly />
          </EditField>
          <EditField label="Duplicate Status">
            <EditSelect value={form.duplicate_status} onChange={(v) => set("duplicate_status", v)} options={DUPLICATE_STATUSES} />
          </EditField>
          <EditField label="Label Accuracy">
            <EditSelect value={form.label_accuracy} onChange={(v) => set("label_accuracy", v)} options={LABEL_ACCURACY} />
          </EditField>
          <EditField label="Notes" className="col-span-2">
            <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
          </EditField>
          {identityChanged && (
            <div className="col-span-2 rounded border border-amber-400/50 bg-amber-50 p-2 text-xs text-amber-800">
              Identity changed. Connected pricing and image confirmation will be invalidated; manual values are preserved but marked for review.
            </div>
          )}
          {form.verification_status === "verified" && blockers.length > 0 && (
            <div className="col-span-2 rounded border border-destructive/40 p-2 text-xs text-destructive">
              Cannot verify until you add: {blockers.join(", ")}.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || (form.verification_status === "verified" && blockers.length > 0)}>{saving ? "Saving..." : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditField({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {isValidElement(children) ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}

function EditSelect({
  value, onChange, options, id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
