/**
 * CI guards for the benchmark suite itself.
 *
 * Requirement 14: no benchmark test may be skipped in CI — a skipped accuracy
 * guard is worse than none, because it reads as green. This test reads the
 * benchmark test sources and fails if any use a skip/only marker, and it runs
 * the committed dry-run fixtures end to end so the CI dry-run path is exercised
 * without any OpenAI call.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "@/lib/benchmark/manifest";
import { runBenchmark, MemoryResumeStore, createFixtureAnalyze } from "@/lib/benchmark/runner";
import { predictionFromAnalyze } from "@/lib/benchmark/compare";
import { buildSummaryMarkdown, buildReport } from "@/lib/benchmark/report";
import { aggregate } from "@/lib/benchmark/metrics";
import { DEFAULT_CONFIG, type BenchmarkConfig, type SamplePrediction } from "@/lib/benchmark/types";

const BENCH_TEST_DIR = join(__dirname);
const FIXTURE_DIR = join(__dirname, "..", "..", "..", "scripts", "benchmark", "fixtures");

describe("no benchmark test is skipped (Requirement 14)", () => {
  it("no benchmark test file uses .skip / .only / xit / xdescribe", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(BENCH_TEST_DIR).filter((f) => f.endsWith(".test.ts"))) {
      const text = readFileSync(join(BENCH_TEST_DIR, file), "utf8");
      // Match actual skip/only CALLS (a trailing paren), not mentions in strings
      // or comments — so this guard file describing the rule isn't a false hit.
      if (/\b(?:describe|it|test)\.(?:skip|only)\s*\(/.test(text) || /\b(?:xit|xdescribe)\s*\(/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("committed dry-run fixtures run end to end", () => {
  it("parses the fixture manifest, runs against fixture responses, and produces a report", async () => {
    const manifest = readFileSync(join(FIXTURE_DIR, "manifest.csv"), "utf8");
    const { samples, errors } = parseManifest(manifest, "csv");
    expect(errors).toEqual([]);
    expect(samples.length).toBeGreaterThan(0);

    const responses = JSON.parse(readFileSync(join(FIXTURE_DIR, "responses.json"), "utf8")) as Record<string, unknown>;
    const fixtures: Record<string, SamplePrediction> = {};
    for (const [id, body] of Object.entries(responses)) {
      fixtures[id] = predictionFromAnalyze(body as never, { status: 200, model: "dry-run", request_id: `dry-${id}`, latency_ms: 0, analysis_run_id: null });
    }

    const config: BenchmarkConfig = { ...DEFAULT_CONFIG, request_delay_ms: 0, project_ref: "dry-run", supabase_url: "" };
    const out = await runBenchmark(samples, config, { analyze: createFixtureAnalyze(fixtures), store: new MemoryResumeStore(), sleep: async () => {} });

    // Every fixture sample was evaluated; the blurred-cert sample is safe (blank),
    // so there are zero confidently-incorrect certs in the fixture set.
    expect(out.results).toHaveLength(samples.length);
    expect(out.metrics!.certification.confidently_incorrect).toBe(0);

    const md = buildSummaryMarkdown(buildReport(out.results, aggregate(out.results, config), "2026-07-14T00:00:00Z"));
    expect(md).toMatch(/Certification safety/);
  });
});
