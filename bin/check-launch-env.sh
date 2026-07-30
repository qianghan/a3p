#!/usr/bin/env bash
#
# Launch-critical environment check.
#
# Fails a PRODUCTION build when a variable whose absence breaks a core user
# journey is missing. Build time is the right place to be strict: a
# misconfigured deploy never goes live, and — unlike a runtime assertion — a
# already-running site can never be crash-looped by it.
#
# Several of these fail SILENTLY at runtime (no error, the feature just quietly
# doesn't work), which is exactly why they need a gate:
#   RESEND_API_KEY        → no email is sent; signup is gated on verification,
#                           so NO new user can complete registration
#   GEMINI_API_KEY        → receipt OCR stops extracting; the assistant silently
#                           degrades to pattern matching
#   STRIPE_WEBHOOK_SECRET → cards charge but invoices never mark paid and never
#                           reach the ledger
#   CRON_SECRET           → every scheduled job 401s (the gates fail closed)
#   INTERNAL_ADMIN_SECRET → agent skill registration 401s (fails closed)
#
# Escape hatch: ALLOW_MISSING_LAUNCH_ENV=1 downgrades the failure to a warning
# for a deliberate partial deploy (e.g. a staging-style production without
# billing). Use it knowingly, not habitually.
set -uo pipefail

# key|what breaks without it
#
# NEXTAUTH_SECRET is deliberately NOT here: next-auth is not a dependency and
# production sessions are opaque crypto.randomBytes tokens stored in the DB, so
# nothing on the deployed Next.js path reads it (it's used only by the dev-api
# token-encryption helper and the standalone Express plugin SDK). It is in fact
# unset in production today — gating on it would fail every deploy for a
# variable that does nothing. See lib/env.ts for the matching note.
CHECKS=(
  "DATABASE_URL|everything — no database connection"
  "RESEND_API_KEY|email delivery — signup verification is gated on it, so no new user can register (SILENT)"
  "GEMINI_API_KEY|receipt OCR and assistant quality (SILENT degradation)"
  "STRIPE_SECRET_KEY|billing entirely"
  "STRIPE_WEBHOOK_SECRET|payment reconciliation — cards charge but invoices never mark paid"
  "CRON_SECRET|all scheduled jobs — they now fail closed and return 401"
  "INTERNAL_ADMIN_SECRET|agent skill registration — now fails closed"
)

if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "[launch-env] Skipping (VERCEL_ENV=${VERCEL_ENV:-unset}; production only)"
  exit 0
fi

missing=()
for entry in "${CHECKS[@]}"; do
  key="${entry%%|*}"
  why="${entry#*|}"
  # Indirect expansion: empty or unset both count as missing.
  if [ -z "${!key:-}" ]; then
    missing+=("  • ${key} — ${why}")
  fi
done

if [ ${#missing[@]} -eq 0 ]; then
  echo "[launch-env] All ${#CHECKS[@]} launch-critical variables are set ✓"
  exit 0
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " LAUNCH-CRITICAL ENVIRONMENT VARIABLES MISSING (${#missing[@]})"
echo "════════════════════════════════════════════════════════════════"
printf '%s\n' "${missing[@]}"
echo ""
echo " Set them in Vercel → Settings → Environment Variables (Production),"
echo " then redeploy. Items marked SILENT fail without any visible error,"
echo " which is why this build stops instead of shipping them."
echo ""

if [ "${ALLOW_MISSING_LAUNCH_ENV:-}" = "1" ]; then
  echo "[launch-env] ALLOW_MISSING_LAUNCH_ENV=1 — continuing anyway (deliberate partial deploy)."
  exit 0
fi

echo " To deploy anyway (knowingly), re-run with ALLOW_MISSING_LAUNCH_ENV=1."
echo "════════════════════════════════════════════════════════════════"
exit 1
