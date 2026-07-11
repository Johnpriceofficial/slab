#!/usr/bin/env bash
# ============================================================================
# SlabVault — operator-run live deploy to a DEDICATED SlabVault project.
#
# Secrets stay on the operator's machine and in the environment; this script
# never echoes them, never enables tracing, and never writes them to a tracked
# file. Run it yourself after exporting the required variables (see
# LIVE_DEPLOYMENT_OPERATOR.md). It refuses to touch the MCVR N8N project or any
# production-adjacent target.
# ============================================================================
set -euo pipefail
set +x  # never trace — tracing would leak secrets
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/env-guard.sh
. "$ROOT/scripts/lib/env-guard.sh"

# --- 0. refuse unless a dedicated project ref is explicitly set -------------
if [ -z "${SLABVAULT_PROJECT_REF:-}" ]; then
  printf 'ERROR: %s\n' "SLABVAULT_PROJECT_REF must be set (a dedicated SlabVault project)." >&2
  exit 1
fi

require_vars \
  SLABVAULT_PROJECT_REF \
  SLABVAULT_SUPABASE_URL \
  SLABVAULT_ANON_KEY \
  SLABVAULT_SERVICE_ROLE_KEY \
  PRICECHARTING_API_TOKEN \
  ANTHROPIC_API_KEY

guard_dedicated_project SLABVAULT_PROJECT_REF SLABVAULT_SUPABASE_URL
check_url_matches_ref SLABVAULT_SUPABASE_URL SLABVAULT_PROJECT_REF

# --- 1. database password (prompt securely if not already supplied) ---------
if [ -z "${SLABVAULT_DB_PASSWORD:-}" ]; then
  read -r -s -p "SlabVault database password: " SLABVAULT_DB_PASSWORD
  printf '\n'
fi
if [ -z "$SLABVAULT_DB_PASSWORD" ]; then
  printf 'ERROR: %s\n' "database password is required." >&2
  exit 1
fi
export SUPABASE_DB_PASSWORD="$SLABVAULT_DB_PASSWORD"

# --- 2. temp secret env-files (never tracked; removed on exit via trap) ------
PC_FILE="$(mktemp)"
AN_FILE="$(mktemp)"
cleanup() { rm -f "$PC_FILE" "$AN_FILE"; }
trap cleanup EXIT
chmod 600 "$PC_FILE" "$AN_FILE"
printf 'PRICECHARTING_API_TOKEN=%s\n' "$PRICECHARTING_API_TOKEN" >"$PC_FILE"
printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" >"$AN_FILE"

# --- 3. frontend .env.local (PUBLIC values only; must be gitignored) --------
if ! git check-ignore -q .env.local; then
  printf 'ERROR: %s\n' ".env.local is not gitignored — refusing to write frontend env." >&2
  exit 1
fi
{
  printf 'VITE_SUPABASE_URL=%s\n' "$SLABVAULT_SUPABASE_URL"
  printf 'VITE_SUPABASE_ANON_KEY=%s\n' "$SLABVAULT_ANON_KEY"
  printf 'VITE_ALLOW_SLAB_HARD_DELETE=false\n'
} >.env.local

# --- redaction: scrub known secret values from any tool output --------------
_redact_stream() {
  local line s
  while IFS= read -r line; do
    for s in "$SLABVAULT_DB_PASSWORD" "$PRICECHARTING_API_TOKEN" "$ANTHROPIC_API_KEY" "$SLABVAULT_SERVICE_ROLE_KEY"; do
      [ -n "$s" ] && line="${line//$s/[REDACTED]}"
    done
    printf '%s\n' "$line"
  done
}

# run_step DESC CMD... — prints only sanitized [PASS]/[FAIL]; on failure prints a
# redacted log tail and aborts.
run_step() {
  local desc="$1"; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    printf '  [PASS] %s\n' "$desc"
    rm -f "$log"
  else
    printf '  [FAIL] %s\n' "$desc"
    _redact_stream <"$log" | tail -n 30 | sed 's/^/      /' >&2
    rm -f "$log"
    exit 1
  fi
}

printf 'Deploying to the dedicated SlabVault project (ref redacted)…\n'
run_step "supabase link"                     supabase link --project-ref "$SLABVAULT_PROJECT_REF" --yes
run_step "supabase db push (migrations)"     supabase db push --yes
run_step "set PRICECHARTING_API_TOKEN secret" supabase secrets set --env-file "$PC_FILE"
run_step "set ANTHROPIC_API_KEY secret"      supabase secrets set --env-file "$AN_FILE"
run_step "build pricecharting edge bundle"   node scripts/build-pricecharting-edge-bundle.mjs
run_step "build analyze-slab edge bundle"    node scripts/build-analyze-slab-edge-bundle.mjs
run_step "deno check edge functions"         deno check supabase/functions/pricecharting-search/index.ts supabase/functions/analyze-slab/index.ts
run_step "deploy pricecharting-search"       supabase functions deploy pricecharting-search
run_step "deploy analyze-slab"               supabase functions deploy analyze-slab

printf '\nDeploy complete.\n'
printf 'Hard-delete remains DISABLED (frontend VITE_ALLOW_SLAB_HARD_DELETE=false; slab_settings.allow_hard_delete defaults false).\n'
printf 'Next: run scripts/verify-live.sh with the SLABVAULT_TEST_* variables.\n'
