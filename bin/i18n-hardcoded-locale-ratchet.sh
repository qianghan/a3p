#!/usr/bin/env bash
# =============================================================================
# i18n ratchet #3: hardcoded 'en-US' in plugin frontends
# =============================================================================
# WHY THIS EXISTS — AND WHY IT SHOULD HAVE EXISTED ALREADY
#
# bin/i18n-string-ratchet.sh carries this comment, next to its date measure:
#
#     "Number formatting is tracked by the hardcoded-locale count above
#      instead."
#
# There was no such count. The comment named a measure that did not exist, and
# read as reassurance that this class was covered. It was not: 25 call sites
# across the plugin frontends pass a literal 'en-US' to Intl.NumberFormat or
# toLocaleDateString, so money and dates render in US format for every user
# regardless of locale. This file is that missing count.
#
# WHY IT MATTERS MORE THAN A MISSING TRANSLATION
#
# Formatting is deliberately NOT behind the i18n feature flag — it follows the
# tenant locale unconditionally, because getting it wrong is a correctness bug
# rather than an absent feature. A hardcoded 'en-US' therefore cannot be
# excused as "waiting for the rollout"; it is wrong output, shipped, today:
#
#     Intl.NumberFormat('en-US', {currency:'CAD'})  ->  "$1,234.56"
#     Intl.NumberFormat('fr-CA', {currency:'CAD'})  ->  "1 234,56 $"
#
# A Quebec freelancer reading an invoice total sees the wrong one.
#
# THE FIX AT A CALL SITE
#
# Inside a component, take the formatter off the shell — it is already bound to
# the resolved locale:
#
#     const { formatCurrency, formatDateOnly } = useI18n();
#
# Outside a component, thread the locale in and use the helpers in
# packages/agentbook-i18n/src/formatters.ts. Do NOT reach for the bare
# formatMoney(cents, currency) helper to "fix" a locale problem: it INFERS a
# display locale from the currency code, which is a fallback for call sites
# that genuinely have no locale, and using it where a locale is available
# reintroduces this bug in a less visible form.
#
# Usage:
#   ./bin/i18n-hardcoded-locale-ratchet.sh           # check against baseline
#   ./bin/i18n-hardcoded-locale-ratchet.sh --update  # accept current count
#   ./bin/i18n-hardcoded-locale-ratchet.sh --count   # print the number only
#   ./bin/i18n-hardcoded-locale-ratchet.sh --list    # show every call site
#
# Exit codes: 0 = count <= baseline, 1 = regression.
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$ROOT_DIR/bin/i18n-hardcoded-locale-ratchet.baseline"

PLUGINS=(
  agentbook-core
  agentbook-billing
  agentbook-expense
  agentbook-invoice
  agentbook-startup
  agentbook-tax
)

# Any literal 'en-US' / "en-US" in non-test frontend source. Deliberately broad:
# unlike the JSX-expression measure this one has essentially no false-positive
# surface, because there is no legitimate reason for a plugin page to name a
# display locale.
matches() {
  for p in "${PLUGINS[@]}"; do
    local dir="$ROOT_DIR/plugins/$p/frontend/src"
    [ -d "$dir" ] || continue
    grep -rn --include='*.tsx' --include='*.ts' -E "['\"]en-US['\"]" "$dir" 2>/dev/null \
      | grep -v '__tests__' \
      | grep -v '\.test\.' \
      `# Skip COMMENT lines. Without this the measure counts its own
       # documentation: the comments explaining each fix mention 'en-US', so
       # fixing a call site and writing down why could leave the number
       # unchanged — and the count could be "reduced" by deleting comments,
       # which is exactly backwards.` \
      | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' \
      | sed "s|^$ROOT_DIR/||"
  done
}

COUNT=$(matches | wc -l | tr -d ' ')

case "${1:-}" in
  --count) echo "$COUNT"; exit 0 ;;
  --list)  matches; echo "--- $COUNT ---"; exit 0 ;;
  --update)
    echo "$COUNT" > "$BASELINE_FILE"
    echo "[locale-ratchet] baseline updated to $COUNT"
    exit 0 ;;
esac

BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || echo 999999)
echo "[locale-ratchet] hardcoded 'en-US' in plugin frontends: $COUNT (baseline $BASELINE)"

if [ "$COUNT" -gt "$BASELINE" ]; then
  echo "[locale-ratchet] FAIL — increased by $((COUNT - BASELINE)). A new call site"
  echo "                 formats money or dates in US format for every user."
  echo "                 Run --list to see them; take the formatter off useI18n()."
  exit 1
fi
if [ "$COUNT" -lt "$BASELINE" ]; then
  echo "[locale-ratchet] PASS — decreased by $((BASELINE - COUNT)). Run --update to lock it in."
else
  echo "[locale-ratchet] PASS — unchanged."
fi
exit 0
