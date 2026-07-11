/**
 * Displays the PROPOSED identity fields returned by the analyze-slab function.
 * Nothing here writes to the database or the form automatically — the operator
 * clicks Apply (per field or all readable) to populate the still-editable form.
 * Confidence, source, unreadable flags, and label/card mismatch are all shown.
 */

import { AlertTriangle, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ANALYZE_FIELD_KEYS, type AnalyzeFieldKey, type AnalyzeResult } from "@/server/analyze-slab/handler";

const FIELD_LABELS: Record<AnalyzeFieldKey, string> = {
  card_name: "Card Name",
  set: "Set",
  card_number: "Card #",
  year: "Year",
  language: "Language",
  rarity: "Rarity",
  variation: "Variation",
  grader: "Grader",
  grade: "Grade",
  certification_number: "Certification #",
  label_description: "Label Description",
};

export interface SlabAnalysisPanelProps {
  result: AnalyzeResult;
  onApplyField: (key: AnalyzeFieldKey, value: string) => void;
  onApplyAll: (values: Partial<Record<AnalyzeFieldKey, string>>) => void;
}

export function SlabAnalysisPanel({ result, onApplyField, onApplyAll }: SlabAnalysisPanelProps) {
  const readableKeys = ANALYZE_FIELD_KEYS.filter((k) => result.proposed[k].readable);

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
                    <Badge variant="outline" className="text-[10px]">
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
