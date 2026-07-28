import { defineConfig } from "vitest/config";

/**
 * Dedicated config for the live Supabase integration suite
 * (src/test/integration/**). These tests run against ONE shared database and
 * several of them must mutate global singleton rows — most notably
 * public.slab_settings (id = true), whose allow_hard_delete flag the tombstone,
 * slabvault, buildout-integrity and slab-inventory-maintenance suites each
 * toggle to exercise the hard-delete/purge path.
 *
 * vitest isolates every test FILE in its own worker/module registry, so an
 * in-process mutex cannot serialize access across files, and PostgREST connection
 * pooling makes session-level advisory locks unreliable across REST calls.
 * The correct, deterministic fix is therefore to run the integration group with
 * file parallelism DISABLED: files execute one at a time, so no two suites ever
 * hold conflicting values of the shared singleton at once. This is the group's
 * normal CI execution mode (see .github/workflows/ci.yml), not a manual
 * override — the suite must be stable exactly as CI runs it.
 *
 * Unit/component tests are unaffected; they keep full parallelism under the
 * root vite.config.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["src/test/integration/**/*.{test,spec}.ts"],
    fileParallelism: false,
    // A live DB round-trips; give slow authorization/purge paths room without
    // masking a genuine hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
