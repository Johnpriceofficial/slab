/**
 * Displays analyze-slab identity evidence plus the intake automation summary.
 *
 * Safe, high-confidence values may already have been promoted into the canonical
 * form by NewSlab. The per-field Apply controls remain as a recovery path for
 * fields the automation deliberately left for review.
 */

import { AlertTriangle, Check, CheckCircle2, ImageDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ANALYZE_FIELD_KEYS, type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";
import { assessFrontImageSufficiency } from "@/lib/slabs/image-sufficiency";

const ANALYSIS_FIELD_LABELS: Record<AnalyzeFieldKey, string> = {
  card_name: "Card Name",
  set: "Set",
  card_number: "Card #",
  year: "Year",
  language: "Language",
  rarity: "Rarity",
  finish: "Finish",
  variation: "Variation",
  grader: "Grader",
  grade: "Grade",
  grade_label: "Grade Label",
  certification_number: "Certification #",
  label_description: "Label Description",
};

export interface AnalysisAutomationSummary {
  automaticallyPopulated: string[];
  requiringReview: string[];
  unresolvedCanonicalFields: string[];
  certificationStatus: string;
  priceChartingProduct: string;
  selectedValuationTier: string;
  guideValue: string;
  verificationLevel: string;
}

export interface SlabAnalysisPanelProps {
  result: AnalyzeResult;
  backProvided?: boolean;
  automation?: AnalysisAutomationSummary;
  onApplyField: (key: AnalyzeFieldKey, value: string) => void;
  onApplyAll: (values: Partial<Record<AnalyzeFieldKey, string>>) => void;
}

const LOW_CONFIDENCE_THRESHOLD = 0.7;
const CERT_UNREADABLE_MESSAGE =
  "Certification number was not readable with confidence. Retake a sharper, glare-free front-label image or enter it manually. An optional back image may provide supplemental evidence, but is not required to continue.";

const SUFFICIENCY_STYLE = {
  sufficient: { border: "border-emerald-500/40", bg: "bg-emerald-500/5", text: "text-emerald-700", Icon: CheckCircle2 },
  sufficient_with_warnings: { border: "border-amber-500/40", bg: "bg-amber-500/5", text: "text-amber-700", Icon: ImageDown },
  insufficient: { border: "border-destructive/40", bg: "bg-destructive/5", text: "text-destructive", Icon: AlertTriangle },
} as const;

function fallbackCertificationStatus(result: AnalyzeResult): string {
  const grader = result.proposed.grader.value?.trim() || "this grader";
  if (!result.proposed.certification_number.readable) {
    return "Needs review — certification number was not readable with confidence.";
  }
  return `Visually extracted for ${grader}. Certification database verification is not configured for this grader.`;
}

function listText(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

export function SlabAnalysisPanel({ result, backProvided, automation, onApplyField, onApplyAll }: SlabAnalysisPanelProps) {
  const readableKeys = ANALYZE_FIELD_KEYS.filter((k) => result.proposed[k].readable);
  const sufficiency = assessFrontImageSufficiency(result, { backProvided });
  const suffStyle = SUFFICIENCY_STYLE[sufficiency.level];
  const certUnreadable = !result.proposed.certification_number.readable;
  const certificationStatus = automation?.certificationStatus ?? fallbackCertificationStatus(result);

  const applyAll = () => {
    const values: Partial<Record<AnalyzeFieldKey, string>> = {};
    for (const k of readableKeys) {
      const v = result.proposed[k].value;
      if (v !== null) values[k] = v;
    }
    onApplyAll(values);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-medium">Analysis automation summary</span>
          <Badge variant="outline">{Math.round(result.overall_confidence * 100)}% overall</Badge>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={applyAll} disabled={readableKeys.length === 0}>
          <Check className="mr-1 h-4 w-4" /> Apply all readable
        </Button>
      </div>

      <div className={`flex items-start gap-2 rounded-md border ${suffStyle.border} ${suffStyle.bg} p-2 text-sm ${suffStyle.text}`}>
        <suffStyle.Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{sufficiency.message}</span>
      </div>

      <div className="grid gap-2 rounded-md border bg-background p-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Automatically populated</p>
          <p>{listText(automation?.automaticallyPopulated ?? [])}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Requires review</p>
          <p>{listText(automation?.requiringReview ?? [])}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Certification status</p>
          <p>{certificationStatus}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Verification level</p>
          <p>{automation?.verificationLevel ?? "Visually verified evidence only — official certification lookup not configured."}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Exact PriceCharting product</p>
          <p>{automation?.priceChartingProduct ?? "Not linked yet"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Selected valuation tier</p>
          <p>{automation?.selectedValuationTier ?? "Not selected yet"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Guide value</p>
          <p>{automation?.guideValue ?? "Not resolved yet"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Missing from canonical form</p>
          <p>{listText(automation?.unresolvedCanonicalFields ?? [])}</p>
        </div>
      </div>

      {certUnreadable && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{CERT_UNREADABLE_MESSAGE}</span>
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
          {result.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2 text-amber-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        These are AI-proposed readings. Auto-populated fields came from high-confidence evidence; review fields remain manual until the operator resolves them.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {ANALYZE_FIELD_KEYS.map((key) => {
          const f = result.proposed[key];
          return (
            <div key={key} className="flex items-center justify-between gap-2 rounded border bg-background px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{ANALYSIS_FIELD_LABELS[key]}</p>
                {f.readable ? <p className="truncate font-medium">{f.value}</p> : <p className="italic text-muted-foreground">Unreadable — enter manually</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {f.readable && (
                  <>
                    <Badge variant={f.confidence < LOW_CONFIDENCE_THRESHOLD ? "destructive" : "outline"} className="text-[10px]" title={f.confidence < LOW_CONFIDENCE_THRESHOLD ? "Low confidence — verify this field against the photo" : undefined}>
                      {Math.round(f.confidence * 100)}% · {f.source}
                    </Badge>
                    <Button type="button" size="sm" variant="ghost" onClick={() => onApplyField(key, f.value as string)}>Apply</Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
