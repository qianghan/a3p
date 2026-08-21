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

# JSX text nodes, on ONE line and spanning several.
#
# The first version matched only single-line `>Text<` and therefore reported a
# clean zero while thirteen multi-line nodes — `>\n  Description\n<` — still
# rendered English over an existing translation. A hard-zero guard that cannot
# see a common shape is worse than a ratchet, because the zero is believed.
CHARS = r"[A-Za-z0-9 ,.'!?%$&()/:—–-]"
TEXT = re.compile(r'>\s*([A-Z]' + CHARS + r'{2,}?)\s*<', re.S)

found = []
# The SHELL plus every plugin frontend. Restricting this to six plugin
# directories is what let 883 shell literals — the sidebar, the tab bars, every
# settings page — sit outside every measure while the numbers looked finished.
ROOTS = [Path('apps/web-next/src')] + sorted(Path('plugins').glob('*/frontend/src'))

def all_tsx():
    for root in ROOTS:
        yield from root.rglob('*.tsx')

for p in all_tsx():
    sp = str(p)
    if '__tests__' in sp or sp.endswith('.test.tsx') or '/dist/' in sp:
        continue
    text = p.read_text(encoding='utf-8', errors='ignore')
    for m in TEXT.finditer(text):
        val = m.group(1).strip()
        if val in en:
            line = text[:m.start()].count('\n') + 1
            found.append(f'{sp}:{line}  "{val}"  -> t(\'{en[val]}\')')

# The HARD ZERO applies to the six plugins that have actually been migrated.
# The shell and the newer plugins (career, housing, community, scholarship) were
# outside every measure until now and are ratcheted instead — holding them to
# zero today would only mean switching the guard off.
#
# Those four also produce cross-namespace coincidences: housing's "Australia"
# matching tax_ui.australia, community's "Pinned" matching core_ui.pinned. Using
# a tax key on a roommate panel would couple unrelated products to satisfy a
# check. They need their own namespaces.
MIGRATED = ('agentbook-core', 'agentbook-billing', 'agentbook-expense',
            'agentbook-invoice', 'agentbook-startup', 'agentbook-tax')
plugin = [f for f in found
          if f.startswith('plugins/') and f.split('/')[1] in MIGRATED]
shell = [f for f in found if f not in plugin]
for f in plugin:
    print(f'PLUGIN {f}')
for f in shell:
    print(f'SHELL  {f}')
print(f'PLUGIN_COUNT={len(plugin)}')
print(f'SHELL_COUNT={len(shell)}')

PY
)

PLUGIN_COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^PLUGIN_COUNT=//p')
SHELL_COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^SHELL_COUNT=//p')
SHELL_BASELINE=$(cat "$ROOT_DIR/bin/i18n-unwired-key-guard.shell.baseline" 2>/dev/null || echo 999999)

echo "[unwired-keys] plugins: ${PLUGIN_COUNT:-0} (must be 0)"
echo "[unwired-keys] shell:   ${SHELL_COUNT:-0} (baseline $SHELL_BASELINE)"

if [ "${1:-}" = '--list' ]; then
  printf '%s\n' "$OUT" | grep -E '^(PLUGIN|SHELL) ' | sed 's/^/               /'
fi

if [ "${1:-}" = '--update' ]; then
  echo "${SHELL_COUNT:-0}" > "$ROOT_DIR/bin/i18n-unwired-key-guard.shell.baseline"
  echo "[unwired-keys] shell baseline updated to ${SHELL_COUNT:-0}"
  exit 0
fi

FAIL=0

# HARD ZERO for the plugins. They reached zero and must not regress: each of
# these is a one-line change with the French and Chinese already written.
if [ "${PLUGIN_COUNT:-0}" -gt 0 ]; then
  echo "[unwired-keys] FAIL — a plugin literal has a translation that is not"
  echo "               being rendered. Run --list; replace the literal with the"
  echo "               t() call shown. No new translation work is needed."
  printf '%s\n' "$OUT" | grep '^PLUGIN ' | sed 's/^/               /'
  FAIL=1
fi

# RATCHET for the shell, whose migration is in flight. Deliberately not a hard
# zero yet: the shell was outside every measure until this change, and holding
# it to zero today would just mean turning the guard off. It may only fall.
if [ "${SHELL_COUNT:-0}" -gt "$SHELL_BASELINE" ]; then
  echo "[unwired-keys] FAIL — shell count grew by $(( SHELL_COUNT - SHELL_BASELINE ))."
  FAIL=1
elif [ "${SHELL_COUNT:-0}" -lt "$SHELL_BASELINE" ]; then
  echo "[unwired-keys] shell decreased by $(( SHELL_BASELINE - SHELL_COUNT )). Run --update to lock it in."
fi

[ "$FAIL" -eq 0 ] && echo '[unwired-keys] PASS'
exit "$FAIL"
