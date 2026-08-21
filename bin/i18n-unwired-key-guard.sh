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

# React Server Components are reported SEPARATELY, because for them this
# guard's central claim — "replace the literal with the t() call shown, it is a
# one-line change" — is false. t() comes from a React hook, and a Server
# Component cannot call one. The fix is either a request-scoped server
# translator or a conversion to a client component: a design decision, not a
# substitution.
#
# Lumping them in with the client components made the shell number unactionable
# and, worse, meant that adding a legitimate key whose English happened to match
# a literal on a marketing page (admin_ui.plan vs the "Plan" column of the
# pricing table in guides/) failed the ratchet with no correct fix available.
#
# They are still COUNTED and still ratcheted — just in their own bucket, so
# neither number can hide behind the other.
def is_rsc(entry):
    path = Path(entry.split(':')[0])
    if not str(path).startswith('apps/web-next/src/app/'):
        return False  # only route files are server components by default
    head = path.read_text(encoding='utf-8', errors='ignore')[:400]
    return "'use client'" not in head and '"use client"' not in head

rest = [f for f in found if f not in plugin]
rsc = [f for f in rest if is_rsc(f)]
shell = [f for f in rest if f not in rsc]
for f in plugin:
    print(f'PLUGIN {f}')
for f in shell:
    print(f'SHELL  {f}')
for f in rsc:
    print(f'RSC    {f}')
print(f'PLUGIN_COUNT={len(plugin)}')
print(f'SHELL_COUNT={len(shell)}')
print(f'RSC_COUNT={len(rsc)}')

PY
)

PLUGIN_COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^PLUGIN_COUNT=//p')
SHELL_COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^SHELL_COUNT=//p')
RSC_COUNT=$(printf '%s\n' "$OUT" | sed -n 's/^RSC_COUNT=//p')
SHELL_BASELINE=$(cat "$ROOT_DIR/bin/i18n-unwired-key-guard.shell.baseline" 2>/dev/null || echo 999999)
RSC_BASELINE=$(cat "$ROOT_DIR/bin/i18n-unwired-key-guard.rsc.baseline" 2>/dev/null || echo 999999)

echo "[unwired-keys] plugins: ${PLUGIN_COUNT:-0} (must be 0)"
echo "[unwired-keys] shell:   ${SHELL_COUNT:-0} (baseline $SHELL_BASELINE)"
echo "[unwired-keys] server:  ${RSC_COUNT:-0} (baseline $RSC_BASELINE) — needs a server translator, not a t() call"

if [ "${1:-}" = '--list' ]; then
  printf '%s\n' "$OUT" | grep -E '^(PLUGIN|SHELL|RSC) ' | sed 's/^/               /'
fi

if [ "${1:-}" = '--update' ]; then
  echo "${SHELL_COUNT:-0}" > "$ROOT_DIR/bin/i18n-unwired-key-guard.shell.baseline"
  echo "${RSC_COUNT:-0}" > "$ROOT_DIR/bin/i18n-unwired-key-guard.rsc.baseline"
  echo "[unwired-keys] baselines updated to shell=${SHELL_COUNT:-0} server=${RSC_COUNT:-0}"
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

# RATCHET for the server components, for the reason given in the classifier
# above: real, counted, but not fixable by substitution.
if [ "${RSC_COUNT:-0}" -gt "$RSC_BASELINE" ]; then
  echo "[unwired-keys] FAIL — server-component count grew by $(( RSC_COUNT - RSC_BASELINE ))."
  FAIL=1
elif [ "${RSC_COUNT:-0}" -lt "$RSC_BASELINE" ]; then
  echo "[unwired-keys] server decreased by $(( RSC_BASELINE - RSC_COUNT )). Run --update to lock it in."
fi

[ "$FAIL" -eq 0 ] && echo '[unwired-keys] PASS'
exit "$FAIL"
