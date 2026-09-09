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
# THE SHELL HAS THE SAME PROBLEM ONE LEVEL UP
#
# The shell legitimately holds a catalog, but not ALL of it. Four namespaces —
# bot, skill, proactive, rate — are reached only from the server: `bot` alone
# is 76.6 kB of raw Telegram copy across three locales. They are excluded via
# '@agentbook/i18n/catalog-client', and --shell asserts that exclusion against
# the built chunks rather than against the source.
#
# It is checked here, on the artifact, because the source-level version of this
# check has already been fooled once. Cutting the namespaces out while leaving
# a single `AVAILABLE_LOCALES` import behind — a value computed as
# Object.keys(CATALOG), and therefore retaining all of it — produced a build
# carrying BOTH catalogs, and every route grew by 3-4 kB. The route table did
# not say why. Grepping the chunks does.
#
# Usage:
#   ./bin/i18n-bundle-guard.sh            # check committed CDN bundles
#   ./bin/i18n-bundle-guard.sh --dist     # check freshly built dist/production
#   ./bin/i18n-bundle-guard.sh --shell    # check apps/web-next/.next client chunks
#
# Exit codes:
#   0 = no catalog content found where it should not be
#   1 = a catalog leaked into at least one bundle
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Every plugin that ships a UMD bundle. The four newer ones now call t() too,
# so they can leak the catalog exactly as the original six could — and a leak
# is 19KB of locale data in every bundle, per bundle.
PLUGINS=(
  agentbook-core
  agentbook-billing
  agentbook-expense
  agentbook-invoice
  agentbook-startup
  agentbook-tax
  agentbook-scholarship
  agentbook-housing
  agentbook-career
  community
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

# -----------------------------------------------------------------------------
# --shell: the server-only packs must not be in any client chunk.
# -----------------------------------------------------------------------------
# Markers are ASCII on purpose. The minifier escapes non-ASCII in some chunks,
# so a French or Chinese marker can be absent from the text while present in
# the bundle — a guard that reports a false PASS is worse than no guard.
# Each is verified unique to a server-only namespace by
# apps/web-next/src/__tests__/architecture/i18n-client-catalog.test.ts.
SERVER_ONLY_MARKERS=(
  "No recent expense to categorize"                             # bot
  "No compatible students found yet."                           # skill
  "bank transactions this week without receipts"                # proactive
  "You're sending messages very fast. Try again in a minute."   # rate
)

if [ "$MODE" = '--shell' ]; then
  CHUNK_DIR="$ROOT_DIR/apps/web-next/.next/static/chunks"
  if [ ! -d "$CHUNK_DIR" ]; then
    echo "[bundle-guard] FAIL — $CHUNK_DIR not found, so this proved nothing."
    echo "[bundle-guard] Run 'npx next build' in apps/web-next first."
    exit 1
  fi
  n_chunks=$(find "$CHUNK_DIR" -name '*.js' | wc -l | tr -d ' ')
  if [ "$n_chunks" -lt 10 ]; then
    echo "[bundle-guard] FAIL — only $n_chunks chunks found; the build looks incomplete."
    exit 1
  fi

  # Sanity-check the grep itself against a string that MUST be present, so a
  # broken search cannot masquerade as a clean result.
  if ! grep -rqF "Expenses" "$CHUNK_DIR" 2>/dev/null; then
    echo "[bundle-guard] FAIL — could not find a known client string in the"
    echo "[bundle-guard] chunks. The search is broken, not the bundle."
    exit 1
  fi

  shell_fail=0
  for marker in "${SERVER_ONLY_MARKERS[@]}"; do
    hits=$(grep -rlF "$marker" "$CHUNK_DIR" 2>/dev/null | head -3)
    if [ -n "$hits" ]; then
      echo "[bundle-guard] FAIL — server-only catalog copy is in a client chunk:"
      echo "                 marker: $marker"
      printf '                 %s\n' $hits
      shell_fail=1
    fi
  done

  if [ "$shell_fail" -ne 0 ]; then
    echo ""
    echo "[bundle-guard] A server-only namespace reached the browser. Something"
    echo "[bundle-guard] client-side imports '@agentbook/i18n/catalog' — directly,"
    echo "[bundle-guard] or through a value derived from CATALOG such as"
    echo "[bundle-guard] AVAILABLE_LOCALES or offerableLocales(). Import from"
    echo "[bundle-guard] '@agentbook/i18n/catalog-client' instead."
    exit 1
  fi
  echo "[bundle-guard] PASS — $n_chunks client chunks checked, no server-only packs."
  exit 0
fi


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
