#!/usr/bin/env bash
# ==========================================================================
# Disposable migration-chain verification (portable: bash 3.2+, macOS/Linux).
#
#   Test A  clean-from-zero  : apply the whole chain to an empty disposable DB.
#   Test B  prod-shaped      : base <= TIP, then upgrade, when TIP is set.
#
# Disposable postgres:17 only. No production. No customer data. No secrets.
# STOPs (nonzero) on the FIRST migration error — a manual fix means the chain
# failed. Discovers the repo root dynamically; cleans up its container.
#
# Usage:
#   scripts/verify/migration-chain.sh                 # Test A
#   TIP=20260904000000 scripts/verify/migration-chain.sh   # Test B (base+upgrade)
# ==========================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG_DIR="$REPO_ROOT/supabase/migrations"
BOOTSTRAP="$REPO_ROOT/scripts/verify/supabase-bootstrap.sql"
ASSERT="$REPO_ROOT/scripts/verify/schema-assertions.sql"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
TIP="${TIP:-}"
CID="slab-migchain-$$"

fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -d "$MIG_DIR" ]   || fail "no migration dir: $MIG_DIR"
[ -f "$BOOTSTRAP" ] || fail "missing bootstrap fixture: $BOOTSTRAP"
command -v docker >/dev/null || fail "docker required"

echo "repo_root=$REPO_ROOT  git_sha=$(git -C "$REPO_ROOT" rev-parse HEAD)"
echo "pg_image=$PG_IMAGE  mode=$([ -n "$TIP" ] && echo "prod-shaped (TIP=$TIP)" || echo clean)"

docker rm -f "$CID" >/dev/null 2>&1 || true
docker run -d --name "$CID" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO_ROOT":/repo:ro "$PG_IMAGE" >/dev/null
n=0; until docker exec "$CID" pg_isready -U postgres >/dev/null 2>&1; do n=$((n+1)); [ "$n" -gt 60 ] && fail "postgres not ready"; sleep 1; done

PSQL() { docker exec -i "$CID" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
PSQL -f /repo/scripts/verify/supabase-bootstrap.sql >/dev/null

apply() { # apply migrations whose version satisfies the numeric predicate in $2 (<= or >=) $3 (or "all")
  local applied=0
  for f in $(docker exec "$CID" bash -lc 'ls /repo/supabase/migrations/*.sql | sort'); do
    b="$(basename "$f")"; ver="${b%%_*}"
    case "$2" in
      le) [ "$ver" -le "$3" ] || continue;;
      ge) [ "$ver" -ge "$3" ] || continue;;
      all) : ;;
    esac
    if ! docker exec -i "$CID" psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/tmp/$CID.log 2>&1; then
      echo "  x $b"; tail -12 /tmp/$CID.log | sed 's/^/    /'
      fail "migration $b failed (no manual fix attempted)"
    fi
    docker exec -i "$CID" psql -U postgres -q -c \
      "insert into supabase_migrations.schema_migrations(version,name) values ('$ver','${b#*_}') on conflict do nothing;" >/dev/null
    applied=$((applied+1))
  done
  eval "$1=$applied"
}

if [ -n "$TIP" ]; then
  apply BASE le "$TIP";  echo "base (<= $TIP): $BASE applied"
  apply UP   ge "$((TIP+1))"; echo "upgrade (> $TIP): $UP applied"
  echo "TEST_B_PROD_SHAPED_UPGRADE: PASS (base $BASE + upgrade $UP)"
else
  apply ALL all "0"; echo "clean install: $ALL migrations applied"
  [ -f "$ASSERT" ] && PSQL -f /repo/scripts/verify/schema-assertions.sql
  echo "TEST_A_CLEAN_INSTALL: PASS ($ALL migrations, 0 manual interventions)"
fi
