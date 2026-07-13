export const CARD_SCAN_SCHEMA_VERSION = "card-scan-1.0";
export const AUTO_ACCEPT_CONFIDENCE = 0.75;

export interface CardConditionIssues {
  whitening: string;
  scratches: string;
  centering_notes: string;
  other: string;
}

export interface CardScanExtraction {
  card_name: string;
  set_name: string;
  card_number: string;
  rarity: string;
  condition_issues: CardConditionIssues;
  confidence: number;
}

export type ScanDecision = "auto_add" | "needs_review" | "possible_duplicate";

export function classifyCardScan(confidence: number, duplicateCount: number): ScanDecision {
  if (confidence < AUTO_ACCEPT_CONFIDENCE) return "needs_review";
  if (duplicateCount > 0) return "possible_duplicate";
  return "auto_add";
}

export function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeCardNumber(value: string): string {
  return normalizeIdentity(value).replace(/[^a-z0-9/]+/g, "");
}

export function isCardScanExtraction(value: unknown): value is CardScanExtraction {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const issues = row.condition_issues as Record<string, unknown> | null;
  return (
    typeof row.card_name === "string" &&
    typeof row.set_name === "string" &&
    typeof row.card_number === "string" &&
    typeof row.rarity === "string" &&
    typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1 &&
    !!issues &&
    typeof issues.whitening === "string" &&
    typeof issues.scratches === "string" &&
    typeof issues.centering_notes === "string" &&
    typeof issues.other === "string"
  );
}

export function conditionNotes(issues: CardConditionIssues): string {
  return [
    issues.whitening && `Whitening: ${issues.whitening}`,
    issues.scratches && `Scratches: ${issues.scratches}`,
    issues.centering_notes && `Centering: ${issues.centering_notes}`,
    issues.other && `Other: ${issues.other}`,
  ].filter(Boolean).join("; ");
}
