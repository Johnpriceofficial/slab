/**
 * CI coverage guard. Fails if a production Edge Function is neither deno-checked
 * in CI nor listed as a justified exclusion, or if a generated edge bundle is
 * not rebuilt by the CI freshness step. This keeps the audit's "every function
 * is covered or explicitly excluded" invariant from silently rotting as new
 * functions/bundles are added.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const coverageDoc = readFileSync(join(root, "supabase/functions/CI-COVERAGE.md"), "utf8");

const functionDirs = readdirSync(join(root, "supabase/functions"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "_shared")
  .map((e) => e.name);

const bundleBuilders = readdirSync(join(root, "scripts"))
  .filter((f) => /^build-.*edge-bundle\.mjs$/.test(f));

describe("edge-function CI coverage", () => {
  it("has at least the known functions and bundles to check", () => {
    expect(functionDirs.length).toBeGreaterThan(0);
    expect(bundleBuilders.length).toBeGreaterThan(0);
  });

  it("covers EVERY production function: deno-checked in CI or documented exclusion", () => {
    const uncovered = functionDirs.filter((name) => {
      const denoChecked = ci.includes(`supabase/functions/${name}/index.ts`);
      const excluded = coverageDoc.includes(`\`${name}\``);
      return !denoChecked && !excluded;
    });
    expect(uncovered, `functions neither deno-checked nor excluded: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("rebuilds EVERY generated edge bundle in the CI freshness step", () => {
    const missing = bundleBuilders.filter((builder) => !ci.includes(builder));
    expect(missing, `bundle builders not run in CI: ${missing.join(", ")}`).toEqual([]);
  });
});
