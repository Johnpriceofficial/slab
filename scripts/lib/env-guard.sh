#!/usr/bin/env bash
# ============================================================================
# SlabVault — shared environment guards for the live operator scripts.
# SOURCE this file (do not execute). It NEVER prints secret values and NEVER
# enables shell tracing. On any violation it prints a redacted reason and exits
# non-zero, aborting the sourcing script.
# ============================================================================

# Substrings that indicate a non-dedicated / production-adjacent target.
SLABVAULT_FORBIDDEN_SUBSTRINGS=(mcvr joyrent party mycousin production)
# The known MCVR N8N project ref — must never be a deploy/verify target.
SLABVAULT_BLOCKED_REF="qzkuwtvqftfppojarfij"
# Obvious placeholder values that must be replaced before running.
SLABVAULT_PLACEHOLDERS=(your_project_ref your_token your_anon_key your_service_role_key your_key changeme placeholder)

_eg_fail() {
  # Print only the reason (never a value) and abort the sourcing script.
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# require_var NAME — must be set, non-empty, free of surrounding whitespace, and
# not a placeholder. Never prints the value.
require_var() {
  local name="$1"
  if [ -z "${!name+x}" ]; then _eg_fail "$name is not set."; fi
  local value="${!name}"
  if [ -z "$value" ]; then _eg_fail "$name is empty."; fi

  # Surrounding whitespace (a common copy/paste mistake, esp. for project refs).
  local trimmed="$value"
  trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}" # ltrim
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}" # rtrim
  if [ "$trimmed" != "$value" ]; then
    _eg_fail "$name has leading/trailing whitespace — re-export it without spaces."
  fi

  # Placeholder detection (case-insensitive).
  local lower
  lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  local p
  for p in "${SLABVAULT_PLACEHOLDERS[@]}"; do
    if [ "$lower" = "$p" ]; then _eg_fail "$name is a placeholder value — set the real value."; fi
  done
  case "$lower" in
    *your_*|*changeme*|*placeholder*) _eg_fail "$name looks like a placeholder — set the real value." ;;
  esac
}

require_vars() { local n; for n in "$@"; do require_var "$n"; done; }

_eg_lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

# guard_dedicated_project REF_VAR URL_VAR — refuse the blocked ref and any
# forbidden substring appearing in the ref or URL.
guard_dedicated_project() {
  local ref_var="$1" url_var="$2"
  local ref="${!ref_var:-}" url="${!url_var:-}"
  if [ "$ref" = "$SLABVAULT_BLOCKED_REF" ]; then
    _eg_fail "Refusing: $ref_var matches the blocked MCVR N8N project ref."
  fi
  local combined s
  combined="$(_eg_lower "$ref $url")"
  for s in "${SLABVAULT_FORBIDDEN_SUBSTRINGS[@]}"; do
    case "$combined" in
      *"$s"*) _eg_fail "Refusing: target ($ref_var/$url_var) contains forbidden substring '$s' — must be a dedicated SlabVault project." ;;
    esac
  done
}

# guard_url_dedicated URL_VAR — for scripts that only have a URL (verify): refuse
# the blocked ref appearing anywhere in the URL and any forbidden substring.
guard_url_dedicated() {
  local url_var="$1"
  local url_lc s
  url_lc="$(_eg_lower "${!url_var:-}")"
  case "$url_lc" in
    *"$SLABVAULT_BLOCKED_REF"*) _eg_fail "Refusing: $url_var references the blocked MCVR N8N project." ;;
  esac
  for s in "${SLABVAULT_FORBIDDEN_SUBSTRINGS[@]}"; do
    case "$url_lc" in
      *"$s"*) _eg_fail "Refusing: $url_var contains forbidden substring '$s'." ;;
    esac
  done
}

# check_url_matches_ref URL_VAR REF_VAR — the URL must contain the project ref.
check_url_matches_ref() {
  local url_var="$1" ref_var="$2"
  local url="${!url_var:-}" ref="${!ref_var:-}"
  case "$url" in
    *"$ref"*) : ;;
    *) _eg_fail "$url_var does not correspond to $ref_var (expected the URL to contain the project ref)." ;;
  esac
}
