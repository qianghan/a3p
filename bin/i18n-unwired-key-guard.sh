#!/usr/bin/env bash
# =============================================================================
# TRANSLATED BUT NOT RENDERED
# =============================================================================
# Finds hardcoded English literals in plugin source for which a catalog key
# ALREADY EXISTS with exactly that English value.
#
# This is the most wasteful failure mode in the whole effort: the string was
# identified, a key was created, a translator wrote French and Chinese for it,
# the pack shipped — and the component still renders the English literal. All
# of the cost, none of the benefit.
#
# It went unnoticed because no existing check can see it:
#
#   - the catalog invariants check key PARITY across locales, not key USAGE. A
#     key nobody references has perfect parity.
#   - bin/i18n-string-ratchet.sh counts the literal, but only reports a total.
#     "221 remaining" does not distinguish a string awaiting translation from
#     one whose translation is already sitting in the pack unused.
#   - the render tests assert on specific words, so they only catch the strings
#     they happen to name.
#
# It was found by hand, and the worst instance was the expense page's <h1>: a
# French user read "Expenses" while "Dépenses" sat in the fr-CA pack.
#
# This is a HARD ZERO, not a ratchet. Unlike the other measures there is no
# judgement call and no pre-existing-debt argument: if the key exists with that
# exact English value, wiring it up is a one-line change with a translation
# already waiting.
#
# Usage:
#   ./bin/i18n-unwired-key-guard.sh          # fail if any exist
#   ./bin/i18n-unwired-key-guard.sh --list   # same, listing each one
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR" || exit 1

OUT=$(python3 - <<'PY'
import json, re
from pathlib import Path

# English is the reference set: a key's `en` value is the literal to look for.
en = {}
for f in sorted(Path('packages/agentbook-i18n/src/locales/en').glob('*.json')):
    for k, v in json.load(f.open(encoding='utf-8')).items():
        if isinstance(v, str):
            en.setdefault(v, f'{f.stem}.{k}')

# Only literals with NO placeholder: a key like 'Total outstanding: {amount}'
# cannot be swapped for a bare literal without also supplying the parameter,
# which is a judgement call rather than a mechanical fix.
en = {v: k for v, k in en.items() if '{' not in v}

# JSX text nodes only — the same shape the string ratchet counts, so the two
# measures reconcile.
TEXT = re.compile(r'>([A-Z][A-Za-z0-9 ,.\'!?%$&()/:—–-]{2,})<')

found = []
for p in Path('plugins').glob('*/frontend/src/**/*.tsx'):
    sp = str(p)
    if '__tests__' in sp or sp.endswith('.test.tsx') or '/dist/' in sp:
        continue
    text = p.read_text(encoding='utf-8', errors='ignore')
    for m in TEXT.finditer(text):
        val = m.group(1).strip()
        if val in en:
            line = text[:m.start()].count('\n') + 1
            found.append(f'{sp}:{line}  "{val}"  -> t(\'{en[val]}\')')

for f in found:
    print(f)
print(f'COUNT={len(found)}')
PY
)

COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^COUNT=//p')
LIST=$(printf '%s\n' "$OUT" | grep -v '^COUNT=' || true)

echo "[unwired-keys] literals whose translation already exists: ${COUNT:-0}"

if [ "${1:-}" = '--list' ] || [ "${COUNT:-0}" -gt 0 ]; then
  [ -n "$LIST" ] && printf '%s\n' "$LIST" | sed 's/^/               /'
fi

if [ "${COUNT:-0}" -gt 0 ]; then
  echo "[unwired-keys] FAIL — each of these has a French and Chinese translation"
  echo "               sitting unused in the pack. Replace the literal with the"
  echo "               t() call shown; no new translation work is needed."
  exit 1
fi

echo '[unwired-keys] PASS — every existing translation is actually rendered.'
exit 0
