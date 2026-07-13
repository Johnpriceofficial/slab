import { cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";
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
import type { ImageSource } from "@/server/pricecharting/handler";
import { SlabAnalysisPanel } from "@/components/slabs/SlabAnalysisPanel";
import { SlabPricingCard } from "@/components/slabs/SlabPricingCard";
import { analyzeSlab, recordPricechartingConfirmation, type PricechartingConfirmation } from "@/lib/slabs/data";
import { SCORING_VERSION } from "@/lib/pricecharting/matching";
import type { AnalyzeFieldKey, AnalyzeResult } from "@/server/analyze-slab/handler";
import {
  GRADERS,
  LANGUAGES,
  VERIFICATION_STATUSES,
  LABEL_ACCURACY,
} from "@/lib/slabs/constants";
import { dollarsToCents, centsToInputString, todayLocalDate } from "@/lib/slabs/format";
import { priceVariancePercent } from "@/lib/slabs/compute-stats";
import { deriveValuation } from "@/lib/slabs/valuation-derive";
import { buildPricingModel } from "@/lib/slabs/pricing-display";
import {
  identityChangeAction,
  isAutoDerived,
  isManualProvenance,
  productSwitchReplacesDerived,
  type ValuationProvenance,
} from "@/lib/slabs/valuation-provenance";
import { buildPricingPersist, type SlabPricingWrite } from "@/lib/slabs/pricing-tiers";
import {
  persistRequiredConfirmation,
  saveSlab,
  validateSlabInput,
  verifiedBlockers,
  type SaveWarning,
  type SlabDataAccess,
  type SaveMode,
} from "@/lib/slabs/save-slab";
import { supabaseSlabDataAccess } from "@/lib/slabs/data";
import type { Slab, SlabInput } from "@/lib/slabs/types";

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
  confidence: "",
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
  const [visual, setVisual] = useState<{ product_id: string; status: "user_confirmed" | "user_rejected"; imageUrl: string | null; imageSource: ImageSource } | null>(null);
  // §2 A visually-rejected candidate is remembered (even after its link is cleared)
  // so the rejection — with its structured reason — is written to the audit trail on save.
  const [rejected, setRejected] = useState<{ product_id: string; imageUrl: string | null; imageSource: ImageSource; reason: string; note: string } | null>(null);
  const [dup, setDup] = useState<{ id: string; inventory_number: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveWarnings, setSaveWarnings] = useState<SaveWarning[]>([]);
  const [saveRecovery, setSaveRecovery] = useState<{
    slab: Slab;
    mode: SaveMode;
    pricingWrite: SlabPricingWrite | null;
    confirmation: PricechartingConfirmation | null;
    warnings: SaveWarning[];
    confirmationError: string | null;
  } | null>(null);
  const [cleanupRecovery, setCleanupRecovery] = useState<{ slabId: string; paths: string[] } | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Valuation provenance is independent from source availability/confidence.
  const [valProvenance, setValProvenance] = useState<ValuationProvenance>("tier_unavailable");
  const [valStale, setValStale] = useState(false); // manual valuation kept but possibly stale
  const [pcStale, setPcStale] = useState(false); // confirmed link staled by an identity edit
  // Read the current provenance inside the identity-change effect without making
  // that effect depend on (and re-run for) every provenance change.
  const provenanceRef = useRef(valProvenance);
  provenanceRef.current = valProvenance;

  const NUMERIC_VAL_FIELDS: ReadonlyArray<keyof typeof EMPTY_VALUATION> = ["final", "quick", "replacement", "guide"];
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
  const setValField = (k: keyof typeof EMPTY_VALUATION, v: string) => {
    if (NUMERIC_VAL_FIELDS.includes(k)) {
      const next = { ...val, [k]: v };
      const provenance: ValuationProvenance = next.guide.trim()
        ? "manual_guide"
        : [next.final, next.quick, next.replacement].some((value) => value.trim())
          ? "manual_value"
          : "tier_unavailable";
      setVal({ ...next, confidence: provenance === "tier_unavailable" ? "" : "manual" });
      setValProvenance(provenance);
      setValStale(false);
      return;
    }
    setVal((s) => ({ ...s, [k]: v }));
  };

  // Evaluate pricing off the PriceCharting Guide Value the operator entered.
  // A typed guide is explicitly manual and fills the reproducible ratios.
  const applyGuideValuation = () => {
    const guideCents = dollarsToCents(val.guide);
    if (guideCents === null) {
      toast.error("Enter the PriceCharting Guide Value first.");
      return;
    }
    const derived = deriveValuation({
      guide_cents: guideCents,
      confidence_score: pc?.confidence_score ?? null,
      provenance: "manual_guide",
    });
    setVal((s) => ({
      ...s,
      final: centsToInputString(derived.suggested_final_cents),
      quick: centsToInputString(derived.quick_sale_cents),
      replacement: centsToInputString(derived.replacement_cents),
      confidence: derived.confidence ?? "",
      notes: derived.method,
    }));
    // The figures are now formula-derived from the guide value.
    setValProvenance("manual_guide");
    setValStale(false);
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

  // A material identity change stales any prior PriceCharting confirmation and its
  // AUTO-derived valuation. §1E: clear ONLY source/formula-derived figures; keep a
  // manual valuation but flag it as possibly stale. The confirmed link is kept but
  // marked stale so the confirmed-id-first flow can re-validate it — never silently
  // dropped, never silently trusted.
  useEffect(() => {
    setVisual(null);
    setRejected(null); // a rejection is tied to the identity it was made against
    setPcStale(true); // only surfaced while a confirmed product is linked
    const action = identityChangeAction(provenanceRef.current);
    if (action.warnManualStale) setValStale(true); // preserve manual figures, warn
    if (action.clearAutoValuation) {
      setVal((s) => ({ ...s, guide: "", final: "", quick: "", replacement: "", confidence: "", notes: "" }));
      setValProvenance("tier_unavailable");
      setValStale(false);
    }
  }, [id.card_name, id.set_name, id.card_number, id.year, id.language, id.variation, id.grader, id.grade, id.grade_label]);

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
      valuation_provenance: valProvenance,
      price_variance_percent: variance,
      grader: id.grader,
      grade: id.grade,
      grade_label: id.grade_label,
      product_name: pc?.product_name ?? null,
      product_id: pc?.product_id ?? null,
      // Only a confirmed product whose value came from the slab's exact designation
      // tier may render as an Exact Match; otherwise the model stays Compatible.
      designation_exact: pc?.designation_exact ?? false,
      available_values_cents: pc?.available_values_cents ?? null,
    });
  }, [pc, val.final, val.guide, val.quick, val.replacement, val.confidence, valProvenance, variance, id.grader, id.grade, id.grade_label]);

  // Reject the linked product: unlink and clear the values it drove, so a
  // rejected product never persists as confirmed or drives the graded Final Value.
  const rejectPc = () => {
    setPc(null);
    setVisual(null);
    setPcStale(false);
    setVal((s) => ({
      ...s,
      guide: "",
      final: "",
      quick: "",
      replacement: "",
      confidence: "",
      notes: "",
    }));
    setValProvenance("tier_unavailable");
    setValStale(false);
    toast.info("Product unlinked (visually rejected). Its values were cleared.");
  };

  const onSelectPc = (sel: SelectedPriceCharting) => {
    setPc(sel);
    // Auto-derive Quick-Sale / Replacement / Confidence from the CONFIRMED guide
    // value using the documented ratios — never leave confidence on "Manual" when
    // the numbers actually came from PriceCharting. A guide value returned at the
    // slab's own grade is the exact tier; Verified still requires visual confirmation.
    // §4/§5: only treat this as the EXACT designation tier when the server
    // confirmed the returned tier represents the slab's grade+designation. A
    // Pristine slab valued from the ordinary CGC 10 tier is a COMPATIBLE tier,
    // never a "Verified exact Pristine".
    const sourceProvenance: ValuationProvenance = sel.value_cents === null
      ? "tier_unavailable"
      : sel.is_estimate
        ? "pricecharting_estimate"
        : sel.designation_exact
          ? "pricecharting_exact_tier"
          : "pricecharting_compatible_tier";
    const derived = deriveValuation({
      guide_cents: sel.value_cents,
      confidence_score: sel.confidence_score,
      is_estimate: sel.is_estimate,
      field_meaning: sel.selected_tier_label ?? sel.grade_field,
      provenance: sourceProvenance,
      identity_confirmed: true,
      visual_confirmed: visual?.product_id === sel.product_id && visual.status === "user_confirmed",
    });
    // §1E: switching products REPLACES the previous product's auto-derived
    // valuation, but a MANUAL valuation the operator typed is never clobbered.
    const priorWasDerived = productSwitchReplacesDerived(valProvenance);
    setVal((s) => ({
      ...s,
      guide: centsToInputString(sel.value_cents),
      final: priorWasDerived || !s.final ? centsToInputString(derived.suggested_final_cents) : s.final,
      quick: priorWasDerived || !s.quick ? centsToInputString(derived.quick_sale_cents) : s.quick,
      replacement: priorWasDerived || !s.replacement ? centsToInputString(derived.replacement_cents) : s.replacement,
      confidence: priorWasDerived || !s.confidence || s.confidence === "manual" ? (derived.confidence ?? "") : s.confidence,
      notes: priorWasDerived || !s.notes ? derived.method : s.notes,
    }));
    // Values now come from a confirmed PriceCharting product.
    if (priorWasDerived || !hasManualFigures()) setValProvenance(sourceProvenance);
    setValStale(false);
    setPcStale(false);
    setRejected(null); // selecting a product supersedes any prior rejection
  };

  // True when any money figure is currently populated (used to decide whether a
  // fresh product selection may overwrite the figures or must preserve them).
  const hasManualFigures = () =>
    val.final.trim() !== "" || val.quick.trim() !== "" || val.replacement.trim() !== "";

  const buildInput = (mode: SaveMode): SlabInput => ({
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
    // The save action drives the stored verification state: a verified record is
    // "verified"; a draft is "unverified" so its unresolved requirements display.
    verification_status: mode === "verified" ? "verified" : "unverified",
    final_value_cents: dollarsToCents(val.final),
    quick_sale_value_cents: dollarsToCents(val.quick),
    replacement_value_cents: dollarsToCents(val.replacement),
    valuation_confidence: val.confidence || null,
    valuation_provenance: valProvenance,
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

  // §2 Build the confirmation/rejection record persisted on save. A confirmed
  // product records its (auto or user) visual state; a rejected candidate records
  // the rejection + structured reason so it lands in the append-only audit trail.
  const buildConfirmationRecord = (): PricechartingConfirmation | null => {
    if (pc) {
      const reviewed = visual && visual.product_id === pc.product_id;
      const source =
        pc.match_status === "manual_product_id" || pc.match_status === "manual_product_url"
          ? pc.match_status
          : "search_manual";
      return {
        product_id: pc.product_id,
        candidate_image_url: reviewed ? visual!.imageUrl : null,
        candidate_image_source: reviewed ? visual!.imageSource : "none",
        candidate_image_type: "marketplace_offer_image",
        candidate_image_available: reviewed ? !!visual!.imageUrl : false,
        visual_confirmation_status: reviewed ? visual!.status : "metadata_auto_confirmed",
        visual_confirmation_method: reviewed ? "side_by_side" : null,
        visual_rejection_reason: null,
        visual_rejection_note: null,
        product_confirmation_source: source,
        scoring_version: SCORING_VERSION,
      };
    }
    if (rejected) {
      return {
        product_id: rejected.product_id,
        candidate_image_url: rejected.imageUrl,
        candidate_image_source: rejected.imageSource,
        candidate_image_type: "marketplace_offer_image",
        candidate_image_available: !!rejected.imageUrl,
        visual_confirmation_status: "user_rejected",
        visual_confirmation_method: "side_by_side",
        visual_rejection_reason: rejected.reason,
        visual_rejection_note: rejected.note.trim() || null,
        product_confirmation_source: null,
        scoring_version: SCORING_VERSION,
      };
    }
    return null;
  };

  // §3 Save-action gating. A DRAFT needs only a front image (and no duplicate
  // cert); a VERIFIED record needs the full identity plus all blockers resolved.
  const verifiedMissing = verifiedBlockers(buildInput("verified"), !!front);
  const verifyBlockers = [
    ...(verifiedMissing.length ? [`missing ${verifiedMissing.join(", ").toLowerCase()}`] : []),
    ...(dup ? [`a duplicate certification (Inventory #${dup.inventory_number})`] : []),
    ...(pc && pcStale ? ["an unresolved (stale) PriceCharting link — re-check it"] : []),
  ];
  const canVerify = verifyBlockers.length === 0 && !saving && !saveRecovery;
  const draftBlockers = [
    ...(!front ? ["a front image"] : []),
    ...(dup ? [`a duplicate certification (Inventory #${dup.inventory_number})`] : []),
  ];
  const canDraft = draftBlockers.length === 0 && !saving && !saveRecovery;

  const retrySavedRecord = async () => {
    if (!saveRecovery) return;
    setSaving(true);
    try {
      let warnings = [...saveRecovery.warnings];
      if (saveRecovery.pricingWrite && dao.applySlabPricing && warnings.some((w) => w.code.startsWith("pricing_"))) {
        try {
          const applied = await dao.applySlabPricing(saveRecovery.slab.id, saveRecovery.pricingWrite);
          if (applied) warnings = warnings.filter((w) => !w.code.startsWith("pricing_"));
        } catch (error) {
          warnings = warnings.map((w) => w.code.startsWith("pricing_")
            ? { ...w, message: error instanceof Error ? error.message : "Pricing persistence retry failed." }
            : w);
        }
      }
      let confirmationError = saveRecovery.confirmationError;
      if (saveRecovery.confirmation && confirmationError) {
        const confirmationResult = await persistRequiredConfirmation(
          saveRecovery.slab.id,
          saveRecovery.confirmation,
          recordPricechartingConfirmation,
        );
        confirmationError = confirmationResult.status === "error" ? confirmationResult.message : null;
      }
      if (warnings.length === 0 && confirmationError === null) {
        toast.success(`Saved Inventory #${saveRecovery.slab.inventory_number} with all required writes.`);
        navigate(`/slabs/${saveRecovery.slab.id}`);
        return;
      }
      setSaveRecovery({ ...saveRecovery, warnings, confirmationError });
    } finally {
      setSaving(false);
    }
  };

  const retryCleanup = async () => {
    if (!cleanupRecovery) return;
    setSaving(true);
    const warnings: SaveWarning[] = [];
    try {
      if (cleanupRecovery.paths.length > 0) await dao.deleteImages(cleanupRecovery.paths);
    } catch (error) {
      warnings.push({
        code: "image_cleanup_failed",
        message: error instanceof Error ? error.message : "Image cleanup retry failed.",
        retryable: true,
        orphaned_paths: cleanupRecovery.paths,
      });
    }
    try {
      await dao.deleteSlabRow(cleanupRecovery.slabId);
    } catch (error) {
      warnings.push({
        code: "row_cleanup_failed",
        message: error instanceof Error ? error.message : "Slab-row cleanup retry failed.",
        retryable: true,
      });
    }
    setSaveWarnings(warnings);
    if (warnings.length === 0) {
      setCleanupRecovery(null);
      toast.success("Incomplete save cleanup completed.");
    }
    setSaving(false);
  };

  const handleSave = async (mode: SaveMode) => {
    if (dup) {
      toast.error(`Certification already exists as Inventory #${dup.inventory_number}. Open that record instead.`);
      return;
    }
    const input = buildInput(mode);
    const problems = validateSlabInput(input, !!front, !!back, mode);
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
    setSaveWarnings([]);
    setCleanupRecovery(null);
    try {
      const result = await saveSlab(
        input,
        front ? { blob: front.file, ext: front.ext } : null,
        back ? { blob: back.file, ext: back.ext } : null,
        dao,
        pricingWrite,
        mode,
      );
      if (result.status === "success") {
        // §2 persist confirmation/rejection state + append-only audit event via the
        // ONE transactional RPC. Errors are surfaced (never swallowed) and retried
        // for transient failures; the slab itself is already saved.
        const confirmation = buildConfirmationRecord();
        const confirmationResult = confirmation
          ? await persistRequiredConfirmation(result.slab.id, confirmation, recordPricechartingConfirmation)
          : { status: "success" as const, attempts: 0 };
        const confirmationError = confirmationResult.status === "error" ? confirmationResult.message : null;
        if (result.warnings.length > 0 || confirmationError) {
          setSaveRecovery({
            slab: result.slab,
            mode,
            pricingWrite,
            confirmation,
            warnings: result.warnings,
            confirmationError,
          });
          toast.warning(`Inventory #${result.slab.inventory_number} was created but still needs a retryable follow-up write.`);
          return;
        }
        toast.success(
          mode === "verified"
            ? `Saved verified record as Inventory #${result.slab.inventory_number}`
            : `Saved draft as Inventory #${result.slab.inventory_number} — complete it later to verify`,
        );
        navigate(`/slabs/${result.slab.id}`);
      } else if (result.status === "duplicate") {
        toast.error(`Duplicate certification — already Inventory #${result.existing_inventory_number}.`);
        setDup({ id: "", inventory_number: result.existing_inventory_number });
      } else if (result.status === "validation_error") {
        toast.error(result.errors[0]);
      } else {
        setSaveWarnings(result.warnings);
        if (result.slab_id && result.warnings.some((warning) => warning.code.endsWith("cleanup_failed"))) {
          setCleanupRecovery({
            slabId: result.slab_id,
            paths: result.warnings.flatMap((warning) => warning.orphaned_paths ?? []),
          });
        }
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
    grade_label: id.grade_label, // §2: designation reaches PriceCharting tier selection
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

      {(saveWarnings.length > 0 || saveRecovery || cleanupRecovery) && (
        <div className="mb-6 space-y-2 rounded-md border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Save requires follow-up.</p>
              {saveRecovery?.confirmationError && <p>Confirmation/audit write: {saveRecovery.confirmationError}</p>}
              {[...(saveRecovery?.warnings ?? []), ...saveWarnings].map((warning, index) => (
                <p key={`${warning.code}-${index}`}>
                  {warning.message}
                  {warning.orphaned_paths?.length ? ` Orphaned paths: ${warning.orphaned_paths.join(", ")}.` : ""}
                </p>
              ))}
            </div>
          </div>
          {saveRecovery && (
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={retrySavedRecord} disabled={saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Retry required writes
              </Button>
              {saveRecovery.mode === "draft" && (
                <Button type="button" size="sm" variant="outline" asChild>
                  <Link to={`/slabs/${saveRecovery.slab.id}`}>Open saved draft</Link>
                </Button>
              )}
            </div>
          )}
          {cleanupRecovery && (
            <Button type="button" size="sm" onClick={retryCleanup} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Retry cleanup
            </Button>
          )}
        </div>
      )}

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
            {pc && pcStale && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                The identity changed after this product was confirmed, so the link is now stale. Use
                “Re-check confirmed” to re-validate it against the current identity, or “Search again” to relink.
              </div>
            )}
            <PriceChartingPanel
              identity={identity}
              selectedProductId={pc?.product_id ?? null}
              onSelect={onSelectPc}
              frontImageUrl={front?.previewUrl ?? null}
              onVisualStatus={(product_id, status, imageUrl, imageSource, rejectionReason, rejectionNote) => {
                if (status === "user_rejected") {
                  setVisual(null);
                  setRejected({ product_id, imageUrl, imageSource, reason: rejectionReason ?? "other", note: rejectionNote ?? "" });
                } else {
                  setRejected(null);
                  setVisual({ product_id, status, imageUrl, imageSource });
                  if (pc?.product_id === product_id && isAutoDerived(valProvenance)) {
                    const recalculated = deriveValuation({
                      guide_cents: dollarsToCents(val.guide),
                      confidence_score: pc.confidence_score,
                      is_estimate: pc.is_estimate,
                      field_meaning: pc.selected_tier_label ?? pc.grade_field,
                      provenance: valProvenance,
                      identity_confirmed: true,
                      visual_confirmed: true,
                    });
                    setVal((current) => ({ ...current, confidence: recalculated.confidence ?? "" }));
                  }
                }
              }}
              onReject={rejectPc}
            />
          </CardContent>
        </Card>

        {/* Valuation */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Valuation</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {valStale && isManualProvenance(valProvenance) && hasManualFigures() && (
              <div className="col-span-2 flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 text-sm text-amber-800 sm:col-span-4">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                The identity changed after you entered this valuation manually. Your figures were kept, but they may no
                longer match the card — re-check them.
              </div>
            )}
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
              <Input value={val.confidence || "Unavailable"} readOnly />
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

      {/* §3 Two save actions, each with its exact disabled reason shown beside it. */}
      <div className="mt-6 flex flex-col items-end gap-2">
        <div className="flex justify-end gap-3">
          <Button variant="outline" asChild>
            <Link to="/slabs">Cancel</Link>
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleSave("draft")}
            disabled={!canDraft}
            title={canDraft ? "Save an unverified draft you can complete later" : `Needs ${draftBlockers.join(" and ")}`}
          >
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            Save as unverified draft
          </Button>
          <Button
            onClick={() => handleSave("verified")}
            disabled={!canVerify}
            title={canVerify ? "Save a fully verified record" : `Can't verify yet: ${verifyBlockers.join("; ")}`}
          >
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            Save verified record
          </Button>
        </div>
        {/* Exact, always-visible disabled reasons (not just tooltips). */}
        <div className="text-right text-xs text-muted-foreground">
          {!canDraft && <p>Draft needs {draftBlockers.join(" and ")}.</p>}
          {canDraft && !canVerify && <p>To verify: resolve {verifyBlockers.join("; ")}.</p>}
          {canVerify && <p>Ready to save a verified record.</p>}
        </div>
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
