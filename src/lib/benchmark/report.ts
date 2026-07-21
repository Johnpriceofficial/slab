/**
 * Report builders. Each returns a string or plain object; the CLI writes them to
 * disk. Pure so report generation is unit tested without a filesystem.
 */

import { allBreakdowns, type BenchmarkMetrics, type BreakdownRow } from "./metrics";
import { COMPARED_FIELDS, type BreakdownKey, type SampleResult } from "./types";

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Array<Array<unknown>>): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export interface BenchmarkReport {
  generated_at: string;
  metrics: BenchmarkMetrics;
  breakdowns: Record<BreakdownKey, BreakdownRow[]>;
}

export function buildReport(results: SampleResult[], metrics: BenchmarkMetrics, generatedAt: string): BenchmarkReport {
  return { generated_at: generatedAt, metrics, breakdowns: allBreakdowns(results) };
}

export function buildSummaryJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Worst categories across all breakdowns, ranked by manual-review rate. */
function worstCategories(report: BenchmarkReport, limit = 8): BreakdownRow[] {
  return Object.values(report.breakdowns)
    .flat()
    .filter((row) => row.samples > 0)
    .sort((a, b) => b.manual_review_rate - a.manual_review_rate || b.certification_confidently_incorrect - a.certification_confidently_incorrect)
    .slice(0, limit);
}

export function buildSummaryMarkdown(report: BenchmarkReport): string {
  const m = report.metrics;
  const tr = m.threshold_results;
  const t = m.thresholds;
  const mark = (ok: boolean) => (ok ? "✅" : "❌");
  const lines: string[] = [];

  lines.push(`# analyze-slab benchmark`, "");
  lines.push(`Generated: ${report.generated_at}`, `Samples: ${m.total_samples}`, "");
  lines.push(`## Result: ${m.passed ? "PASS ✅" : "FAIL ❌"}`, "");

  lines.push("| Gate | Value | Threshold | Pass |", "| --- | ---: | ---: | :---: |");
  lines.push(`| Card identity accuracy | ${pct(m.card_identity_accuracy)} | ≥ ${pct(t.card_identity_accuracy)} | ${mark(tr.card_identity_accuracy)} |`);
  lines.push(`| Grade accuracy | ${pct(m.grade_accuracy)} | ≥ ${pct(t.grade_accuracy)} | ${mark(tr.grade_accuracy)} |`);
  lines.push(`| Certification accuracy | ${pct(m.certification_accuracy)} | ≥ ${pct(t.certification_accuracy)} | ${mark(tr.certification_accuracy)} |`);
  lines.push(`| Confidently wrong certs | ${m.certification.confidently_incorrect} | ≤ ${t.max_confident_wrong_certs} | ${mark(tr.confident_wrong_certs)} |`);
  lines.push(`| Manual review rate | ${pct(m.manual_review_rate)} | ≤ ${pct(t.manual_review_rate)} | ${mark(tr.manual_review_rate)} |`);
  if (m.product_match) {
    lines.push(`| PriceCharting match accuracy | ${pct(m.product_match.accuracy)} | ≥ ${pct(t.product_match_accuracy)} | ${mark(tr.product_match_accuracy)} |`);
    lines.push(`| Confidently wrong matches | ${m.product_match.false_confident} | ≤ ${t.max_confident_wrong_matches} | ${mark(tr.confident_wrong_matches)} |`);
  }
  lines.push("");

  if (m.product_match) {
    const pm = m.product_match;
    lines.push("## PriceCharting product match", "");
    lines.push(`- Judgeable samples (truth id known): ${pm.judgeable}`);
    lines.push(`- Correct: ${pm.correct}  (${pct(pm.accuracy)})`);
    lines.push(`- Confirmed matches: ${pm.confirmed}`);
    lines.push(`- **Confidently wrong (confirmed a wrong product): ${pm.false_confident}  (${pct(pm.false_confident_rate)} of confirmed)**`);
    lines.push(`- Abstained to manual review: ${pm.abstained}  (${pct(pm.abstention_rate)})`, "");
  } else {
    lines.push("## PriceCharting product match", "", "- Not measured (no sample carried a truth `pricecharting_product_id`).", "");
  }

  lines.push("## Certification safety", "");
  lines.push(`- Correct: ${m.certification.correct}`);
  lines.push(`- Blank / unreadable (safe): ${m.certification.blank_unreadable}`);
  lines.push(`- Incorrect (below acceptance): ${m.certification.incorrect}`);
  lines.push(`- **Confidently incorrect (hard fail): ${m.certification.confidently_incorrect}**`, "");

  lines.push("## Field accuracy", "", "| Field | Accuracy | Evaluable |", "| --- | ---: | ---: |");
  for (const field of COMPARED_FIELDS) {
    const fa = m.field_accuracy[field];
    lines.push(`| ${field} | ${pct(fa.accuracy)} | ${fa.evaluable} |`);
  }
  lines.push("");

  lines.push(
    "## Signals",
    "",
    `- Average field confidence: ${pct(m.average_field_confidence)}`,
    `- Unreadable field rate: ${pct(m.unreadable_field_rate)}`,
    `- False-confidence rate: ${pct(m.false_confidence_rate)}`,
    `- Latency median / p95: ${m.latency_ms.median ?? "n/a"} ms / ${m.latency_ms.p95 ?? "n/a"} ms`,
    "",
  );

  const worst = worstCategories(report);
  if (worst.length > 0) {
    lines.push("## Worst-performing categories", "", "| Category | Group | Samples | Identity | Manual review | Confident cert errors |", "| --- | --- | ---: | ---: | ---: | ---: |");
    for (const row of worst) {
      lines.push(`| ${row.key} | ${row.group} | ${row.samples} | ${pct(row.card_identity_accuracy)} | ${pct(row.manual_review_rate)} | ${row.certification_confidently_incorrect} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function buildPerSampleCsv(results: SampleResult[]): string {
  const header = [
    "sample_id",
    "status",
    "model",
    "request_id",
    "latency_ms",
    "identity_correct",
    "grade_correct",
    "certification_class",
    "needs_manual_review",
    "unreadable_count",
    ...COMPARED_FIELDS.flatMap((f) => [`${f}__predicted`, `${f}__truth`, `${f}__match`, `${f}__confidence`]),
  ];
  const rows = results.map((r) => [
    r.sample_id,
    r.status,
    r.model,
    r.request_id,
    r.latency_ms,
    r.identity_correct,
    r.grade_correct,
    r.certification_class,
    r.needs_manual_review,
    r.unreadable_count,
    ...COMPARED_FIELDS.flatMap((f) => {
      const o = r.fields[f];
      return [o.predicted, o.truth, o.evaluable ? o.match : "n/a", o.confidence];
    }),
  ]);
  return csv([header, ...rows]);
}

export function buildFailuresCsv(results: SampleResult[]): string {
  const header = ["sample_id", "failed_fields", "certification_class"];
  const rows = results
    .filter((r) => r.needs_manual_review)
    .map((r) => {
      const failed = COMPARED_FIELDS.filter((f) => r.fields[f].evaluable && !r.fields[f].match)
        .map((f) => `${f}(pred=${r.fields[f].predicted ?? "∅"}|truth=${r.fields[f].truth})`)
        .join("; ");
      return [r.sample_id, failed, r.certification_class];
    });
  return csv([header, ...rows]);
}

export function buildConfidentCertErrorsCsv(results: SampleResult[]): string {
  const header = ["sample_id", "predicted_certification", "truth_certification", "confidence"];
  const rows = results
    .filter((r) => r.certification_class === "confidently_incorrect")
    .map((r) => {
      const c = r.fields.certification_number;
      return [r.sample_id, c.predicted, c.truth, c.confidence];
    });
  return csv([header, ...rows]);
}
