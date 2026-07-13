import { cloneElement, isValidElement, useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Save, Loader2, Sparkles } from "lucide-react";
import { ImageUploader, type SlabImageState } from "@/components/slabs/ImageUploader";
import { PriceChartingPanel, type SelectedPriceCharting } from "@/components/slabs/PriceChartingPanel";
import { SlabAnalysisPanel } from "@/components/slabs/SlabAnalysisPanel";
import { SlabPricingCard } from "@/components/slabs/SlabPricingCard";
import { analyzeSlab } from "@/lib/slabs/data";
import type { AnalyzeFieldKey, AnalyzeResult } from "@/server/analyze-slab/handler";
import {
  GRADERS,
  LANGUAGES,
  VERIFICATION_STATUSES,
  LABEL_ACCURACY,
  VALUATION_CONFIDENCE,
} from "@/lib/slabs/constants";
import { dollarsToCents, centsToInputString, todayLocalDate } from "@/lib/slabs/format";
import { priceVariancePercent } from "@/lib/slabs/compute-stats";
import { deriveValuation } from "@/lib/slabs/valuation-derive";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import { buildPricingPersist, tierLabelOf, type SlabPricingWrite } from "@/lib/slabs/pricing-tiers";
import { saveSlab, validateSlabInput, type SlabDataAccess } from "@/lib/slabs/save-slab";
import { supabaseSlabDataAccess } from "@/lib/slabs/data";
import type { SlabInput } from "@/lib/slabs/types";

const EMPTY_IDENTITY = {
  card_name: "",
  set_name: "",
  card_number: "",
  year: "",
  language: "English",
  rarity: "",
  variation: "",
  grader: "PSA",
  grade: "",
  grade_label: "",
  certification_number: "",
  label_description: "",
  label_accuracy: "accurate",
  verification_status: "unverified",
};

const EMPTY_VALUATION = {
  final: "",
  quick: "",
  replacement: "",
  guide: "",
  confidence: "manual",
  notes: "",
  date_valued: todayLocalDate(),
};

interface NewSlabPageProps {
  /** Injectable for tests; defaults to the Supabase-backed implementation. */
  dao?: SlabDataAccess;
}

export default function NewSlab({ dao = supabaseSlabDataAccess }: NewSlabPageProps) {
  const navigate = useNavigate();
  const [front, setFront] = useState<SlabImageState | null>(null);
  const [back, setBack] = useState<SlabImageState | null>(null);
  const [id, setId] = useState(EMPTY_IDENTITY);
  const [val, setVal] = useState(EMPTY_VALUATION);
  const [pc, setPc] = useState<SelectedPriceCharting | null>(null);
  const [dup, setDup] = useState<{ id: string; inventory_number: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const setIdField = (k: keyof typeof EMPTY_IDENTITY, v: string) => setId((s) => ({ ...s, [k]: v }));

  // Map an analyze-slab proposal key to the identity form field it fills.
  const ANALYSIS_TO_FIELD: Record<AnalyzeFieldKey, keyof typeof EMPTY_IDENTITY> = {
    card_name: "card_name",
    set: "set_name",
    card_number: "card_number",
    year: "year",
    language: "language",
    rarity: "rarity",
    variation: "variation",
    grader: "grader",
    grade: "grade",
    grade_label: "grade_label",
    certification_number: "certification_number",
    label_description: "label_description",
  };

  const applyAnalysisField = (key: AnalyzeFieldKey, value: string) => setIdField(ANALYSIS_TO_FIELD[key], value);
  const applyAnalysisAll = (values: Partial<Record<AnalyzeFieldKey, string>>) => {
    setId((s) => {
      const next = { ...s };
      for (const [k, v] of Object.entries(values)) {
        if (v !== undefined) next[ANALYSIS_TO_FIELD[k as AnalyzeFieldKey]] = v;
      }
      return next;
    });
  };

  const handleAnalyze = async () => {
    if (!front) {
      toast.error("Add a front image first.");
      return;
    }
    setAnalyzing(true);
    try {
      const res = await analyzeSlab(
        { blob: front.file, mime: front.file.type || "image/jpeg" },
        back ? { blob: back.file, mime: back.file.type || "image/jpeg" } : null,
      );
      if (res.status === "success") {
        setAnalysis(res);
        toast.success("Analysis complete — review and apply the proposed fields.");
      } else {
        toast.error(res.message);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      setAnalyzing(false);
    }
  };
  const setValField = (k: keyof typeof EMPTY_VALUATION, v: string) => setVal((s) => ({ ...s, [k]: v }));

  // Evaluate pricing off the PriceCharting Guide Value the operator entered.
  // Because the API returns only the ungraded price, an operator will usually
  // read the exact graded tier off the PriceCharting site and type it here; this
  // treats it as the exact tier for the slab's grade (Verified) and fills the rest.
  const applyGuideValuation = () => {
    const guideCents = dollarsToCents(val.guide);
    if (guideCents === null) {
      toast.error("Enter the PriceCharting Guide Value first.");
      return;
    }
    const derived = deriveValuation({
      guide_cents: guideCents,
      confidence_score: pc?.confidence_score ?? null,
      exact_tier_label: exactTierLabel(),
    });
    setVal((s) => ({
      ...s,
      final: centsToInputString(derived.suggested_final_cents),
      quick: centsToInputString(derived.quick_sale_cents),
      replacement: centsToInputString(derived.replacement_cents),
      confidence: derived.confidence,
      notes: derived.method,
    }));
    toast.success("Valuation evaluated from the PriceCharting Guide Value.");
  };

  // ── Live duplicate certification check (debounced, grader-scoped) ────────
  useEffect(() => {
    const cert = id.certification_number.trim();
    // A cert is only a duplicate within the same grading company, so both the
    // grader and the cert must be present before we check.
    if (!cert || !id.grader.trim()) {
      setDup(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const existing = await dao.checkCertification(id.grader, cert);
        if (!cancelled) setDup(existing);
      } catch {
        if (!cancelled) setDup(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [id.certification_number, id.grader, dao]);

  const variance = useMemo(
    () => priceVariancePercent(dollarsToCents(val.final), dollarsToCents(val.guide)),
    [val.final, val.guide],
  );

  // Live pricing model, rendered with the SAME SlabPricingCard the detail page
  // uses, from the SAME canonical tiers — so both pages are pixel-identical.
  const pricingModel = useMemo(() => {
    if (!pc && dollarsToCents(val.guide) === null) return null;
    return buildPricingModel({
      final_cents: dollarsToCents(val.final),
      guide_cents: dollarsToCents(val.guide),
      quick_cents: dollarsToCents(val.quick),
      replacement_cents: dollarsToCents(val.replacement),
      valuation_confidence: val.confidence,
      price_variance_percent: variance,
      grader: id.grader,
      grade: id.grade,
      grade_label: id.grade_label,
      product_name: pc?.product_name ?? null,
      product_id: pc?.product_id ?? null,
      available_values_cents: pc?.available_values_cents ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc, val.final, val.guide, val.quick, val.replacement, val.confidence, variance, id.grader, id.grade, id.grade_label]);

  // The slab's own exact grade tier label, e.g. "CGC 10 Pristine".
  const exactTierLabel = () =>
    tierLabelOf({ grader: id.grader, grade: id.grade, grade_label: id.grade_label }) || null;

  const onSelectPc = (sel: SelectedPriceCharting) => {
    setPc(sel);
    // Auto-derive Quick-Sale / Replacement / Confidence from the CONFIRMED guide
    // value using the documented ratios — never leave confidence on "Manual" when
    // the numbers actually came from PriceCharting. A guide value returned at the
    // slab's own grade is the exact tier → Verified.
    const derived = deriveValuation({
      guide_cents: sel.value_cents,
      confidence_score: sel.confidence_score,
      is_estimate: sel.is_estimate,
      field_meaning: sel.grade_field,
      exact_tier_label: sel.value_cents !== null ? exactTierLabel() : null,
    });
    setVal((s) => ({
      ...s,
      guide: centsToInputString(sel.value_cents),
      // Only fill fields the operator hasn't already set — never clobber manual entry.
      final: s.final ? s.final : centsToInputString(derived.suggested_final_cents),
      quick: s.quick ? s.quick : centsToInputString(derived.quick_sale_cents),
      replacement: s.replacement ? s.replacement : centsToInputString(derived.replacement_cents),
      // Confidence was "manual" by default; a derived valuation replaces it.
      confidence: s.confidence === "manual" ? derived.confidence : s.confidence,
      notes: s.notes ? s.notes : derived.method,
    }));
  };

  const buildInput = (): SlabInput => ({
    card_name: id.card_name.trim() || null,
    set_name: id.set_name.trim() || null,
    card_number: id.card_number.trim() || null,
    year: id.year.trim() ? Number(id.year.replace(/[^0-9]/g, "").slice(0, 4)) : null,
    language: id.language || null,
    rarity: id.rarity.trim() || null,
    variation: id.variation.trim() || null,
    grader: id.grader || null,
    grade: id.grade.trim() || null,
    grade_label: id.grade_label.trim() || null,
    certification_number: id.certification_number.trim() || null,
    label_description: id.label_description.trim() || null,
    label_accuracy: id.label_accuracy || null,
    verification_status: id.verification_status || null,
    final_value_cents: dollarsToCents(val.final),
    quick_sale_value_cents: dollarsToCents(val.quick),
    replacement_value_cents: dollarsToCents(val.replacement),
    valuation_confidence: val.confidence || null,
    price_variance_percent: variance,
    notes: val.notes.trim() || null,
    date_valued: val.date_valued ? new Date(val.date_valued).toISOString() : null,
    pricecharting_product_id: pc?.product_id ?? null,
    pricecharting_product_name: pc?.product_name ?? null,
    pricecharting_grade_field: pc?.grade_field ?? null,
    pricecharting_value_cents: dollarsToCents(val.guide),
    pricecharting_sales_volume: pc?.sales_volume ?? null,
    pricecharting_match_status: pc?.match_status ?? null,
    duplicate_status: "unique",
  });

  const canSubmit = !dup && !saving;

  const handleSave = async () => {
    if (dup) {
      toast.error(`Certification already exists as Inventory #${dup.inventory_number}. Open that record instead.`);
      return;
    }
    const input = buildInput();
    const problems = validateSlabInput(input, !!front, !!back);
    if (problems.length > 0) {
      toast.error(problems[0]);
      return;
    }
    // Persist the confirmed PriceCharting tier table (best-effort; the save never
    // depends on it). Built from the SAME live tiers the pricing card renders.
    const pricingWrite: SlabPricingWrite | null = pc
      ? {
          persist: buildPricingPersist(
            pc.available_values_cents,
            { grader: id.grader, grade: id.grade, grade_label: id.grade_label },
            new Date().toISOString(),
          ),
          raw: pc.value_response ?? null,
        }
      : null;

    setSaving(true);
    try {
      const result = await saveSlab(
        input,
        front ? { blob: front.file, ext: front.ext } : null,
        back ? { blob: back.file, ext: back.ext } : null,
        dao,
        pricingWrite,
      );
      if (result.status === "success") {
        toast.success(`Saved as Inventory #${result.slab.inventory_number}`);
        navigate(`/slabs/${result.slab.id}`);
      } else if (result.status === "duplicate") {
        toast.error(`Duplicate certification — already Inventory #${result.existing_inventory_number}.`);
        setDup({ id: "", inventory_number: result.existing_inventory_number });
      } else if (result.status === "validation_error") {
        toast.error(result.errors[0]);
      } else {
        toast.error(result.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const identity = {
    card_name: id.card_name,
    set: id.set_name,
    card_number: id.card_number,
    year: id.year,
    language: id.language,
    variation: id.variation,
    grader: id.grader,
    grade: id.grade,
  };

  return (
    <div className="container max-w-5xl py-8">
      <PageHead title="New Slab · SlabVault" noindex />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Add a Slab</h1>
          <p className="text-sm text-muted-foreground">One graded card at a time. Verify identity before saving.</p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/slabs">Back to inventory</Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Images */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Slab Photographs</CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={handleAnalyze} disabled={!front || analyzing}>
              {analyzing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
              Analyze Images
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <ImageUploader label="Front" side="front" image={front} onChange={setFront} />
            <ImageUploader label="Back" side="back" image={back} onChange={setBack} />
          </CardContent>
        </Card>

        {/* AI analysis proposals (never auto-applied; operator confirms/edits) */}
        {analysis && (
          <div className="lg:col-span-2">
            <SlabAnalysisPanel
              result={analysis}
              backProvided={!!back}
              onApplyField={applyAnalysisField}
              onApplyAll={applyAnalysisAll}
            />
          </div>
        )}

        {/* Identity */}
        <Card>
          <CardHeader>
            <CardTitle>Card Identity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Field label="Card Name" className="col-span-2">
              <Input value={id.card_name} onChange={(e) => setIdField("card_name", e.target.value)} />
            </Field>
            <Field label="Set">
              <Input value={id.set_name} onChange={(e) => setIdField("set_name", e.target.value)} />
            </Field>
            <Field label="Card #">
              <Input value={id.card_number} onChange={(e) => setIdField("card_number", e.target.value)} />
            </Field>
            <Field label="Year">
              <Input value={id.year} onChange={(e) => setIdField("year", e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Language">
              <SelectBox value={id.language} onChange={(v) => setIdField("language", v)} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
            </Field>
            <Field label="Rarity">
              <Input value={id.rarity} onChange={(e) => setIdField("rarity", e.target.value)} />
            </Field>
            <Field label="Variation">
              <Input value={id.variation} onChange={(e) => setIdField("variation", e.target.value)} />
            </Field>
            <Field label="Grader">
              <SelectBox value={id.grader} onChange={(v) => setIdField("grader", v)} options={GRADERS.map((g) => ({ value: g, label: g }))} />
            </Field>
            <Field label="Grade">
              <Input value={id.grade} onChange={(e) => setIdField("grade", e.target.value)} placeholder="e.g. 10, 9.5" />
            </Field>
            <Field label="Grade Label">
              <Input value={id.grade_label} onChange={(e) => setIdField("grade_label", e.target.value)} placeholder="e.g. PRISTINE, GEM MINT" />
            </Field>
            {/* Certification # — text input (leading zeros preserved; never numeric). */}
            <Field label="Certification #" className="col-span-2">
              <Input
                value={id.certification_number}
                onChange={(e) => setIdField("certification_number", e.target.value)}
                inputMode="text"
                autoComplete="off"
              />
            </Field>
            {dup && (
              <div className="col-span-2 -mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  Already exists as Inventory #{dup.inventory_number}.{" "}
                  {dup.id ? (
                    <Link to={`/slabs/${dup.id}`} className="underline">
                      Open existing record
                    </Link>
                  ) : (
                    <Link to="/slabs" className="underline">
                      Find it in inventory
                    </Link>
                  )}
                </span>
              </div>
            )}
            <Field label="Label Description" className="col-span-2">
              <Input value={id.label_description} onChange={(e) => setIdField("label_description", e.target.value)} />
            </Field>
            <Field label="Label Accuracy">
              <SelectBox value={id.label_accuracy} onChange={(v) => setIdField("label_accuracy", v)} options={LABEL_ACCURACY} />
            </Field>
            <Field label="Verification Status">
              <SelectBox value={id.verification_status} onChange={(v) => setIdField("verification_status", v)} options={VERIFICATION_STATUSES} />
            </Field>
          </CardContent>
        </Card>

        {/* PriceCharting */}
        <Card className="lg:col-span-2">
          <CardContent className="pt-6">
            <PriceChartingPanel identity={identity} selectedProductId={pc?.product_id ?? null} onSelect={onSelectPc} />
          </CardContent>
        </Card>

        {/* Valuation */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Valuation</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* Primary value hierarchy — the SAME component the detail page renders. */}
            {pricingModel && (
              <div className="col-span-2 sm:col-span-4">
                <SlabPricingCard model={pricingModel} />
              </div>
            )}
            <Field label="Final Value ($)">
              <Input value={val.final} onChange={(e) => setValField("final", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Quick-Sale Value ($)">
              <Input value={val.quick} onChange={(e) => setValField("quick", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Replacement Value ($)">
              <Input value={val.replacement} onChange={(e) => setValField("replacement", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="PriceCharting Guide Value ($)">
              <Input value={val.guide} onChange={(e) => setValField("guide", e.target.value)} inputMode="decimal" />
            </Field>
            <div className="col-span-2 flex items-end sm:col-span-4">
              <Button type="button" variant="secondary" size="sm" onClick={applyGuideValuation} disabled={!val.guide}>
                Evaluate from PriceCharting Guide Value → Final / Quick-Sale (80%) / Replacement (110%)
              </Button>
            </div>
            <Field label="Valuation Confidence">
              <SelectBox value={val.confidence} onChange={(v) => setValField("confidence", v)} options={VALUATION_CONFIDENCE} />
            </Field>
            <Field label="Price Variance %">
              <Input value={variance === null ? "" : String(variance)} readOnly disabled />
            </Field>
            <Field label="Date Valued">
              <Input type="date" value={val.date_valued} onChange={(e) => setValField("date_valued", e.target.value)} />
            </Field>
            <Field label="Valuation Notes" className="col-span-2 sm:col-span-4">
              <Textarea value={val.notes} onChange={(e) => setValField("notes", e.target.value)} rows={2} />
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link to="/slabs">Cancel</Link>
        </Button>
        <Button onClick={handleSave} disabled={!canSubmit}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          Save Slab
        </Button>
      </div>
    </div>
  );
}

/** Associates the label with its single control (input/textarea/select) via a
 *  generated id, so screen readers announce each field's name. */
function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {isValidElement(children) ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
