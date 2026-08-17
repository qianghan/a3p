#!/usr/bin/env bash
# =============================================================================
# i18n bundle guard — keep the locale catalogs OUT of plugin UMD bundles
# =============================================================================
# The architecture injects ONE translator through ShellContext so the shell
# holds a single copy of the translation catalog and the six CDN plugin bundles
# hold none.
#
# This guard exists because that promise broke once, silently. Putting CATALOG
# in the same barrel as formatMoney meant all 21 plugin call sites that import
# formatMoney inlined all three locale packs: +18.8 KB per bundle, ~113 KB of
# duplicated strings across six bundles. Nothing failed — the bundles just got
# bigger, which no test noticed. The fix was to move the catalog behind
# '@agentbook/i18n/catalog'.
#
# A size threshold alone would be a weak check (bundles legitimately grow), so
# the primary assertion is CONTENT: known catalog strings must not appear in any
# plugin bundle. That fails loudly and specifically.
#
# Usage:
#   ./bin/i18n-bundle-guard.sh            # check committed CDN bundles
#   ./bin/i18n-bundle-guard.sh --dist     # check freshly built dist/production
#
# Exit codes:
#   0 = no catalog content found in any plugin bundle
#   1 = a catalog leaked into at least one bundle
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGINS=(
  agentbook-core
  agentbook-billing
  agentbook-expense
  agentbook-invoice
  agentbook-startup
  agentbook-tax
)

# Distinctive strings that exist ONLY in the locale packs. Chosen to be
# unmistakable: if any of these is in a plugin bundle, a catalog came with it.
# Keep in step with packages/agentbook-i18n/src/locales/*.
CATALOG_MARKERS=(
  '已达每日消息上限'
  '您发送消息的速度过快'
  'Limite quotidienne atteinte'
  'Reçu enregistré'
)

MODE="${1:-}"
FAIL=0
CHECKED=0

for p in "${PLUGINS[@]}"; do
  if [ "$MODE" = "--dist" ]; then
    bundle="$ROOT_DIR/plugins/$p/frontend/dist/production/$p.js"
  else
    bundle="$ROOT_DIR/apps/web-next/public/cdn/plugins/$p/$p.js"
  fi
  [ -f "$bundle" ] || { echo "[bundle-guard] skip $p (no bundle at $bundle)"; continue; }
  CHECKED=$((CHECKED + 1))

  hits=""
  for marker in "${CATALOG_MARKERS[@]}"; do
    if grep -qF "$marker" "$bundle" 2>/dev/null; then
      hits="${hits}      found: ${marker}\n"
    fi
  done

  size=$(wc -c < "$bundle" | tr -d ' ')
  if [ -n "$hits" ]; then
    echo "[bundle-guard] FAIL $p ($size bytes) — locale catalog is inlined:"
    printf '%b' "$hits"
    FAIL=1
  else
    printf "[bundle-guard] ok   %-20s %s bytes\n" "$p" "$size"
  fi
done

if [ "$CHECKED" -eq 0 ]; then
  echo "[bundle-guard] FAIL — no bundles were checked, so this proved nothing."
  echo "[bundle-guard] Build the plugins first, or point at the committed CDN copies."
  exit 1
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "[bundle-guard] A plugin bundled the translation catalog."
  echo "[bundle-guard] Plugins must import functions from '@agentbook/i18n' and"
  echo "[bundle-guard] receive strings via ShellContext (SDK useI18n()). Only the"
  echo "[bundle-guard] shell may import '@agentbook/i18n/catalog'."
  exit 1
fi

echo "[bundle-guard] PASS — $CHECKED bundle(s) checked, no catalog content found."
exit 0
