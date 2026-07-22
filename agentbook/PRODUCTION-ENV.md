# AgentBook — Production Environment Configuration

**Generated:** 2026-05-22
**Vercel project:** `qianghans-projects/a3p-plugin-build`
**Production URL:** https://agentbook.brainliber.com

This document tracks every environment variable AgentBook needs in production and preview. As of this date, all variables for the merged PRs (#60 → #74) are set on Vercel except the two flagged with **"USER ACTION REQUIRED."**

---

## Status: 5 of 7 new variables set programmatically

| Variable | Production | Preview | Required by |
|----------|-----------|---------|-------------|
| `INVOICE_PUBLIC_LINK_SECRET` | ✅ Set | ✅ Set | PR 7 — HMAC-signed `/invoices/:id/public` |
| `INTERNAL_ADMIN_SECRET` | ✅ Set | ✅ Set | PR 3 — plugin-side admin gate |
| `BANK_TOKEN_ENCRYPTION_KEY` | ✅ Set (32-byte hex) | ✅ Set (fresh value) | PR 16 — Plaid token AES-256-GCM |
| `ADMIN_EMAILS` | ✅ `admin@a3p.io` | ✅ `admin@a3p.io` | PR 3 — admin role allowlist |
| `LOG_LEVEL` | ✅ `info` | ✅ `debug` | PR 23 — structured logger |
| `BLOB_READ_WRITE_TOKEN` | ⚠️ **USER ACTION** | ⚠️ **USER ACTION** | PR 26 — receipt dropzone uploads |
| `SENTRY_DSN` | Optional — **USER ACTION if wanted** | Optional | PR 23 — Sentry error pipe |

Production-only secrets are encrypted at rest in Vercel; values cannot be re-displayed via dashboard or CLI. If you ever need to rotate, re-run the commands in the "Rotate a secret" section below.

---

## What I set automatically

```bash
# Generated 32 bytes of random base64 for each secret, 32 bytes of hex for the
# bank-token AES-256-GCM key. Production and preview use SEPARATE values so a
# preview-env compromise doesn't expose production data.

# PRODUCTION
echo "$(openssl rand -base64 32)" | vercel env add INVOICE_PUBLIC_LINK_SECRET production
echo "$(openssl rand -base64 32)" | vercel env add INTERNAL_ADMIN_SECRET production
echo "$(openssl rand -hex 32)"    | vercel env add BANK_TOKEN_ENCRYPTION_KEY production
echo -n "admin@a3p.io"            | vercel env add ADMIN_EMAILS production
echo -n "info"                    | vercel env add LOG_LEVEL production

# PREVIEW (separate fresh values)
vercel env add INVOICE_PUBLIC_LINK_SECRET preview "" --value="$(openssl rand -base64 32)" --yes
vercel env add INTERNAL_ADMIN_SECRET     preview "" --value="$(openssl rand -base64 32)" --yes
vercel env add BANK_TOKEN_ENCRYPTION_KEY preview "" --value="$(openssl rand -hex 32)"    --yes
vercel env add ADMIN_EMAILS              preview "" --value="admin@a3p.io"               --yes
vercel env add LOG_LEVEL                 preview "" --value="debug"                       --yes
```

Verify any time with `vercel env ls production` or `vercel env ls preview`.

---

## USER ACTION REQUIRED — 2 variables left

### 1. `BLOB_READ_WRITE_TOKEN` — receipt uploads (PR 26)

The receipt dropzone in `OnboardingChat`/`NewExpense` posts files to `/receipts/upload-blob`, which uploads them to Vercel Blob (permanent storage). Without this token, uploads fall back to data-URLs (works in dev but breaks in prod — 4MB+ payloads would 413 the Vercel function).

**How to set:**

1. **Provision Vercel Blob** (if not already):
   ```bash
   vercel blob store add agentbook-receipts
   ```
   Or in dashboard: https://vercel.com/qianghans-projects/a3p-plugin-build/stores → "Create Store" → "Blob" → name it `agentbook-receipts`.

2. **Connect the store to the project** (dashboard does this automatically when you create from inside the project).

3. **Confirm the env var landed:**
   ```bash
   vercel env ls production | grep BLOB_READ_WRITE_TOKEN
   ```
   When Vercel provisions a Blob store linked to the project, this variable is set automatically across all environments.

4. **Redeploy** so the new env var is picked up:
   ```bash
   vercel --prod
   ```

**Why I couldn't do this:** provisioning a Blob store creates a billable resource (free tier is generous, but provisioning needs explicit consent). The dashboard / CLI prompt for store-name + region; I shouldn't make those decisions for you.

### 2. `SENTRY_DSN` — error tracking (PR 23, optional)

The structured logger (`apps/web-next/src/lib/logger.ts`) routes calls to `reportError(...)` to Sentry when both `SENTRY_DSN` is set AND `@sentry/nextjs` is installed. If you don't want Sentry, skip this entirely — `reportError` falls through to a structured log line and that's fine.

**How to set:**

1. **Sign up for Sentry** at https://sentry.io (free tier: 5K errors/month).
2. **Create a project** named `agentbook` (Platform: Next.js).
3. **Copy the DSN** from Sentry → Settings → Projects → agentbook → Client Keys (DSN).
4. **Install the SDK and set the env var:**
   ```bash
   cd apps/web-next && npm install --save @sentry/nextjs
   # Or for the whole repo:
   # npm install --save @sentry/nextjs --workspace apps/web-next

   # Set DSN on Vercel (PROD)
   echo -n "https://<your-dsn>@sentry.io/<project-id>" | vercel env add SENTRY_DSN production
   # And preview
   vercel env add SENTRY_DSN preview "" --value="https://..." --yes
   ```
5. **(Optional) Sentry's Next.js helpers** require `sentry.client.config.ts`, `sentry.server.config.ts`, and `sentry.edge.config.ts`. The logger doesn't need them — `captureException` works without `init()` — but you get better source-map mapping and Sentry's release tracking if you set them up. Follow https://docs.sentry.io/platforms/javascript/guides/nextjs/.

**Why I couldn't do this:** Sentry account creation requires a real email + acceptance of their terms. The DSN is unique per account/project.

---

## Other env vars that exist already (not touched by this work)

These were set 19+ days ago and shouldn't need changes:

| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Cron / service-to-service auth (already configured) |
| `GEMINI_API_KEY` | Gemini LLM API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot HTTP API token |
| `DATABASE_URL` + `DATABASE_URL_UNPOOLED` | Neon Postgres connection |
| `AGENTBOOK_*_URL` (4 vars) | Plugin server URLs |
| `E2E_RESET_TOKEN` | E2E test reset endpoint auth |
| `a3p_POSTGRES_*` (many) | Neon connection metadata (auto-provisioned) |

Worth a sanity check before next deploy:
```bash
vercel env ls production | grep -E "DATABASE_URL|GEMINI|TELEGRAM|CRON_SECRET"
```

---

## Plaid env vars (for `bank-sync`)

The bank-sync code reads:
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV` (sandbox / production)

These should NOT be set to sandbox values in production. **USER ACTION** when going live:

1. Sign up for Plaid production access at https://dashboard.plaid.com (requires app review).
2. Once approved, get production keys.
3. Set:
   ```bash
   echo -n "<plaid_client_id>"  | vercel env add PLAID_CLIENT_ID production
   echo -n "<plaid_secret>"     | vercel env add PLAID_SECRET     production
   echo -n "production"         | vercel env add PLAID_ENV        production
   ```

Until Plaid prod is approved, `/bank-sync` runs in sandbox mode (per CLAUDE.md credentials).

---

## Basiq env vars (for AU bank-sync) — ⚠️ USER ACTION REQUIRED

The AU bank-sync code (`apps/web-next/src/lib/agentbook-basiq.ts` and the `bank/basiq/*` routes under both `agentbook-expense` and `agentbook-personal`) reads:
- `BASIQ_API_KEY` — ⚠️ **USER ACTION REQUIRED**
- `BASIQ_ENV` (`sandbox` / `production`, informational only — Basiq uses key-scoping rather than a separate host to distinguish sandbox vs. production, so the base URL `au-api.basiq.io` is the same either way)

**Why this needs you:** Basiq is a third-party, CDR-accredited Australian data provider. Getting an API key requires signing up for a real Basiq developer/business account at their dashboard — this is an account-creation + business-verification step only the account owner can complete, not something that can be provisioned programmatically.

**How to set, once you have a key:**

1. Sign up at the Basiq developer dashboard and create an application to get a sandbox (and later production) API key.
2. Set it on Vercel:
   ```bash
   echo -n "<basiq_api_key>" | vercel env add BASIQ_API_KEY production
   echo -n "sandbox"         | vercel env add BASIQ_ENV production
   # Preview, with a separate sandbox key if you want isolation:
   vercel env add BASIQ_API_KEY preview "" --value="<basiq_api_key>" --yes
   vercel env add BASIQ_ENV     preview "" --value="sandbox"         --yes
   ```
3. Redeploy so the routes pick it up: `vercel --prod`.

**Until this is set:** AU tenants' Basiq routes (`bank/basiq/consent-url`, `callback`, `status`, `sync`, `disconnect`, and their `agentbook-personal` counterparts) will throw `[basiq] BASIQ_API_KEY not set` — same failure mode as a missing `PLAID_SECRET` today. This does not affect US/CA tenants (Plaid-only) or any other AU feature.

Once a real key is available, the manual verification checklist in `docs/superpowers/plans/2026-07-19-au1-basiq-bank-sync.md` (Task 7, Step 5) should be run once against a real Basiq sandbox connection before considering AU-1 fully done.

---

## Stripe env vars (for billing webhook + checkout)

The Stripe webhook handler (`apps/web-next/src/app/api/v1/agentbook/stripe-webhook/`) reads:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PUBLISHABLE_KEY` (frontend)

**USER ACTION** when launching billing:

1. Sign up at https://dashboard.stripe.com, switch to test mode for first launch.
2. Get API keys from Developers → API keys.
3. Set up webhook in Developers → Webhooks → Add endpoint:
   - URL: `https://agentbook.brainliber.com/api/v1/agentbook/stripe-webhook`
   - Events to listen for: `customer.subscription.*`, `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`
   - Copy the signing secret (starts with `whsec_`).
4. Set on Vercel:
   ```bash
   echo -n "sk_live_..."    | vercel env add STRIPE_SECRET_KEY    production
   echo -n "whsec_..."      | vercel env add STRIPE_WEBHOOK_SECRET production
   echo -n "pk_live_..."    | vercel env add STRIPE_PUBLISHABLE_KEY production
   ```

Detailed setup steps with test cards are in `agentbook/setup-stripe-plaid-sandbox.md`.

---

## Rotate a secret

If any of the secrets I generated needs to be rotated (e.g., after a security incident, or if you want to refresh):

```bash
# Remove the old value
vercel env rm INVOICE_PUBLIC_LINK_SECRET production --yes

# Add a fresh one
echo "$(openssl rand -base64 32)" | vercel env add INVOICE_PUBLIC_LINK_SECRET production

# Same for preview if needed
vercel env rm INVOICE_PUBLIC_LINK_SECRET preview --yes
vercel env add INVOICE_PUBLIC_LINK_SECRET preview "" --value="$(openssl rand -base64 32)" --yes

# Redeploy to pick up the new value
vercel --prod
```

Effect of rotation:
- `INVOICE_PUBLIC_LINK_SECRET` — all previously-issued signed invoice links stop working. Acceptable; clients re-receive fresh links on next send.
- `INTERNAL_ADMIN_SECRET` — Next.js proxy and plugin servers must restart at the same time, or admin routes 401 briefly.
- `BANK_TOKEN_ENCRYPTION_KEY` — **DANGEROUS.** All existing encrypted Plaid tokens in `AbBankAccount.accessTokenEnc` become undecryptable. Users would need to re-link their banks. Only rotate this if the key is known to be compromised, and follow the migration playbook: dual-key decrypt → re-encrypt with new key → drop old.
- `ADMIN_EMAILS` — just changes which emails get admin rights. Safe.
- `LOG_LEVEL` — verbosity change only.

---

## Local dev (`.env.local`)

For local development, copy `apps/web-next/.env.local.example` to `apps/web-next/.env.local`. The new variables don't need values locally because every helper has a dev fallback:

- `INVOICE_PUBLIC_LINK_SECRET` — defaults to `'dev-only-rotate-in-prod'` when unset + NODE_ENV ≠ production AND VERCEL_ENV unset
- `BANK_TOKEN_ENCRYPTION_KEY` — defaults to all-zero hex (same conditions)
- `INTERNAL_ADMIN_SECRET` — plugin routes open in dev when unset
- `ADMIN_EMAILS` — admin routes accept anyone in dev when unset (test-friendly)
- `LOG_LEVEL` — defaults to `info`

All five fail closed in production / preview / staging if not set. The dev defaults are intentional and documented in the helper modules.

---

## Quick verification script

After any env change, deploy and run:

```bash
# Sanity-check that the merged PRs work end-to-end
TOKEN=$(curl -s -X POST https://agentbook.brainliber.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"maya@agentbook.test","password":"agentbook123"}' | jq -r .token)

# Each of these should return 200 with valid data, not 401 / 403 / 500:
curl -s "https://agentbook.brainliber.com/api/v1/agentbook-core/agent/skills/metrics?days=1" \
  -H "Authorization: Bearer $TOKEN" | jq .

curl -s "https://agentbook.brainliber.com/api/v1/agentbook-core/events/since?ts=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $TOKEN" | jq .

curl -s "https://agentbook.brainliber.com/api/v1/agentbook-core/admin/llm-configs" \
  -H "Authorization: Bearer $TOKEN" | jq .   # Should be 403 (admin required) unless logged in as ADMIN_EMAILS
```

---

## Summary

- **Done by me (10 sets):** 5 vars × 2 envs (prod + preview)
- **Needs you:** `BLOB_READ_WRITE_TOKEN` (provision Vercel Blob store), `BASIQ_API_KEY`/`BASIQ_ENV` (sign up with Basiq for AU bank-sync — see "Basiq env vars" above), and optionally `SENTRY_DSN`
- **Pre-existing, don't touch:** `CRON_SECRET`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL*`, `AGENTBOOK_*_URL`
- **For future launches:** Plaid prod keys (`PLAID_*`) and Stripe prod keys (`STRIPE_*`) — when you flip those products from sandbox to live
