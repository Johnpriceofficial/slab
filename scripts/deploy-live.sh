#!/usr/bin/env bash
# ============================================================================
# GradedCardValue.com — operator-run live deploy to a dedicated project.
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
  printf 'ERROR: %s\n' "SLABVAULT_PROJECT_REF must be set (a dedicated GradedCardValue.com project)." >&2
  exit 1
fi

require_vars \
  SLABVAULT_PROJECT_REF \
  SLABVAULT_SUPABASE_URL \
  SLABVAULT_ANON_KEY \
  SLABVAULT_SERVICE_ROLE_KEY \
  PRICECHARTING_API_TOKEN \
  OPENAI_API_KEY

guard_dedicated_project SLABVAULT_PROJECT_REF SLABVAULT_SUPABASE_URL
check_url_matches_ref SLABVAULT_SUPABASE_URL SLABVAULT_PROJECT_REF

# --- 1. database password (prompt securely if not already supplied) ---------
if [ -z "${SLABVAULT_DB_PASSWORD:-}" ]; then
  read -r -s -p "GradedCardValue.com database password: " SLABVAULT_DB_PASSWORD
  printf '\n'
fi
if [ -z "$SLABVAULT_DB_PASSWORD" ]; then
  printf 'ERROR: %s\n' "database password is required." >&2
  exit 1
fi
export SUPABASE_DB_PASSWORD="$SLABVAULT_DB_PASSWORD"

# --- 2. temp secret env-files (never tracked; removed on exit via trap) ------
PC_FILE="$(mktemp)"
AI_FILE="$(mktemp)"
EBAY_FILE="$(mktemp)"
cleanup() { rm -f "$PC_FILE" "$AI_FILE" "$EBAY_FILE"; }
trap cleanup EXIT
chmod 600 "$PC_FILE" "$AI_FILE" "$EBAY_FILE"
printf 'PRICECHARTING_API_TOKEN=%s\n' "$PRICECHARTING_API_TOKEN" >"$PC_FILE"
printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >"$AI_FILE"
printf 'OPENAI_ANALYZE_MODEL=%s\n' "${OPENAI_ANALYZE_MODEL:-gpt-5.6-terra}" >>"$AI_FILE"
printf 'OPENAI_SCAN_MODEL=%s\n' "${OPENAI_SCAN_MODEL:-${OPENAI_ANALYZE_MODEL:-gpt-5.6-terra}}" >>"$AI_FILE"

EBAY_ENABLED=false
if [ -n "${EBAY_CLIENT_ID:-}" ] || [ -n "${EBAY_CLIENT_SECRET:-}" ]; then
  require_vars EBAY_CLIENT_ID EBAY_CLIENT_SECRET EBAY_REDIRECT_URI EBAY_RU_NAME EBAY_TOKEN_ENCRYPTION_KEY
  EBAY_ENABLED=true
  {
    printf 'EBAY_CLIENT_ID=%s\n' "$EBAY_CLIENT_ID"
    printf 'EBAY_CLIENT_SECRET=%s\n' "$EBAY_CLIENT_SECRET"
    printf 'EBAY_REDIRECT_URI=%s\n' "$EBAY_REDIRECT_URI"
    printf 'EBAY_RU_NAME=%s\n' "$EBAY_RU_NAME"
    printf 'EBAY_TOKEN_ENCRYPTION_KEY=%s\n' "$EBAY_TOKEN_ENCRYPTION_KEY"
    printf 'EBAY_ENVIRONMENT=%s\n' "${EBAY_ENVIRONMENT:-PRODUCTION}"
  } >"$EBAY_FILE"
fi

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
    for s in "$SLABVAULT_DB_PASSWORD" "$PRICECHARTING_API_TOKEN" "$OPENAI_API_KEY" "$SLABVAULT_SERVICE_ROLE_KEY" "${EBAY_CLIENT_SECRET:-}" "${EBAY_TOKEN_ENCRYPTION_KEY:-}"; do
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

printf 'Deploying to the dedicated GradedCardValue.com project (ref redacted)…\n'
run_step "supabase link"                     supabase link --project-ref "$SLABVAULT_PROJECT_REF" --yes
run_step "supabase db push (migrations)"     supabase db push --yes
run_step "set PRICECHARTING_API_TOKEN secret" supabase secrets set --env-file "$PC_FILE"
run_step "set OpenAI secrets"                supabase secrets set --env-file "$AI_FILE"
[ "$EBAY_ENABLED" = false ] || run_step "set eBay secrets" supabase secrets set --env-file "$EBAY_FILE"
run_step "build pricecharting edge bundle"   node scripts/build-pricecharting-edge-bundle.mjs
run_step "build analyze-slab edge bundle"    node scripts/build-analyze-slab-edge-bundle.mjs
run_step "build marketplace edge bundle"     node scripts/build-pricecharting-marketplace-edge-bundle.mjs
run_step "deno check edge functions"         deno check supabase/functions/{pricecharting-search,analyze-slab,scan-card,pricecharting-marketplace,pricecharting-sync,marketplace-scheduler,ebay-oauth-start,ebay-oauth-callback,ebay-account-sync,ebay-reference-search,ebay-list-item,ebay-revise-item,ebay-end-item,ebay-order-sync,ebay-fulfillment,ebay-finances-sync,ebay-notification-handler}/index.ts
for fn in pricecharting-search analyze-slab scan-card pricecharting-marketplace pricecharting-sync marketplace-scheduler ebay-oauth-start ebay-oauth-callback ebay-account-sync ebay-reference-search ebay-list-item ebay-revise-item ebay-end-item ebay-order-sync ebay-fulfillment ebay-finances-sync ebay-notification-handler; do
  run_step "deploy $fn" supabase functions deploy "$fn"
done

printf '\nDeploy complete.\n'
printf 'Hard-delete remains DISABLED (frontend VITE_ALLOW_SLAB_HARD_DELETE=false; slab_settings.allow_hard_delete defaults false).\n'
printf 'Next: run scripts/verify-live.sh with the SLABVAULT_TEST_* variables.\n'
