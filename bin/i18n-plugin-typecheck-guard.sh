#!/usr/bin/env bash
# =============================================================================
# Typecheck the plugin FRONTENDS — which nothing else does
# =============================================================================
# WHAT THIS CAUGHT
#
# The plugin frontends have no tsconfig.json and no typecheck script. Their
# build is esbuild via vite, which strips types without checking them. So an
# undefined identifier compiles cleanly, ships, and throws ReferenceError only
# when that particular component renders.
#
# That is not theoretical. The i18n extraction added t() calls to components
# that never destructured `t`, and 22 such call sites reached main across four
# files before anything noticed:
#
#   core/HomeOffice.tsx        13 sites  -> page renders a WHITE SCREEN
#   core/Ledger.tsx             6 sites  -> page renders a WHITE SCREEN
#   expense/ExpenseList.tsx     1 site   -> crashes when suggestions exist
#   billing/SubscribeModal.tsx  2 sites  -> crashes on card submission
#
# Every one was invisible to the rest of the suite:
#   - the UMD build succeeded, because esbuild does not typecheck
#   - bin/i18n-typecheck-guard.sh runs tsc on apps/web-next, whose project does
#     not include plugin sources
#   - the plugin render tests exercised the states where the broken components
#     return null early (an empty banner, an unopened modal), so the crashing
#     path was never rendered
#
# The last one is the sharpest lesson: a component test that only covers the
# empty state cannot see a crash in the populated state.
#
# WHY A RATCHET RATHER THAN ZERO
#
# These projects were never typechecked, so they carry pre-existing errors
# unrelated to this work. Demanding zero would either block every PR or invite
# `// @ts-ignore`, which hides the real number. A ratchet cannot be gamed upward.
#
# The UNBOUND-IDENTIFIER count (TS2304) is held at a HARD ZERO separately,
# because that class is always a crash and never a style question.
#
# Usage:
#   ./bin/i18n-plugin-typecheck-guard.sh           # check against baseline
#   ./bin/i18n-plugin-typecheck-guard.sh --update  # accept the current count
#   ./bin/i18n-plugin-typecheck-guard.sh --list    # print every error
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/bin/i18n-plugin-typecheck-guard.baseline"
TSCONFIG="$ROOT_DIR/bin/tsconfig/plugins-frontend.json"

cd "$ROOT_DIR" || exit 1

OUT=$(npx tsc --noEmit -p "$TSCONFIG" 2>&1 || true)
TOTAL=$(printf '%s\n' "$OUT" | grep -c 'error TS' || true)
# TS2304 = "Cannot find name 'x'". Always a crash at runtime.
UNBOUND=$(printf '%s\n' "$OUT" | grep -c 'error TS2304' || true)

case "${1:-}" in
  --list) printf '%s\n' "$OUT" | grep 'error TS' || echo '(no errors)'; exit 0 ;;
  --count) echo "$TOTAL"; exit 0 ;;
  --update)
    echo "$TOTAL" > "$BASELINE_FILE"
    echo "[plugin-tsc] baseline updated to $TOTAL"
    exit 0 ;;
esac

BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || echo 999999)
echo "[plugin-tsc] plugin frontend type errors: $TOTAL (baseline $BASELINE)"
echo "[plugin-tsc] unbound identifiers (TS2304): $UNBOUND (must be 0)"

FAIL=0

# Hard zero: an unbound identifier is a guaranteed runtime crash on the path
# that references it. There is no version of this worth tolerating.
if [ "$UNBOUND" -gt 0 ]; then
  echo "[plugin-tsc] FAIL — $UNBOUND unbound identifier(s). Each one throws"
  echo "             ReferenceError when its component renders. Usually a t()"
  echo "             call in a component that never destructured it from"
  echo "             useI18n() — note that a nested component does NOT inherit"
  echo "             its parent's binding and needs its own hook call."
  printf '%s\n' "$OUT" | grep 'error TS2304' | sed 's/^/             /'
  FAIL=1
fi

if [ "$TOTAL" -gt "$BASELINE" ]; then
  echo "[plugin-tsc] FAIL — total grew by $((TOTAL - BASELINE)). Run --list."
  FAIL=1
elif [ "$TOTAL" -lt "$BASELINE" ]; then
  echo "[plugin-tsc] total decreased by $((BASELINE - TOTAL)). Run --update to lock it in."
fi

[ "$FAIL" -eq 0 ] && echo '[plugin-tsc] PASS'
exit "$FAIL"
