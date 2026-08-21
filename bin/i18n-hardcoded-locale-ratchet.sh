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
# A SECOND, QUIETER FORM OF THE SAME BUG
#
# formatMoney(cents, currency) has no 'en-US' literal in it, so the grep below
# would never have found it — but it INFERS a display locale from the currency
# code, which produces exactly the same wrong output:
#
#     formatMoney(123456, 'CAD')  ->  en-CA  ->  "$1,234.56"
#     correct for a fr-CA reader             ->  "1 234,56 $"
#
# That helper is right only where no locale exists at all. Inside a plugin
# component a locale is ALWAYS available via useI18n(), so every call there is
# locale-blind. This is not hypothetical: while fixing the invoice plugin I
# added a `locale` parameter to Estimates' formatCurrency, threaded it through
# every call site, and left the body calling formatMoney — the parameter was
# accepted and ignored, and the fix was cosmetic. The measure below counts this
# class too, so the same mistake fails CI instead of reading as done.
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

# Scope widened to the SHELL and every plugin frontend. This measure, like the
# string ratchet, previously covered only six plugin directories — so its number
# described the directories it scanned rather than the product. See the comment
# in bin/i18n-string-ratchet.sh for what that cost.
SCAN_DIRS=(
  "plugins/agentbook-core/frontend/src"
  "plugins/agentbook-billing/frontend/src"
  "plugins/agentbook-expense/frontend/src"
  "plugins/agentbook-invoice/frontend/src"
  "plugins/agentbook-startup/frontend/src"
  "plugins/agentbook-tax/frontend/src"
  "plugins/agentbook-scholarship/frontend/src"
  "plugins/agentbook-housing/frontend/src"
  "plugins/agentbook-career/frontend/src"
  "plugins/community/frontend/src"
  "apps/web-next/src"
)

# Any literal 'en-US' / "en-US" in non-test frontend source. Deliberately broad:
# unlike the JSX-expression measure this one has essentially no false-positive
# surface, because there is no legitimate reason for a plugin page to name a
# display locale.
matches() {
  for rel in "${SCAN_DIRS[@]}"; do
    local dir="$ROOT_DIR/$rel"
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

    # Second class: formatMoney() inside a plugin frontend. No 'en-US' literal,
    # same wrong output — see the header. Import lines are excluded so the
    # import itself is not counted alongside its call sites.
    grep -rn --include='*.tsx' --include='*.ts' 'formatMoney(' "$dir" 2>/dev/null \
      | grep -v '__tests__' \
      | grep -v '\.test\.' \
      | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' \
      | grep -vE ':[0-9]+:[[:space:]]*import' \
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
echo "[locale-ratchet] locale-blind money/date formatting: $COUNT (baseline $BASELINE)"

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
