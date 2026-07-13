#!/usr/bin/env bash
# ============================================================================
# GradedCardValue.com — operator-run live verification against a dedicated test project.
#
# Runs the eight live integration tests (must RUN, not skip), the full suite,
# typecheck, production build, both edge bundles, both deno checks, and a
# source + generated-bundle secret scan. Exits non-zero if anything fails or if
# any integration test is skipped. Never prints secret values, never traces.
# ============================================================================
set -euo pipefail
set +x
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/env-guard.sh
. "$ROOT/scripts/lib/env-guard.sh"

# --- required live test variables + dedicated-project refusal checks ---------
require_vars SLABVAULT_TEST_URL SLABVAULT_TEST_ANON_KEY SLABVAULT_TEST_SERVICE_KEY
guard_url_dedicated SLABVAULT_TEST_URL

# Export so vitest (process.env) can reach the live project.
export SLABVAULT_TEST_URL SLABVAULT_TEST_ANON_KEY SLABVAULT_TEST_SERVICE_KEY

FAILED=0
pass() { printf '  [PASS] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1" >&2; FAILED=1; }

# run_check DESC CMD... — capture output; PASS/FAIL only (no secret values in
# these commands' output, but we keep logs quiet regardless).
run_check() {
  local desc="$1"; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    pass "$desc"
  else
    fail "$desc"
    tail -n 25 "$log" | sed 's/^/      /' >&2
  fi
  rm -f "$log"
}

printf '== GradedCardValue.com live verification ==\n'

# --- 1. integration tests: must RUN all eight, zero skipped, zero failed -----
INT_LOG="$(mktemp)"
trap 'rm -f "$INT_LOG"' EXIT
if bunx vitest run src/test/integration >"$INT_LOG" 2>&1; then
  INT_RAN_OK=1
else
  INT_RAN_OK=0
fi

if [ "$INT_RAN_OK" -eq 1 ]; then
  pass "integration suite exited 0"
else
  fail "integration suite failed"
  tail -n 40 "$INT_LOG" | sed 's/^/      /' >&2
fi

# Zero skipped anywhere in the integration run.
if grep -Eq '[1-9][0-9]* skipped' "$INT_LOG"; then
  fail "integration tests were SKIPPED (expected all to run)"
else
  pass "no skipped integration tests"
fi

# The integration tests actually executed and passed (count-agnostic).
if grep -Eq '[1-9][0-9]* passed' "$INT_LOG"; then
  pass "integration tests passed ($(grep -Eo '[0-9]+ passed' "$INT_LOG" | head -1))"
else
  fail "no passing integration tests observed"
fi

if grep -Eq '[1-9][0-9]* failed' "$INT_LOG"; then
  fail "integration run reported failures"
else
  pass "no integration failures"
fi

# --- 2. full suite / typecheck / build / bundles / deno ----------------------
run_check "full test suite (bun run test)"        bun run test
run_check "typecheck (tsc)"                       bun run typecheck
run_check "production build"                       bun run build
run_check "build pricecharting edge bundle"        node scripts/build-pricecharting-edge-bundle.mjs
run_check "build analyze-slab edge bundle"         node scripts/build-analyze-slab-edge-bundle.mjs
run_check "deno check edge functions"              deno check supabase/functions/pricecharting-search/index.ts supabase/functions/analyze-slab/index.ts supabase/functions/scan-card/index.ts

# --- 3. secret scan: source + generated bundles (NOT dist / node_modules) ----
SECRET_RE='sk-ant-[A-Za-z0-9_-]{8}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xoxb-[0-9A-Za-z-]{10}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'
if grep -rnE "$SECRET_RE" src supabase scripts \
     --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sql' --include='*.mjs' --include='*.sh' \
     2>/dev/null | grep -v node_modules >/dev/null; then
  fail "secret scan found a possible secret in source/bundles"
  grep -rnE "$SECRET_RE" src supabase scripts \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sql' --include='*.mjs' --include='*.sh' \
    2>/dev/null | grep -v node_modules | cut -c1-80 | sed 's/^/      /' >&2
else
  pass "secret scan clean (source + generated bundles)"
fi

printf '\n'
if [ "$FAILED" -ne 0 ]; then
  printf 'RESULT: FAIL\n' >&2
  exit 1
fi
printf 'RESULT: PASS — integration ran with no skips, all checks green.\n'
