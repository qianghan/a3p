#!/usr/bin/env bash
# =============================================================================
# i18n hardcoded-string ratchet
# =============================================================================
# Counts user-facing English string literals still hardcoded in the AgentBook
# plugin frontends, and compares the count to a checked-in baseline.
#
# The count may only ever DECREASE. A ratchet rather than a hard zero, because:
#   - a hard zero would block unrelated PRs that add a legitimate literal
#   - a hard zero invites suppression comments, which hide the real number
# A ratchet cannot be gamed upward and gives the extraction PRs (4-7) a
# mechanical progress signal.
#
# Deliberately a dumb grep, NOT a JSX parser. A parser here would be a second
# thing to maintain and debug; over-counting slightly is harmless as long as
# the measurement is deterministic and the direction of travel is enforced.
#
# Usage:
#   ./bin/i18n-string-ratchet.sh           # print count, check against baseline
#   ./bin/i18n-string-ratchet.sh --update  # accept the current count as baseline
#   ./bin/i18n-string-ratchet.sh --count   # print only the number, no check
#
# Exit codes:
#   0 = count <= baseline (ratchet holds)
#   1 = count > baseline  (regression: new hardcoded strings added)
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/bin/i18n-string-ratchet.baseline"

PLUGINS=(
  agentbook-core
  agentbook-billing
  agentbook-expense
  agentbook-invoice
  agentbook-startup
  agentbook-tax
)

# -----------------------------------------------------------------------------
# Count user-facing literals.
#
# Two patterns, both anchored on things only a human reads:
#   1. JSX text nodes:  >Some Text<
#   2. User-facing props: title= label= placeholder= alt= heading= tooltip=
#
# Excluded by construction: className/aria-*/data-*/id/key/type/name/role
# (not matched by the prop list), test files, and generated output.
# -----------------------------------------------------------------------------
count_literals() {
  local total=0
  for p in "${PLUGINS[@]}"; do
    local dir="$ROOT_DIR/plugins/$p/frontend/src"
    [ -d "$dir" ] || continue

    local files
    files=$(find "$dir" -name '*.tsx' \
              -not -path '*/__tests__/*' \
              -not -name '*.test.tsx' 2>/dev/null)
    [ -n "$files" ] || continue

    # 1. JSX text nodes: > Capitalised words <  (>=3 chars, starts uppercase)
    local jsx_text
    jsx_text=$(echo "$files" | xargs grep -ohE '>[[:space:]]*[A-Z][A-Za-z0-9 ,.'"'"'!?%$&()/:—–-]{2,}[[:space:]]*<' 2>/dev/null | wc -l | tr -d ' ')

    # 2. User-facing string props
    local props
    props=$(echo "$files" | xargs grep -ohE '(title|label|placeholder|alt|heading|tooltip)="[A-Z][^"]{2,}"' 2>/dev/null | wc -l | tr -d ' ')

    total=$((total + jsx_text + props))
  done
  echo "$total"
}

COUNT=$(count_literals)

case "${1:-}" in
  --count)
    echo "$COUNT"
    exit 0
    ;;
  --update)
    echo "$COUNT" > "$BASELINE_FILE"
    echo "[ratchet] baseline updated to $COUNT"
    exit 0
    ;;
esac

if [ ! -f "$BASELINE_FILE" ]; then
  echo "[ratchet] no baseline file at $BASELINE_FILE"
  echo "[ratchet] current count: $COUNT"
  echo "[ratchet] run with --update to establish the baseline"
  exit 1
fi

BASELINE=$(tr -d '[:space:]' < "$BASELINE_FILE")

echo "[ratchet] hardcoded user-facing literals: $COUNT (baseline $BASELINE)"

if [ "$COUNT" -gt "$BASELINE" ]; then
  echo ""
  echo "[ratchet] FAIL — count increased by $((COUNT - BASELINE))."
  echo "[ratchet] New user-facing strings must go through t() and the catalog,"
  echo "[ratchet] not be hardcoded in JSX. See i18n-plan.html section 6, PR 4-7."
  exit 1
fi

if [ "$COUNT" -lt "$BASELINE" ]; then
  echo "[ratchet] PASS — count decreased by $((BASELINE - COUNT)). Run --update to lock it in."
else
  echo "[ratchet] PASS — count unchanged."
fi
exit 0
