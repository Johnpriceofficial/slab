/**
 * Displays the PROPOSED identity fields returned by the analyze-slab function.
 * Nothing here writes to the database or the form automatically — the operator
 * clicks Apply (per field or all readable) to populate the still-editable form.
 * Confidence, source, unreadable flags, and label/card mismatch are all shown.
 */

import { AlertTriangle, Check, CheckCircle2, ImageDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ANALYZE_FIELD_KEYS, type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";
import { assessFrontImageSufficiency } from "@/lib/slabs/image-sufficiency";

const FIELD_LABELS: Record<AnalyzeFieldKey, string> = {
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

export interface SlabAnalysisPanelProps {
  result: AnalyzeResult;
  /** Whether a back image was part of this analysis — tunes the recapture advice. */
  backProvided?: boolean;
  onApplyField: (key: AnalyzeFieldKey, value: string) => void;
  onApplyAll: (values: Partial<Record<AnalyzeFieldKey, string>>) => void;
}

/** A readable field below this confidence is surfaced for extra scrutiny. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

const CERT_UNREADABLE_MESSAGE =
  "Certification number is present but not readable with confidence. " +
  "Upload a sharper front image, upload the back image, or enter it manually.";

const SUFFICIENCY_STYLE = {
  sufficient: { border: "border-emerald-500/40", bg: "bg-emerald-500/5", text: "text-emerald-700", Icon: CheckCircle2 },
  sufficient_with_warnings: { border: "border-amber-500/40", bg: "bg-amber-500/5", text: "text-amber-700", Icon: ImageDown },
  insufficient: { border: "border-destructive/40", bg: "bg-destructive/5", text: "text-destructive", Icon: AlertTriangle },
} as const;

export function SlabAnalysisPanel({ result, backProvided, onApplyField, onApplyAll }: SlabAnalysisPanelProps) {
  const readableKeys = ANALYZE_FIELD_KEYS.filter((k) => result.proposed[k].readable);
  const sufficiency = assessFrontImageSufficiency(result, { backProvided });
  const suffStyle = SUFFICIENCY_STYLE[sufficiency.level];
  // The certification number is uniquely never-guessed: when it can't be read,
  // give the operator the exact, actionable next steps rather than a bare flag.
  const certUnreadable = !result.proposed.certification_number.readable;

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
          <span className="font-medium">Proposed identity — review before saving</span>
          <Badge variant="outline">{Math.round(result.overall_confidence * 100)}% overall</Badge>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={applyAll} disabled={readableKeys.length === 0}>
          <Check className="mr-1 h-4 w-4" /> Apply all readable
        </Button>
      </div>

      {/* Front-image sufficiency — is the front enough, or is the back needed? */}
      <div className={`flex items-start gap-2 rounded-md border ${suffStyle.border} ${suffStyle.bg} p-2 text-sm ${suffStyle.text}`}>
        <suffStyle.Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{sufficiency.message}</span>
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
        These are AI-proposed values, not confirmed data. Apply them, then verify and correct every field before
        running PriceCharting or saving.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {ANALYZE_FIELD_KEYS.map((key) => {
          const f = result.proposed[key];
          return (
            <div key={key} className="flex items-center justify-between gap-2 rounded border bg-background px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{FIELD_LABELS[key]}</p>
                {f.readable ? (
                  <p className="truncate font-medium">{f.value}</p>
                ) : (
                  <p className="italic text-muted-foreground">Unreadable — enter manually</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {f.readable && (
                  <>
                    <Badge
                      variant={f.confidence < LOW_CONFIDENCE_THRESHOLD ? "destructive" : "outline"}
                      className="text-[10px]"
                      title={f.confidence < LOW_CONFIDENCE_THRESHOLD ? "Low confidence — verify this field against the photo" : undefined}
                    >
                      {Math.round(f.confidence * 100)}% · {f.source}
                    </Badge>
                    <Button type="button" size="sm" variant="ghost" onClick={() => onApplyField(key, f.value as string)}>
                      Apply
                    </Button>
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
