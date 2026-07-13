#!/usr/bin/env bash
#
# Produce a CLEAN, shareable export of GradedCardValue.com.
#
# It uses `git archive`, so ONLY tracked files are included — the .git history,
# any .env* secrets, node_modules, the build output (dist/), and caches (.vite/,
# coverage/) are excluded BY CONSTRUCTION because they are untracked or gitignored.
# The archive is then verified to (a) contain none of that excluded material and
# (b) carry no secret-looking strings, before it is left in place. This is the fix
# for a hand-rolled zip that previously swept in .git/ and .env.local.
#
# Usage: scripts/clean-export.sh [output.zip]     (default: graded-card-value-export.zip)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
OUT="${1:-graded-card-value-export.zip}"

# 1. Only export a clean commit — never a dirty tree that might hold an uncommitted
#    secret. (git archive itself only reads HEAD, but this keeps the export honest.)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to export: the working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

# 2. Build the archive from HEAD — tracked files only.
rm -f "$OUT"
git archive --format=zip -o "$OUT" HEAD
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"

# 3. Prove the excluded material is genuinely absent. The .env.example TEMPLATE
#    (placeholders only) is expected and allowed; any real .env* file is not.
FILES="$(unzip -l "$OUT" | awk 'NF>=4{print $NF}')"
LEAKED="$(printf '%s\n' "$FILES" | grep -iE '(^|/)(\.git/|node_modules/|dist/|\.vite/|coverage/)' || true)"
ENVLEAK="$(printf '%s\n' "$FILES" | grep -iE '(^|/)\.env' | grep -viE '(^|/)\.env\.example$' || true)"
if [ -n "${LEAKED}${ENVLEAK}" ]; then
  echo "ERROR: export unexpectedly contains excluded material:" >&2
  printf '%s\n%s\n' "$LEAKED" "$ENVLEAK" | sed '/^$/d' >&2
  rm -f "$OUT"
  exit 1
fi

# 4. Scan the extracted contents for secrets (same pattern the CI secret scan uses).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -qq "$OUT" -d "$TMP"
SECRET_RE='sk-ant-[A-Za-z0-9_-]{8}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xoxb-[0-9A-Za-z-]{10}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'
if grep -rnE "$SECRET_RE" "$TMP" 2>/dev/null; then
  echo "ERROR: export contains possible secrets — refusing to leave it in place." >&2
  rm -f "$OUT"
  exit 1
fi

echo "Clean export verified: no .git, no .env, no node_modules, no build output, no caches, no secrets."
