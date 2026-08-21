#!/usr/bin/env bash
# =============================================================================
# i18n ratchet #2: user-facing strings inside JSX EXPRESSIONS
# =============================================================================
# WHY THIS EXISTS AS A SEPARATE MEASURE
#
# bin/i18n-string-ratchet.sh matches exactly two shapes: `>Text<` (a JSX text
# node) and `prop="Text"`. It is structurally blind to a third, very common
# shape — a string literal inside a JSX expression container:
#
#     {submitting ? 'Saving…' : editingId ? 'Save' : 'Create'}
#     {showForm ? 'Cancel' : 'Log trip'}
#     {jurisdiction === 'au' ? 'Connect with Basiq' : 'Connect with Plaid'}
#
# This is not a rounding error. Migrating NINE such strings across five expense
# pages moved the original ratchet by exactly ZERO. And the shape is not
# incidental — it is where button labels live, because a button label is
# usually a function of state. Those are the strings a user reads and clicks
# most, so the blind spot was concentrated on the highest-traffic copy in the
# product.
#
# The consequence, and the reason this file exists rather than a comment: the
# original ratchet reads like a completion metric ("293 left") and it is not
# one. Two independent measures are honest; one measure with a silent hole is
# not.
#
# WHY A SEPARATE FILE RATHER THAN A THIRD PATTERN IN THE FIRST SCRIPT
#
# This measure is heuristic in a way the other two are not — a quoted
# capitalised string inside braces is sometimes an enum value, an HTTP header,
# or a lookup-table key rather than user-facing copy. Keeping it separate keeps
# the first ratchet's number clean and makes this one's noise floor explicit
# rather than smuggled into a total.
#
# NOISE FILTER
#
# Only lines containing a ternary (`?`) are considered. That is what removes
# the bulk of the false positives — 'Content-Type': 'application/json' object
# literals, module-level city/rate lookup tables, jurisdiction codes — while
# keeping the state-dependent labels this is meant to catch. It also means the
# measure UNDERCOUNTS in turn; it is a direction-of-travel guard, not a census.
#
# Usage:
#   ./bin/i18n-jsx-expr-ratchet.sh           # check against baseline
#   ./bin/i18n-jsx-expr-ratchet.sh --update  # accept current count
#   ./bin/i18n-jsx-expr-ratchet.sh --count   # print the number only
#   ./bin/i18n-jsx-expr-ratchet.sh --list    # show what it is counting
#
# Exit codes: 0 = count <= baseline, 1 = regression.
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/bin/i18n-jsx-expr-ratchet.baseline"

PLUGINS=(
  agentbook-core
  agentbook-billing
  agentbook-expense
  agentbook-invoice
  agentbook-startup
  agentbook-tax
)

# A quoted, capitalised, >=3-char string on a line that also contains a
# ternary. Excludes lines that already call t(), so migrating a string removes
# it from the count.
matches() {
  for p in "${PLUGINS[@]}"; do
    local dir="$ROOT_DIR/plugins/$p/frontend/src"
    [ -d "$dir" ] || continue
    find "$dir" -name '*.tsx' -not -path '*/__tests__/*' -not -name '*.test.tsx' 2>/dev/null \
      | while IFS= read -r f; do
          grep -nE "\{[^}]*\?[^}]*'[A-Z][A-Za-z0-9 ,.'\''!?%\$&()/:—–…-]{2,}'" "$f" 2>/dev/null \
            | grep -v "t('" \
            | sed "s|^|${f#"$ROOT_DIR/"}:|"
        done
  done
}

COUNT=$(matches | wc -l | tr -d ' ')

case "${1:-}" in
  --count) echo "$COUNT"; exit 0 ;;
  --list)  matches; echo "--- $COUNT ---"; exit 0 ;;
  --update)
    echo "$COUNT" > "$BASELINE_FILE"
    echo "[jsx-expr-ratchet] baseline updated to $COUNT"
    exit 0 ;;
esac

BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || echo 999999)
echo "[jsx-expr-ratchet] user-facing strings in JSX expressions: $COUNT (baseline $BASELINE)"

if [ "$COUNT" -gt "$BASELINE" ]; then
  echo "[jsx-expr-ratchet] FAIL — increased by $((COUNT - BASELINE)). New untranslated"
  echo "                   state-dependent labels. Run --list to see them."
  exit 1
fi
if [ "$COUNT" -lt "$BASELINE" ]; then
  echo "[jsx-expr-ratchet] PASS — decreased by $((BASELINE - COUNT)). Run --update to lock it in."
else
  echo "[jsx-expr-ratchet] PASS — unchanged."
fi
exit 0
