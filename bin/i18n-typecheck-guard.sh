#!/usr/bin/env bash
# =============================================================================
# i18n typecheck guard
# =============================================================================
# Asserts that NO file on the i18n surface produces a TypeScript error.
#
# WHY THIS EXISTS INSTEAD OF `npm run typecheck`
# ----------------------------------------------
# `cd apps/web-next && npm run typecheck` cannot be a gate in this repo:
# pristine origin/main emits ~347 errors across ~113 files, and CI's own
# TypeScript step carries `continue-on-error: true` ("Pre-existing TS errors —
# tracked for separate cleanup"). So the CI job reports success regardless of
# what tsc says, and any DoD demanding `exit 0` from it is unsatisfiable.
#
# The honest gate is scoped: this plan's own files must be clean, and the
# repo-wide count must not grow. This is the same principle as the e2e
# baseline-superset rule and the hardcoded-string ratchet — measure the
# direction of travel, not an absolute that was never true.
#
# Usage:
#   ./bin/i18n-typecheck-guard.sh
#   ./bin/i18n-typecheck-guard.sh --update   # re-baseline the repo-wide count
#
# Exit codes:
#   0 = no REAL type error on the i18n surface AND repo-wide count did not grow
#   1 = a regression on either measure
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/bin/i18n-typecheck-guard.baseline"

# Paths owned by the i18n work. Any tsc error whose file matches one of these
# is a regression this plan introduced and must block.
#
# Matched against the tsc-reported path, which is relative to apps/web-next
# (e.g. "../../packages/agentbook-i18n/src/core.ts", "src/lib/x.ts").
OWNED_PATTERNS=(
  'packages/agentbook-i18n/src/'
  'src/__tests__/architecture/i18n-'
  'src/app/api/v1/agentbook-core/agent/message/route.ts'
  'src/app/api/v1/agentbook-core/tenant-config/route.ts'
  'src/hooks/use-shell-i18n.ts'
  'src/contexts/shell-context.tsx'
  'src/components/settings/AgentBookSettingsPanel.tsx'
  'packages/plugin-sdk/src/hooks/useI18n.ts'
  'src/lib/i18n'
)

cd "$ROOT_DIR/apps/web-next" || exit 1

# TS6307 is EXCLUDED from both measures below.
#
# It reads "File X is not listed within the file list of project
# apps/web-next/tsconfig.json" and is a project-INCLUDE artifact, not a
# statement about whether any code type-checks. web-next's tsconfig includes
# only `plugin-sdk/src/components/*.tsx`, so every symbol re-exported from
# plugin-sdk's barrel files raises one: 75 of the repo's 344 errors are TS6307,
# 18 of them on plugin-sdk/src/hooks/index.ts alone — one per exported hook,
# almost all predating this work.
#
# Counting them would mean any new SDK export trips the guard for a reason
# unrelated to correctness, while real type errors hid in the noise. Widening
# the tsconfig include to silence them is a separate change with its own
# blast radius. So: measure the 269 REAL type errors, and let TS6307 be.

# `set -e` is deliberately not in force, so this captures tsc's status rather
# than swallowing it with `|| true`. The status matters: see the sanity check
# immediately below.
RAW="$(npx tsc --noEmit 2>&1)"
TSC_STATUS=$?
ERRORS="$(printf '%s\n' "$RAW" | grep -E 'error TS' | grep -v 'error TS6307' || true)"
COUNT="$(printf '%s\n' "$ERRORS" | grep -c 'error TS' || true)"
[ -z "$COUNT" ] && COUNT=0

# ---------------------------------------------------------------------------
# 0. Sanity: did the compiler actually run?
# ---------------------------------------------------------------------------
# A tsc that never ran emits no line matching `error TS`, so COUNT is 0, the
# owned surface looks clean, and the ratchet reports "count fell by 280 —
# PASS". That is the worst possible green: the guard announces a large
# improvement precisely when it measured nothing. Reachable in CI from a
# missing binary, an OOM kill, or an unreadable tsconfig.
#
# tsc exits 0 only when it compiled and found nothing, so a non-zero exit with
# no diagnostic at all means the run failed rather than the tree being clean.
# A run reporting only TS6307 still matches `error TS` here and passes through,
# which is intended — those are filtered from the measures, not from this check.
#
# The match is a bash `case`, NOT `printf ... | grep -q`. Under the `pipefail`
# set at the top of this file that pipeline reports FAILURE when it matches:
# `grep -q` exits the moment it finds a hit, `printf` is killed by SIGPIPE
# writing the rest, and pipefail surfaces printf's 141 as the pipeline status.
# So the guard aborted with "the compiler failed to run" on a perfectly normal
# 269-error run — a false alarm from the check meant to catch a false pass.
case "$RAW" in
  *'error TS'*) TSC_REPORTED_DIAGNOSTIC=1 ;;
  *)            TSC_REPORTED_DIAGNOSTIC=0 ;;
esac

if [ "$TSC_STATUS" -ne 0 ] && [ "$TSC_REPORTED_DIAGNOSTIC" -eq 0 ]; then
  echo "[typecheck-guard] FAIL — tsc exited $TSC_STATUS without reporting a single"
  echo "[typecheck-guard] diagnostic. The compiler failed to run; this is not a"
  echo "[typecheck-guard] clean tree. Last lines of its output:"
  printf '%s\n' "$RAW" | tail -20 | sed 's/^/    /'
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Hard gate: zero errors on the owned surface.
# ---------------------------------------------------------------------------
OWNED_HITS=""
for pat in "${OWNED_PATTERNS[@]}"; do
  hit="$(printf '%s\n' "$ERRORS" | grep -F "$pat" || true)"
  [ -n "$hit" ] && OWNED_HITS="${OWNED_HITS}${hit}\n"
done

if [ -n "$OWNED_HITS" ]; then
  echo "[typecheck-guard] FAIL — TypeScript errors on the i18n surface:"
  printf '%b' "$OWNED_HITS" | sed 's/^/    /'
  exit 1
fi
echo "[typecheck-guard] i18n surface: clean (0 errors)"

# ---------------------------------------------------------------------------
# 2. Ratchet: the repo-wide count must not grow.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--update" ]; then
  echo "$COUNT" > "$BASELINE_FILE"
  echo "[typecheck-guard] repo-wide baseline set to $COUNT"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "[typecheck-guard] no baseline; current repo-wide count: $COUNT"
  echo "[typecheck-guard] run with --update to establish it"
  exit 1
fi

BASELINE="$(tr -d '[:space:]' < "$BASELINE_FILE")"
echo "[typecheck-guard] repo-wide errors: $COUNT (baseline $BASELINE)"

if [ "$COUNT" -gt "$BASELINE" ]; then
  echo "[typecheck-guard] FAIL — repo-wide count grew by $((COUNT - BASELINE))."
  exit 1
fi
if [ "$COUNT" -lt "$BASELINE" ]; then
  echo "[typecheck-guard] PASS — count fell by $((BASELINE - COUNT)). Run --update to lock it in."
else
  echo "[typecheck-guard] PASS — count unchanged."
fi
exit 0
