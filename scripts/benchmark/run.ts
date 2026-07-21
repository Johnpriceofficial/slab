/**
 * analyze-slab accuracy benchmark — CLI runner (Node/Bun glue only).
 *
 * All logic lives in src/lib/benchmark (pure, typechecked, unit tested). This
 * file just wires that logic to real I/O: reading the manifest + images, calling
 * the DEPLOYED analyze-slab Edge Function on a TEST project, persisting raw
 * responses + resume state, and writing the report bundle.
 *
 * It never runs in normal CI (scripts/** is excluded from lint/typecheck) and it
 * refuses to target the production project. CI exercises the same pure pipeline
 * through the dry-run fixture path in the unit tests.
 *
 * Usage (real run against a TEST project):
 *   SLABVAULT_BENCH_URL="https://<TEST_REF>.supabase.co" \
 *   SLABVAULT_BENCH_ANON_KEY="<test anon key>" \
 *   bun scripts/benchmark/run.ts --manifest dataset/slabs.csv --out benchmark-results
 *
 * Dry run (no OpenAI; deterministic fixtures) — also what CI uses:
 *   bun scripts/benchmark/run.ts --manifest fixtures/manifest.csv \
 *     --dry-run --fixtures fixtures/responses.json --out /tmp/bench
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  PRODUCTION_PROJECT_REF,
  aggregate,
  assertNotProduction,
  benchmarkExitCode,
  buildConfidentCertErrorsCsv,
  buildFailuresCsv,
  buildPerSampleCsv,
  buildReport,
  buildSummaryJson,
  buildSummaryMarkdown,
  createFixtureAnalyze,
  parseManifest,
  predictionFromAnalyze,
  runBenchmark,
  validateImages,
  type BenchmarkConfig,
  type BenchmarkSample,
  type MatchPrediction,
  type ResumeStore,
  type SamplePrediction,
  type SampleResult,
} from "../../src/lib/benchmark/index.ts";
import { PriceChartingClient } from "../../src/lib/pricecharting/client.ts";
import { findBestProductMatch } from "../../src/lib/pricecharting/matching.ts";
import type { CardItemInput, GradingCompany } from "../../src/lib/pricecharting/types.ts";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(2);
}

const manifestPath = arg("manifest") ?? die("--manifest <path> is required.");
const outDir = resolve(arg("out", "benchmark-results")!);
const dryRun = flag("dry-run");
const format = (arg("format") ?? (extname(manifestPath).toLowerCase() === ".json" ? "json" : "csv")) as "csv" | "json";

// ── Config from env + flags ────────────────────────────────────────────────
const url = process.env.SLABVAULT_BENCH_URL ?? "";
const anonKey = process.env.SLABVAULT_BENCH_ANON_KEY ?? "";
const projectRef = process.env.SLABVAULT_BENCH_PROJECT_REF ?? (url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? "");

if (!dryRun) {
  if (!url || !anonKey) die("SLABVAULT_BENCH_URL and SLABVAULT_BENCH_ANON_KEY are required for a real run (or pass --dry-run).");
  if (!projectRef) die("Could not determine the target project ref; set SLABVAULT_BENCH_PROJECT_REF.");
}

const config: BenchmarkConfig = {
  ...DEFAULT_CONFIG,
  acceptance_threshold: Number(arg("acceptance-threshold", String(DEFAULT_CONFIG.acceptance_threshold))),
  concurrency: Number(arg("concurrency", String(DEFAULT_CONFIG.concurrency))),
  request_delay_ms: Number(arg("delay", String(DEFAULT_CONFIG.request_delay_ms))),
  thresholds: {
    ...DEFAULT_THRESHOLDS,
    card_identity_accuracy: Number(arg("min-identity", String(DEFAULT_THRESHOLDS.card_identity_accuracy))),
    grade_accuracy: Number(arg("min-grade", String(DEFAULT_THRESHOLDS.grade_accuracy))),
    certification_accuracy: Number(arg("min-cert", String(DEFAULT_THRESHOLDS.certification_accuracy))),
    max_confident_wrong_certs: Number(arg("max-confident-cert-errors", String(DEFAULT_THRESHOLDS.max_confident_wrong_certs))),
    manual_review_rate: Number(arg("max-manual-review", String(DEFAULT_THRESHOLDS.manual_review_rate))),
    product_match_accuracy: Number(arg("min-match", String(DEFAULT_THRESHOLDS.product_match_accuracy))),
    max_confident_wrong_matches: Number(arg("max-confident-match-errors", String(DEFAULT_THRESHOLDS.max_confident_wrong_matches))),
  },
  project_ref: dryRun ? projectRef || "dry-run" : projectRef,
  supabase_url: url,
};

// Hard refusal to touch production, even before reading anything.
if (!dryRun) assertNotProduction(config);
if (url.includes(PRODUCTION_PROJECT_REF)) die("SLABVAULT_BENCH_URL points at production. Aborting.");

// ── Load + validate manifest ───────────────────────────────────────────────
const { samples, errors } = parseManifest(readFileSync(manifestPath, "utf8"), format);
if (errors.length > 0) die(`Manifest problems:\n  - ${errors.join("\n  - ")}`);
if (samples.length === 0) die("Manifest contains zero samples.");

const manifestDir = dirname(resolve(manifestPath));
const resolveImage = (p: string) => (p.startsWith("/") ? p : join(manifestDir, p));
// A real run needs the image bytes; a dry run reads fixtures, not images.
if (!dryRun) {
  const imageErrors = validateImages(samples, (p) => existsSync(resolveImage(p)));
  if (imageErrors.length > 0) die(`Image problems:\n  - ${imageErrors.join("\n  - ")}`);
}

// ── Output dirs ────────────────────────────────────────────────────────────
const stateDir = join(outDir, ".state");
const rawDir = join(outDir, "raw-responses");
for (const d of [outDir, stateDir, rawDir]) mkdirSync(d, { recursive: true });

// ── Resume store (one JSON file per completed sample) ──────────────────────
const store: ResumeStore = {
  has: (id) => existsSync(join(stateDir, `${id}.json`)),
  get: (id) => {
    try {
      return JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8")).result as SampleResult;
    } catch {
      return undefined;
    }
  },
  put: (result, prediction) => {
    writeFileSync(join(stateDir, `${result.sample_id}.json`), JSON.stringify({ result }, null, 2));
    writeFileSync(join(rawDir, `${result.sample_id}.json`), JSON.stringify(prediction.raw, null, 2));
  },
};

// ── analyze(): real Edge Function call, or dry-run fixtures ─────────────────
function fileToBase64(path: string): string {
  return readFileSync(resolveImage(path)).toString("base64");
}
function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".heic" ? "image/heic" : "image/jpeg";
}

let analyze: (sample: BenchmarkSample) => Promise<SamplePrediction>;
if (dryRun) {
  const fixturesPath = arg("fixtures") ?? die("--dry-run requires --fixtures <path>.");
  const raw = JSON.parse(readFileSync(fixturesPath, "utf8")) as Record<string, unknown>;
  const fixtures: Record<string, SamplePrediction> = {};
  for (const [id, value] of Object.entries(raw)) {
    // A fixture may be a full SamplePrediction, or an AnalyzeResult body we adapt.
    if (value && typeof value === "object" && "fields" in value && "meta" in value) {
      fixtures[id] = value as SamplePrediction;
    } else {
      fixtures[id] = predictionFromAnalyze(value as never, { status: 200, model: "dry-run", request_id: `dry-${id}`, latency_ms: 0, analysis_run_id: null });
    }
  }
  analyze = createFixtureAnalyze(fixtures);
} else {
  const client = createClient(url, anonKey);
  analyze = async (sample) => {
    const body: Record<string, unknown> = { front_image_base64: fileToBase64(sample.front_image_path), front_mime: mimeFor(sample.front_image_path) };
    if (sample.back_image_path) {
      body.back_image_base64 = fileToBase64(sample.back_image_path);
      body.back_mime = mimeFor(sample.back_image_path);
    }
    const started = Date.now();
    const { data, error } = await client.functions.invoke("analyze-slab", { body });
    const latency = Date.now() - started;
    if (error) throw new Error(`Edge Function error for ${sample.sample_id}: ${error.message}`);
    const resultBody = data as { status?: string; model?: string; request_ids?: string[]; analysis_run_id?: string | null };
    if (resultBody?.status !== "success") {
      throw new Error(`analyze-slab returned ${resultBody?.status ?? "no status"} for ${sample.sample_id}`);
    }
    return predictionFromAnalyze(resultBody as never, {
      status: 200,
      model: resultBody.model ?? null,
      request_id: resultBody.request_ids?.[0] ?? null,
      latency_ms: latency,
      analysis_run_id: resultBody.analysis_run_id ?? null,
    });
  };
}

// ── Optional PriceCharting product-match step ──────────────────────────────
// Off by default. Enable with --match; requires a PriceCharting token. Measures
// the END-TO-END match: it feeds the MODEL's predicted identity (not ground
// truth) into the production matcher, so the number reflects what the deployed
// pipeline would actually resolve. Samples whose manifest has no truth
// `pricecharting_product_id` are still unjudgeable and excluded from accuracy.
let matchOf: ((sample: BenchmarkSample, prediction: SamplePrediction) => Promise<MatchPrediction | null>) | undefined;
if (flag("match")) {
  const pcToken = process.env.PRICECHARTING_API_TOKEN ?? process.env.SLABVAULT_BENCH_PRICECHARTING_TOKEN ?? "";
  if (!pcToken) die("--match requires PRICECHARTING_API_TOKEN (or SLABVAULT_BENCH_PRICECHARTING_TOKEN) in the environment.");
  const pcClient = new PriceChartingClient({ tokenProvider: () => pcToken });
  const read = (p: { value: string | null; readable: boolean } | undefined): string | undefined =>
    p && p.readable && p.value ? p.value : undefined;
  const graderOf = (raw: string | undefined): GradingCompany | undefined => {
    const g = (raw ?? "").toUpperCase();
    return g.includes("PSA") ? "PSA" : g.includes("BGS") || g.includes("BECKETT") ? "BGS" : g.includes("CGC") ? "CGC" : g.includes("SGC") ? "SGC" : g ? "OTHER" : undefined;
  };
  matchOf = async (_sample, prediction) => {
    const f = prediction.fields;
    const gradeNum = read(f.grade) ? Number((read(f.grade) as string).match(/\d{1,2}(?:\.\d)?/)?.[0]) : undefined;
    const item: CardItemInput = {
      category: "trading_card",
      card_name: read(f.card_name),
      card_number: read(f.card_number),
      set: read(f.set_name),
      language: read(f.language),
      variant: read(f.variation) ?? read(f.finish),
      grading_company: graderOf(read(f.grader)),
      grade: Number.isFinite(gradeNum) ? gradeNum : undefined,
    };
    const { product, match } = await findBestProductMatch(pcClient, item);
    const status: MatchPrediction["status"] = product ? "confirmed" : match.alternatives_considered.length > 0 || match.confidence_score > 0 ? "manual_review" : "unresolved";
    return { pricecharting_id: product?.pricecharting_id ?? null, confidence: match.confidence_score, status };
  };
}

// ── Run ────────────────────────────────────────────────────────────────────
console.log(`Benchmarking ${samples.length} sample(s) against ${dryRun ? "DRY-RUN fixtures" : projectRef} (concurrency ${config.concurrency}, delay ${config.request_delay_ms}ms)${matchOf ? " + PriceCharting match" : ""}…`);
const outcome = await runBenchmark(samples, config, {
  analyze,
  matchOf,
  store,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress: ({ sample_id, index, total, resumed, error }) =>
    console.log(`  [${index + 1}/${total}] ${sample_id}${resumed ? " (resumed)" : ""}${error ? ` — ERROR: ${error}` : ""}`),
});

// A run with hard failures is inconclusive; recompute metrics only over results.
if (outcome.results.length === 0) die(`Every sample failed to analyze (${outcome.failed.length}). No metrics could be computed.`);
const metrics = aggregate(outcome.results, config);
const report = buildReport(outcome.results, metrics, new Date().toISOString());

writeFileSync(join(outDir, "summary.json"), buildSummaryJson(report));
writeFileSync(join(outDir, "summary.md"), buildSummaryMarkdown(report));
writeFileSync(join(outDir, "per-sample.csv"), buildPerSampleCsv(outcome.results));
writeFileSync(join(outDir, "failures.csv"), buildFailuresCsv(outcome.results));
writeFileSync(join(outDir, "confident-cert-errors.csv"), buildConfidentCertErrorsCsv(outcome.results));

console.log(`\n${buildSummaryMarkdown(report).split("\n").slice(0, 14).join("\n")}\n`);
console.log(`Reports written to ${outDir}`);
if (outcome.failed.length > 0) console.error(`⚠ ${outcome.failed.length} sample(s) failed to analyze: ${outcome.failed.map((f) => f.sample_id).join(", ")}`);

const code = outcome.failed.length > 0 ? 1 : benchmarkExitCode(metrics);
if (code !== 0) console.error(`\n✗ Benchmark did NOT pass all gates (exit ${code}).`);
else console.log(`\n✓ Benchmark passed all configured gates.`);
process.exit(code);
