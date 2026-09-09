#!/usr/bin/env bash
# =============================================================================
# CONFIG DOCTOR — the launch config nobody can verify by reading a file
# =============================================================================
# Four settings gate the launch score, and none of them lives in the repo:
# two Actions/Vercel secrets that must hold the SAME value in two places, a
# Sentry DSN, and a database row. Every one of them fails silently:
#
#   - a CRON_SECRET mismatch looks exactly like a broken cron
#   - an unset E2E_RESET_TOKEN looks exactly like a flaky test
#   - an unset SENTRY_DSN looks exactly like "no errors happened"
#   - the i18n flag off looks exactly like "translation is not finished"
#
# So this checks each one from the outside and says which. It needs no secrets
# to run and reports what it can; give it the optional inputs below and it can
# prove the two-copies-in-sync cases, which is the whole difficulty.
#
# Usage
#   ./bin/config-doctor.sh
#   CRON_SECRET=... ./bin/config-doctor.sh          # proves the secret MATCHES
#   DATABASE_URL=...  ./bin/config-doctor.sh        # reads the i18n flag
#   BASE_URL=https://staging... ./bin/config-doctor.sh
#
# Exit code is the number of FAILing checks, so CI or a shell loop can use it.
# =============================================================================
set -uo pipefail
BASE_URL="${BASE_URL:-https://agentbook.brainliber.com}"
FAILED=0
SKIPPED=0

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; off=$'\033[0m'
pass() { printf "  ${grn}PASS${off}  %s\n" "$1"; }
fail() { printf "  ${red}FAIL${off}  %s\n" "$1"; [ -n "${2:-}" ] && printf "        ${dim}%s${off}\n" "$2"; FAILED=$((FAILED+1)); }
skip() { printf "  ${yel}SKIP${off}  %s\n" "$1"; [ -n "${2:-}" ] && printf "        ${dim}%s${off}\n" "$2"; SKIPPED=$((SKIPPED+1)); }
head_() { printf "\n${bold}%s${off}\n" "$1"; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000; }

echo "${bold}Config doctor${off} — ${BASE_URL}"

# ── 1. the deployment answers at all ─────────────────────────────────────────
head_ "1 · Deployment"
H=$(code "$BASE_URL/api/health")
[ "$H" = "200" ] && pass "/api/health -> 200" \
  || fail "/api/health -> $H" "everything below is meaningless until this is 200"

# ── 2. CRON_SECRET ───────────────────────────────────────────────────────────
# The hard one. Both halves must hold ONE value: Vercel (so the deployment
# accepts it) and the GitHub Actions secret (so the nightly can send it).
# Unauthenticated 401 only proves the deployment has *a* secret, not that it is
# the same one, which is why the nightly can be red while this looks fine.
head_ "2 · CRON_SECRET  (must be the same value in Vercel AND Actions)"
C=$(code "$BASE_URL/api/v1/agentbook/cron/morning-digest")
[ "$C" = "401" ] && pass "unauthenticated cron -> 401 (deployment has a secret set)" \
  || fail "unauthenticated cron -> $C, expected 401" "the cron routes are fail-open or the deployment has no secret"

if [ -n "${CRON_SECRET:-}" ]; then
  A=$(code -H "Authorization: Bearer ${CRON_SECRET}" "$BASE_URL/api/v1/agentbook/cron/morning-digest")
  if [ "$A" = "200" ]; then
    pass "authenticated cron -> 200 — the value you supplied MATCHES the deployment"
  else
    fail "authenticated cron -> $A, expected 200" \
         "the value in your shell is not the one on the deployment. Set BOTH sides from one value."
  fi
else
  skip "cannot prove the two copies match" \
       "re-run as: CRON_SECRET='<the value you set>' ./bin/config-doctor.sh"
fi

if command -v gh >/dev/null 2>&1; then
  for s in CRON_SECRET E2E_RESET_TOKEN E2E_BASE_URL E2E_USER_EMAIL E2E_USER_PASSWORD; do
    if gh secret list 2>/dev/null | grep -q "^${s}\b"; then
      pass "Actions secret ${s} exists"
    else
      fail "Actions secret ${s} is missing" "gh secret set ${s}"
    fi
  done
else
  skip "gh not installed — cannot list Actions secrets"
fi

# ── 3. Sentry ────────────────────────────────────────────────────────────────
# NEXT_PUBLIC_SENTRY_DSN is inlined at BUILD time, so its presence is visible
# in the deployed client bundle. That is the only externally checkable signal —
# a /monitoring probe is useless here, because this app serves a 200 HTML shell
# for unmatched routes (verified: a nonsense path also returns 200).
head_ "3 · Sentry"
CHUNKS=$(curl -s --max-time 20 "$BASE_URL/" 2>/dev/null | grep -oE '/_next/static/chunks/[A-Za-z0-9._-]+\.js' | sort -u | head -8)
if [ -z "$CHUNKS" ]; then
  skip "could not read the landing page's chunk list"
else
  HITS=0
  while read -r c; do
    [ -z "$c" ] && continue
    n=$(curl -s --max-time 20 "$BASE_URL$c" 2>/dev/null | grep -coE 'ingest\.[a-z.]*sentry\.io|@sentry/' || true)
    HITS=$((HITS + n))
  done <<< "$CHUNKS"
  if [ "$HITS" -gt 0 ]; then
    pass "browser SDK present in the deployed bundle (NEXT_PUBLIC_SENTRY_DSN was set at build time)"
  else
    fail "no Sentry in the deployed client bundle" \
         "NEXT_PUBLIC_SENTRY_DSN is inlined at BUILD time — set it, then REDEPLOY. Setting it alone changes nothing."
  fi
fi

# ── 4. dependency health ─────────────────────────────────────────────────────
# /api/health/deep is what an EXTERNAL monitor should poll, so the useful
# question here is not "is it 200" — it is what the body says about the
# dependencies, including the ones that are simply not configured. Those do
# not turn the endpoint red on purpose (a feature nobody enabled is not an
# outage), which means nothing else would ever tell you about them.
head_ "4 · Dependency health  (/api/health/deep)"
BODY=$(curl -s --max-time 20 "$BASE_URL/api/health/deep" 2>/dev/null)
if [ -z "$BODY" ]; then
  fail "no response from /api/health/deep" "the endpoint ships in this repo — is the deployment current?"
else
  OVERALL=$(printf '%s' "$BODY" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)
  case "$OVERALL" in
    healthy)   pass "overall: healthy" ;;
    degraded)  fail "overall: degraded" "a non-critical dependency is down — see the per-check list below" ;;
    unhealthy) fail "overall: UNHEALTHY" "a critical dependency is down; the product is broken for users" ;;
    *)         fail "unrecognised health response" "expected status healthy|degraded|unhealthy" ;;
  esac
  # One line per probe, so an unconfigured optional shows up even on a green run.
  printf '%s' "$BODY" \
    | tr '{' '\n' \
    | sed -n 's/.*"name":"\([a-z_]*\)","status":"\([a-z]*\)".*/  \1: \2/p' \
    | while read -r line; do
        case "$line" in
          *": ok") printf "        ${dim}%s${off}\n" "$line" ;;
          *)       printf "        ${yel}%s${off}\n" "$line" ;;
        esac
      done
fi

# ── 5. i18n locale flag ──────────────────────────────────────────────────────
head_ "5 · fr-CA / zh-CN locale flag"
if [ -n "${DATABASE_URL:-}" ]; then
  OUT=$(DATABASE_URL="$DATABASE_URL" npx --yes tsx bin/i18n-flip-flag.ts --status 2>&1 | tail -3)
  if printf '%s' "$OUT" | grep -qiE '\bon\b|enabled.*true'; then
    pass "agentbook.i18n.locales.enabled is ON"
  else
    fail "agentbook.i18n.locales.enabled is OFF or absent" \
         "DATABASE_URL=... npx tsx bin/i18n-flip-flag.ts --on"
  fi
  printf "        ${dim}%s${off}\n" "$(printf '%s' "$OUT" | tr '\n' ' ')"
else
  skip "no DATABASE_URL — cannot read the flag" \
       "re-run as: DATABASE_URL='<prod url>' ./bin/config-doctor.sh"
fi

# ── summary ──────────────────────────────────────────────────────────────────
printf "\n${bold}%s${off}\n" "$FAILED failing, $SKIPPED unchecked"
[ "$SKIPPED" -gt 0 ] && printf "${dim}Unchecked is not passing — supply the optional inputs above to close them.${off}\n"
exit "$FAILED"
