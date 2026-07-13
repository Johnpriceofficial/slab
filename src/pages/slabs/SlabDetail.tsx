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
import { ChevronLeft, ChevronRight, Pencil, ImageOff, RefreshCw, Loader2 } from "lucide-react";
import { SlabCompsSection } from "@/components/slabs/SlabCompsSection";
import { SlabAdminActions } from "@/components/slabs/SlabAdminActions";
import { SlabPricingCard } from "@/components/slabs/SlabPricingCard";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import { hydratePriceTiers, tierLabelOf } from "@/lib/slabs/pricing-tiers";
import { deriveValuation } from "@/lib/slabs/valuation-derive";
import { priceVariancePercent } from "@/lib/slabs/compute-stats";
import {
  fetchSlabById, fetchAdjacentSlabs, signedImageUrl, updateSlab, refreshSlabPricing,
} from "@/lib/slabs/data";
import { formatCents, centsToInputString, dollarsToCents } from "@/lib/slabs/format";
import { VERIFICATION_STATUSES, VALUATION_CONFIDENCE, DUPLICATE_STATUSES, LABEL_ACCURACY } from "@/lib/slabs/constants";
import type { Slab } from "@/lib/slabs/types";

export default function SlabDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();

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

  return (
    <div className="container max-w-5xl py-8">
      <PageHead title={`Slab #${slab.inventory_number} · SlabVault`} noindex />

      {/* Header + prev/next */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Inventory #{slab.inventory_number}</h1>
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
          <EditSlabDialog slab={slab} onSaved={() => queryClient.invalidateQueries({ queryKey: ["slab", id] })} />
        </div>
      </div>

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
                price_variance_percent: slab.price_variance_percent,
                grader: slab.grader,
                grade: slab.grade,
                grade_label: slab.grade_label,
                product_name: slab.pricecharting_product_name,
                product_id: slab.pricecharting_product_id,
                // Hydrate the persisted tier table so the saved slab shows the
                // same Compare Other Grades that was available during intake.
                // Older rows have no tiers → sparse fallback (exact tier only).
                tiers: hydratePriceTiers(slab.pricecharting_tiers),
              })}
            />
          </CardContent>
        </Card>
      </div>

      {/* Comps — CRUD + stats + operator-approved Final Value */}
      <SlabCompsSection slab={slab} />

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

function EditSlabDialog({ slab, onSaved }: { slab: Slab; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    final: centsToInputString(slab.final_value_cents),
    quick: centsToInputString(slab.quick_sale_value_cents),
    replacement: centsToInputString(slab.replacement_value_cents),
    guide: centsToInputString(slab.pricecharting_value_cents),
    verification_status: slab.verification_status ?? "unverified",
    valuation_confidence: slab.valuation_confidence ?? "manual",
    duplicate_status: slab.duplicate_status ?? "unique",
    label_accuracy: slab.label_accuracy ?? "accurate",
    notes: slab.notes ?? "",
  });

  const save = async () => {
    setSaving(true);
    try {
      const guideCents = dollarsToCents(form.guide);
      await updateSlab(slab.id, {
        final_value_cents: dollarsToCents(form.final),
        quick_sale_value_cents: dollarsToCents(form.quick),
        replacement_value_cents: dollarsToCents(form.replacement),
        // Graded guide entered by hand (the API has no tier for many cards). This
        // becomes the exact-tier value the pricing card renders.
        pricecharting_value_cents: guideCents,
        price_variance_percent: priceVariancePercent(dollarsToCents(form.final), guideCents),
        verification_status: form.verification_status,
        valuation_confidence: form.valuation_confidence,
        duplicate_status: form.duplicate_status,
        label_accuracy: form.label_accuracy,
        notes: form.notes || null,
      });
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

  // Evaluate the hand-entered guide as the slab's EXACT tier (e.g. CGC 10
  // Pristine) → Verified, with Quick-Sale/Replacement/notes derived, matching
  // the intake screen's behaviour.
  const evaluateFromGuide = () => {
    const guideCents = dollarsToCents(form.guide);
    if (guideCents === null) {
      toast.error("Enter the PriceCharting Guide Value first.");
      return;
    }
    const derived = deriveValuation({
      guide_cents: guideCents,
      confidence_score: null,
      exact_tier_label: tierLabelOf({ grader: slab.grader, grade: slab.grade, grade_label: slab.grade_label }) || null,
    });
    setForm((s) => ({
      ...s,
      final: centsToInputString(derived.suggested_final_cents),
      quick: centsToInputString(derived.quick_sale_cents),
      replacement: centsToInputString(derived.replacement_cents),
      valuation_confidence: derived.confidence,
      notes: derived.method,
    }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Pencil className="mr-1 h-4 w-4" /> Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Slab #{slab.inventory_number}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <EditField label="PriceCharting Guide Value ($)" className="col-span-2">
            <Input value={form.guide} onChange={(e) => set("guide", e.target.value)} inputMode="decimal" placeholder="e.g. 42.50 (read from PriceCharting for this grade)" />
          </EditField>
          <div className="col-span-2 -mt-1">
            <Button type="button" variant="secondary" size="sm" onClick={evaluateFromGuide} disabled={!form.guide}>
              Evaluate as {tierLabelOf({ grader: slab.grader, grade: slab.grade, grade_label: slab.grade_label }) || "exact tier"} → Final / Quick-Sale (80%) / Replacement (110%)
            </Button>
          </div>
          <EditField label="Final Value ($)"><Input value={form.final} onChange={(e) => set("final", e.target.value)} inputMode="decimal" /></EditField>
          <EditField label="Quick-Sale ($)"><Input value={form.quick} onChange={(e) => set("quick", e.target.value)} inputMode="decimal" /></EditField>
          <EditField label="Replacement ($)"><Input value={form.replacement} onChange={(e) => set("replacement", e.target.value)} inputMode="decimal" /></EditField>
          <EditField label="Verification">
            <EditSelect value={form.verification_status} onChange={(v) => set("verification_status", v)} options={VERIFICATION_STATUSES} />
          </EditField>
          <EditField label="Confidence">
            <EditSelect value={form.valuation_confidence} onChange={(v) => set("valuation_confidence", v)} options={VALUATION_CONFIDENCE} />
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save changes"}</Button>
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
